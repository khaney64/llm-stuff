# macOS Host Setup — LLM Proxy + llama-swap

Deployment runbook for running the inference stack on an Apple Silicon Mac,
alongside the existing Windows (`devbox`) and Ubuntu (`llmserver`) hosts.
Written from the `mac-m1` bring-up (M1 Mac mini, 8GB, macOS 26.3.1); the same
steps apply to the M5 Ultra with larger contexts and real models.

Companion doc: `ubuntu-setup.md`. Architecture and routing: `llama-swap/ARCHITECTURE.md`.

## Portability summary

`proxy.js`, `influxdb-client.js`, and `proxy-models.json` run unmodified. Three
things are genuinely macOS-specific and are all new files rather than edits:

| Concern | Linux/Windows | macOS |
| --- | --- | --- |
| Power sampling | `power-nvidia-smi.js` | `power-macos.js` (via `macmon`) |
| Model catalog | `$HOME/llama/server.sh`, `server.ps1` | `llama-swap/macos/server.sh` |
| Service manager | systemd user units, Task Scheduler | launchd user agents |

`proxy.sh` is now shared by Linux and macOS: it selects a host profile
(power provider, idle baseline, context fallback) and is otherwise identical
across hosts. See **Host profiles** below.

## Prerequisites

1. **Xcode Command Line Tools** (compiler, Metal, Accelerate):
   ```bash
   xcode-select --install
   ```

2. **Homebrew packages**:
   ```bash
   brew install cmake node macmon jq
   ```
   `macmon` reads GPU wattage from the SMC via a private IOKit API and needs no
   `sudo` — unlike `powermetrics`, which requires root on every invocation and
   is therefore unusable from an unattended service.

   Verify with the exact call `power-macos.js` makes:
   ```bash
   macmon pipe -s 1 | jq .gpu_power
   ```
   Must return a number.

3. **Distinct hostname** so the InfluxDB `host` tag does not collide with the
   other nodes, and so `proxy.sh` resolves the right profile from
   `hostname -s`. macOS keeps three separate names; only `HostName` is the one
   `os.hostname()` reads:

   ```bash
   sudo scutil --set HostName      mac-m1   # what os.hostname() / hostname -s return
   sudo scutil --set LocalHostName mac-m1   # Bonjour/mDNS, i.e. mac-m1.local
   # ComputerName is the Finder/AirDrop display name; leave it alone unless
   # you want the machine renamed in the UI too.
   ```

   No reboot or proxy restart is needed. The InfluxDB `host` tag is built
   per-request (`os.hostname()` inside the tag builder in `proxy.js`), so a
   running proxy picks up the new name on its next request.

   The `.lan` suffix seen in DNS comes from the router's DHCP, not from either
   setting, so `mac-m1.lan` resolves only after a DHCP lease renewal. The LAN
   IP works regardless.

## Build llama.cpp with Metal

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama/llama.cpp
cd ~/llama/llama.cpp
cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DGGML_ACCELERATE=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON
cmake --build build --config Release -j $(sysctl -n hw.ncpu)
```

Confirm the configure step reports `Metal framework found` / `Including METAL
backend` and `Found BLAS: ...Accelerate.framework`. `GGML_METAL_EMBED_LIBRARY`
compiles the Metal shaders into the binary, so `llama-server` does not need to
find `ggml-metal.metal` relative to its working directory — which matters
because launchd starts it from a directory of its own choosing.

Binaries land in `~/llama/llama.cpp/build/bin/`. Verified build: **b10686**
(commit `3173a5647`), AppleClang 17, Darwin arm64.

## Models

Place GGUFs in `~/llama/models/` and describe them in
`llama-swap/macos/server.sh`, which is the macOS equivalent of llmserver's
host-local `$HOME/llama/server.sh`. Unlike that file, this one is committed —
the M5 Ultra should start from a known-good catalog, and it holds no secrets.

```bash
./llama-swap/macos/server.sh --list
./llama-swap/macos/server.sh --model qwen25-coder-1.5b --dry-run   # print the llama-server command
```

Two Apple Silicon specifics are baked into the entries:

- `-ngl 999` offloads all layers to Metal. On unified memory this is not a
  copy, but it does count against `iogpu.wired_limit_mb`.
- Embedding models are non-causal, so llama.cpp requires the physical batch to
  cover the whole context: `-ub` must equal `-c`. `nomic-embed` uses
  `--pooling mean`, which is what nomic-embed-text-v1.5 was trained with.
- mmap is left **on**. `--no-mmap` is deprecated in current builds, and
  file-backed weights are evictable rather than swappable — the better failure
  mode on a machine this size.

### Context sizing

The KV cache is the variable cost, and on this model it is cheap — Qwen2.5 uses
GQA with only 2 KV heads:

```
2 (K+V) x 28 layers x 2 kv_heads x 128 head_dim x 2 bytes (f16) = 28 KB/token
```

So the model's full native 32768 context costs ~940MB of KV on top of 1.1GB of
weights. Measured on this 8GB M1, loading at each size and driving a
14,146-token prompt:

| `-c` | RSS | system free | pp tok/s | tg tok/s |
| ---: | ---: | ---: | ---: | ---: |
| 8192 | 1.38GB | 55% | — prompt rejected, too small | |
| 16384 | 1.63GB | 52% | 272 | 30 |
| 32768 | 2.04GB | 46% | 281 | 30 |

**32768 is both affordable and the ceiling.** Affordable because the jump from
16K costs ~400MB and caused no swapping; the ceiling because
`qwen2.context_length` in the GGUF is 32768 and going past it needs YaRN rope
scaling, which is not worth it on a 1.5B.

What *does* degrade is throughput as the prompt gets deeper — measured at a
fixed `-c 32768` so allocation is constant:

| prompt depth | pp tok/s | tg tok/s |
| ---: | ---: | ---: |
| 14,146 | 242 | 26 |
| 18,846 | 149 | 22 |
| 23,546 | 86 | 11 |

This is not a misconfiguration and not swap — those runs grew swap by 0MB.
Attention is quadratic in prompt length, and every generated token must read
the whole KV cache, so at 23.5K tokens that is ~675MB read per token against
the M1's ~68GB/s of memory bandwidth. It is bandwidth-bound, and it is exactly
the kind of number that says nothing about the M5 Ultra.

Practical read: 32K is the right setting, and prompts up to ~15K feel fine.
Beyond ~20K it stays correct but gets slow.

`--cache-reuse 256` matters a lot here — a repeated long prompt hit 100% prefix
cache reuse and returned in 1.0s instead of ~60s.

KV quantization (`--cache-type-k q8_0 --cache-type-v q8_0`) halves cache memory
but measured *worse*: generation dropped from 35 to 18 tok/s for ~350MB saved.
Not worth it while f16 fits.

### Memory ceiling

```bash
sysctl iogpu.wired_limit_mb    # 0 = system default, ~75% of RAM
```

Leave it at `0` on an 8GB machine — the default ~6.1GB ceiling is already
aggressive against the ~2-2.5GB of real headroom at idle. Raising it is a
tuning exercise for a machine with memory to give.

## Install llama-swap and the launchd agents

```bash
./llama-swap/macos/install.sh          # downloads the pinned release
./llama-swap/macos/install.sh /path/to/llama-swap_243_darwin_arm64.tar.gz
```

The installer pins llama-swap **v243** (the version devbox and llmserver run),
verifies its SHA-256 against the checksum published in the release, strips the
Gatekeeper quarantine attribute (otherwise the first exec is blocked as an
unverified developer), and writes both agents into `~/Library/LaunchAgents`
with `__HOME__` substituted — launchd expands neither `~` nor `$HOME` inside
plist values.

## InfluxDB credentials

**The credentials are not in the plists.** `proxy.sh` sources
`influxdb-env.sh` from the repo directory itself, so the secret stays in one
gitignored file rather than being copied into `~/Library/LaunchAgents`, which
is world-readable by default and not covered by `.gitignore`.

```bash
cat > ~/llm-stuff/influxdb-env.sh <<'ENV'
export INFLUXDB_URL=http://<influx-host>:8086
export INFLUXDB_ORG=<org>
export INFLUXDB_BUCKET=<bucket>
export INFLUXDB_TOKEN=<token>
ENV
chmod 600 ~/llm-stuff/influxdb-env.sh
```

> **Use LF line endings.** A file copied from the Windows box arrives with
> CRLF, which leaves a trailing `\r` on every value. Node then rejects the
> token with `Invalid character in header content ["Authorization"]` and every
> InfluxDB write fails silently while the file looks perfectly correct.
> `proxy.sh` now strips `\r` from the four `INFLUXDB_*` variables defensively,
> but `file influxdb-env.sh` should still say `ASCII text`, not
> `ASCII text, with CRLF line terminators`.

The plists do set `PATH` to include `/opt/homebrew/bin`, because launchd gives
jobs a bare `/usr/bin:/bin:/usr/sbin:/sbin` and both `node` and `macmon` live
under Homebrew. `power-macos.js` resolves `macmon` by bare name.

## Host profiles in proxy.sh

`proxy.sh` takes an optional profile argument and otherwise detects one:

```
1. $1                    ./proxy.sh mac-m1
2. $PROXY_HOST_PROFILE   to pin it from a service definition
3. hostname -s           the normal path
4. uname -s              unknown host: OS-appropriate defaults, with a warning
```

| Profile | Power provider | `--gpu-idle` | `--default-ctx` |
| --- | --- | ---: | ---: |
| `llmserver`, `llm-ubuntu` | `power-nvidia-smi.js` | 11 | 65535 |
| `devbox` | `power-nvidia-smi.js` | 15 | 65535 |
| `mac-m1` | `power-macos.js` | 0 | 32768 |

The `uname` fallback means a newly imaged Mac serves correctly before anyone
adds its hostname to the case block.

## Power reporting

`power-macos.js` reports **GPU watts only**, matching what `nvidia-smi` reports
on the discrete-GPU boxes, so the `$`-per-request column stays comparable
across hosts.

Measured on this M1 with the 1.5B model: GPU idle **0.002W**, inference average
**2.5W**, peak **8.9W**. Because idle is effectively zero, `--gpu-idle 0` is
correct here — there is no meaningful baseline to subtract, unlike the 11-15W
the 4070/3090 draw at rest.

This deliberately undercounts total energy: Apple Silicon does real
inference-adjacent work on the CPU (`cpu_power` was ~1.9W at idle against
`sys_power` ~11W). Whole-system power is captured separately. If cost accuracy
ever matters more than cross-host comparability, switch fields without editing
code:

```bash
MACMON_POWER_FIELD=sys           # whole package
MACMON_POWER_FIELD=cpu+gpu+ane   # compute only
```

Other overrides: `MACMON_INTERVAL_MS` (default 250), `MACMON_STALE_MS`
(default 3000).

> **Implementation note.** `macmon pipe -s 1` takes ~1.3s to return a single
> sample, far slower than the proxy's 250ms poll. `power-macos.js` therefore
> keeps one long-lived `macmon pipe -s 0 -i N` child streaming NDJSON and has
> `sample()` return the most recent reading, so the proxy's poll is a memory
> read. A reading older than `MACMON_STALE_MS` is discarded rather than
> reported stale.

## Operations

```bash
./llama-swap/macos/manage.sh start
./llama-swap/macos/manage.sh stop
./llama-swap/macos/manage.sh restart
./llama-swap/macos/manage.sh restart-proxy   # proxy.js/proxy.sh/models/env changed
./llama-swap/macos/manage.sh restart-swap    # mac-m1.yaml or macos/server.sh changed
./llama-swap/macos/manage.sh status
./llama-swap/macos/manage.sh logs
```

Both agents use `KeepAlive { SuccessfulExit = false }` and
`ThrottleInterval = 5`, mirroring systemd's `Restart=on-failure` /
`RestartSec=5`.

### Start at boot

LaunchAgents run inside a user session, so a headless Mac needs **automatic
login** enabled (System Settings → Users & Groups → Automatic login). This is
the macOS analogue of `loginctl enable-linger` on llmserver. Converting the
agents to system-wide LaunchDaemons would remove that requirement but runs
them as root outside a GUI session; not needed here.

### Startup ordering

launchd has no `Requires=`/`After=`. llama-swap health-checks its models
through the proxy (`checkEndpoint: /health` against `127.0.0.1:8081`), so
starting it first makes every model load fail until the proxy happens to come
up. `llama-swap/macos/start-swap.sh` waits for port 8081 before exec'ing
llama-swap — the same job `start-swap.ps1` does on Windows.

### Logs

Both agents write to `llama-swap/logs/` (gitignored), matching the Windows
layout:

```bash
tail -F llama-swap/logs/proxy.log
tail -F llama-swap/logs/llama-swap.log
```

launchd does not rotate these. Unlike the Windows host, where
`rotating-log.ps1` bounds them, and llmserver, where journald handles it, size
is currently unbounded — add a `/etc/newsyslog.d/` entry if this box ever runs
long enough to matter.

llama.cpp's own stdout stays in llama-swap's in-memory log monitor
(`logToStdout` defaults to `proxy`):

- UI: `http://mac-m1:8080/ui/`
- All upstream output: `http://mac-m1:8080/logs/stream/upstream`
- One model: `http://mac-m1:8080/logs/stream/<model-id>`

## Verification

Ports: `8080` llama-swap (LAN), `8081` proxy.js (loopback), `8082` llama.cpp
(loopback) — identical to the other hosts.

```bash
# 1. Everything listening on the right port and scope
./llama-swap/macos/manage.sh status

# 2. Catalog
curl -s localhost:8080/v1/models | jq -r '.data[].id'

# 3. Chat through the full stack
curl -s localhost:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen25-coder-1.5b","messages":[{"role":"user","content":"say OK"}],"max_tokens":10}' \
  | jq -r '.choices[0].message.content'

# 4. Embeddings (forces a model swap)
curl -s localhost:8080/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed","input":"hello"}' | jq '.data[0].embedding | length'

# 5. Proxy detected the backend correctly
grep -E 'Detected|Power:' llama-swap/logs/proxy.log

# 6. Metrics reached InfluxDB
source ./influxdb-env.sh && node explore-influxdb.js | grep -A2 'host'
```

A healthy `[done]` line carries context pressure, cache hit rate, and GPU power:

```
[done] session=chat qwen25-coder-1.5b reason=stop prompt=1 (43.2% of 32768 ctx) OK
gen=38 pp=26.9tok/s tg=36.8tok/s cache=14145reused+1computed(100.0%)
gpu=7.9Wpeak=7.9W (2samples)
```

### Confirmed on this host

- `/props` supplies everything `proxy.js` auto-detects:
  `default_generation_settings.n_ctx` (32768), `build_info` (`b10686-3173a5647`
  → `b10686`), `total_slots` (1). `default_generation_settings.model` is
  `null`, so the model name comes from the `model_path` fallback in
  `fetchServerCtx()` — the fallback chain is load-bearing here, not decorative.
- `/slots` returns an array, as `fetchServerSlots()` expects.
- `usage.prompt_tokens_details.cached_tokens` and `timings.*` are present, so
  cache-hit tracking and tok/s reporting work unchanged.
- Swapping between the chat and embedding models in both directions is
  reliable, takes ~1.5s, and genuinely frees memory: wired dropped
  2.77GB → 1.98GB and system-wide free went 33% → 46% on unload.
- Killing `proxy.js` with `SIGKILL` brings it back within ~5s via `KeepAlive`,
  and llama-swap keeps serving.
- llama-swap answers on the LAN IP on 8080; proxy.js and llama.cpp stay on
  loopback. The macOS application firewall was **disabled** on this host
  (`socketfilterfw --getglobalstate`), so the bind was never prompted. If it is
  enabled, expect a one-time "allow incoming connections" prompt for the
  `llama-swap` binary — an unattended box should be pre-approved with
  `socketfilterfw --add ~/llama-swap/llama-swap --unblockapp ...` rather than
  waiting on a GUI dialog that nobody is there to click.

## Troubleshooting

- **`macmon: command not found` in the service, but fine in a terminal** —
  launchd's bare `PATH`. Confirm the plist's `EnvironmentVariables/PATH`
  includes `/opt/homebrew/bin`:
  `launchctl print gui/$(id -u)/com.khaney.llama-proxy | grep -A3 environment`
- **`Invalid character in header content ["Authorization"]`** — CRLF in
  `influxdb-env.sh`. See the InfluxDB section above.
- **`"llama-swap" cannot be opened because the developer cannot be verified`** —
  Gatekeeper quarantine. `xattr -d com.apple.quarantine ~/llama-swap/llama-swap`
  (`install.sh` does this).
- **Model load fails with a wired-memory error** — the model plus its KV cache
  exceeds the `iogpu.wired_limit_mb` ceiling. Lower `-c` in
  `llama-swap/macos/server.sh` first; only raise the ceiling on a machine with
  headroom.
- **Embedding model fails to start** — `-ub` must equal `-c` for non-causal
  models. llama.cpp rejects the config outright rather than degrading.
- **Port collision** — `lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:8082 -sTCP:LISTEN`.
- **Agent won't start** — `launchctl print gui/$(id -u)/com.khaney.llama-proxy`
  shows `state`, `last exit code`, and the resolved path. A nonzero exit with
  no log output usually means the plist path is wrong (stale `__HOME__`);
  re-run `install.sh`.
- **Swaps stopped working after editing YAML** — llama-swap reads its config
  only at start: `./llama-swap/macos/manage.sh restart-swap`.
- **`[ERROR] failed to preload model <id>: status 415` in llama-swap.log** —
  benign on this host. llama-swap verifies a preload with `GET /`, which
  llama.cpp answers with 415 because this build has no bundled web UI (the
  Linux/Windows builds serve their UI there and return 200). The preload
  itself succeeds: after startup `/running` reports the model `ready` and
  `llama-server` is up with no request having been sent.
- **One agent silently stays down after `restart`** — this was a bug in
  `manage.sh`, fixed: `launchctl bootout` returns before launchd has finished
  tearing the job down, and bootstrapping into that window fails without a
  useful error. `boot_out` now waits for the job to actually disappear and
  `restart` verifies both agents came back, exiting nonzero if not. If you see
  it again, `manage.sh status` distinguishes "not loaded" from a crash loop.
- **`Bootstrap failed: 125: Domain does not support specified action`, or
  `status` reports both agents "not loaded" over SSH** — nobody is logged in at
  the desktop. `gui/<uid>` is the Aqua session domain and does not exist while
  the Mac sits at the login window, so every `bootstrap` fails and the stack
  stays down. Confirm with `stat -f '%Su' /dev/console` — `root` means the
  login window, your username means a session is live. Log in at the console or
  via Screen Sharing, or enable automatic login (see **Start at boot**).
  `manage.sh` now detects this and says so rather than retrying into a wall.
