# Headless LaunchDaemon trial (mac-m1)

## Result: PASS (2026-09-02)

**Metal works from a pre-login LaunchDaemon.** Ran on mac-m1; the M5 Ultra can
be headless with no automatic login.

> **Correction (2026-09-03):** this document originally also concluded that
> FileVault and unattended restart coexist. **That was wrong.** The reboot was
> not unattended — with FileVault on, `/System/Volumes/Data` comes up locked
> and a password had to be supplied over SSH before any daemon could start.
> What the trial genuinely establishes is narrower and still the thing it was
> written to answer: **daemons run without a desktop login, and Metal works
> from them at full speed.** The FileVault unlock is a separate, earlier gate.
> See `macos-setup.md` → *FileVault gates every reboot*.

Test validity — nobody was logged in *at the desktop*: `/dev/console` owned by `root`, `who`
empty, `0 users`. Both daemons came up in the `system` domain as `khaney`
(pids 564 / 563), llama-swap preloaded the model, all three ports listened,
`/health` OK. The agents stayed unloaded, as intended.

| Metric | Baseline (logged in, agents) | Daemon, pre-login, box idle | Δ |
| --- | ---: | ---: | ---: |
| **tg tok/s** | 53.7 | **53.1** (53.3 / 52.8 / 53.2) | −1.1% |
| **gpu avg / peak** | 7.7W / 8.6W | **7.4W / 8.6W** | −0.3W |

**There is no daemon penalty.** GPU power stayed in the same band rather than
collapsing toward the ~0.002W idle floor, and throughput matches the logged-in
baseline to within run-to-run noise.

The first daemon measurements looked 6.5% slower (tg 50.2 / 50.6 / 50.5) and
reproduced, so they were not single-run noise — but they were all taken minutes
after boot while Spotlight reindexed: load average climbing 8.3 → 12.6, three
`mdworker_shared` at 71/59/58% CPU, `system_profiler` at 49%. Re-measured once
load fell below 2.0 (~20 minutes later, still pre-login, `console=root`,
`0 users`), the gap disappeared. **Never benchmark a Mac in the first ~20
minutes after a boot.**

That re-run also re-confirms which metrics to trust: across the three idle
runs `pp` swung 188 → 387 → 387 tok/s purely on prefix-cache hits, while `tg`
held at 52.8–53.3 throughout.

Remaining follow-ups are in **If it works** below.

## The question

**Does Metal GPU acceleration still work when `llama-server` is started by a
LaunchDaemon at boot, with nobody logged in at the desktop?**

Everything else about the daemon route is known to work. This one thing is not,
and it decides how the M5 Ultra gets deployed. Run it on mac-m1 — that box
exists to answer questions like this before the real hardware lands.

## Why it matters

LaunchAgents live in the Aqua session, so today a reboot leaves the stack down
until someone logs in (see `macos-setup.md` → **Start at boot**). The two ways
out are automatic login and LaunchDaemons, and they trade off differently:

| Setup | Unattended after power loss | Encrypted at rest | Desktop session always live |
| --- | :---: | :---: | :---: |
| Agents + auto-login, FileVault **off** | yes | no | **yes** |
| Daemons, FileVault **off** | yes | no | no |
| Daemons, FileVault **on** | **no** — pre-boot unlock | yes | no |
| Agents, FileVault on | no | yes | — |

Two things worth being precise about, because they are easy to get backwards:

- **FileVault does not require a desktop login — it requires a pre-boot
  unlock.** Once the volume is unlocked the system boots and daemons start with
  no login. So daemons + FileVault still means a human at the console after
  every unexpected reboot. `sudo fdesetup authrestart` unlocks for exactly one
  subsequent boot, which covers planned reboots but not power loss.
- **Daemons are not a way to keep FileVault and stay unattended.** Their real
  win over auto-login is that no logged-in desktop sits exposed for anyone with
  physical or Screen Sharing access.

If Metal works from a daemon, the M5 can run headless with no desktop session
at all. If it does not, auto-login is the answer and the daemon files here can
be deleted.

## Pre-flight

- SSH access to mac-m1 that does not depend on a desktop session (it does not).
- Physical or Screen Sharing access as a fallback, in case the daemons fail and
  you need to put the agents back.
- Know the current state: `llama-swap/macos/manage.sh status`.

## Step 0 — capture the logged-in baseline (do not skip)

The trial is a comparison. Without a baseline taken **the same way** on the
same box, a "slow" result afterwards proves nothing.

While logged in at the desktop, with the agents running:

```bash
cd ~/llm-stuff

# Unique prompt: --cache-reuse 256 means a repeated prompt returns from prefix
# cache and reports a meaningless prompt-processing rate.
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"qwen25-coder-1.5b\",\"stream\":true,\"max_tokens\":200,
       \"messages\":[{\"role\":\"user\",\"content\":\"[trial $(date +%s)] Write a bash function that retries a command with exponential backoff, and explain each line.\"}]}" \
  > /dev/null

# The numbers that matter: pp tok/s, tg tok/s, and gpu watts.
grep -a '\[done\]' llama-swap/logs/proxy.log | tail -1
```

### Where the Metal evidence is, and is not

Do not try to grep llama.cpp's backend init out of the logs. On build
`b10686`, `http://127.0.0.1:8080/logs/stream/upstream` replays llama-swap's
buffer from process start — including `load_model`, `n_ctx_slot`, and the
per-request `print_timing` lines — but contains **no** `ggml_metal_init`,
`offloaded ... layers to GPU`, or any `metal`/`gpu`/`backend` string at all
(verified: 0 matches across the whole buffer). `llama-server`'s `/props`
carries `build_info`, `n_ctx` and `total_slots`, but no device or backend
field either.

So the verdict rests on two signals the proxy already records in every
`[done]` line, which is a better test anyway — it measures the GPU actually
doing work rather than a string claiming it will:

- **`tg` tok/s** — generation throughput.
- **`gpu=` watts** — Apple GPU power sampled by `macmon` during the request.
  Idle on this M1 is ~0.002W, so a CPU fallback collapses this by orders of
  magnitude.

### Take the baseline cold

After the reboot in Step 2, `llama-server` is a fresh process with an empty KV
cache. Match that here or the comparison is not like-for-like:

```bash
llama-swap/macos/manage.sh restart-swap     # fresh llama.cpp child, empty KV
until [ "$(curl -s --max-time 3 http://127.0.0.1:8080/health)" = OK ]; do sleep 1; done
```

Confirm the `[done]` line reports `cache=0reused` before trusting it.

### Baseline, measured 2026-09-02 (logged in via VNC, LaunchAgents, Metal)

```
[done] session=chat qwen25-coder-1.5b reason=length prompt=61 (0.2% of 32768 ctx) OK
gen=200 pp=486.3tok/s(125ms) tg=53.7tok/s(3.70s) total=3.83s
cache=0reused+61computed(0.0%) elapsed=3.85s
gpu=7.7W peak=8.6W 0.0081Wh $0.000002 (17samples)
```

| Metric | **Cold** (use this) | Warm, for contrast |
| --- | ---: | ---: |
| KV cache | `0reused+61computed` | `34reused+27computed` |
| tg tok/s | **53.7** | 53.9 |
| gpu watts avg / peak | **7.7W / 8.6W** | 7.4W / 8.6W |
| pp tok/s | 486.3 | 99.8 |

Both runs are on this box minutes apart, and the contrast is the reason the
verdict rests on `tg` and watts:

- `tg` moved 0.4% and watts moved 0.3W between cache states — they measure the
  GPU doing work and are indifferent to what is cached.
- `pp` moved **5x** in the *opposite* direction to intuition. The warm run
  looked slower because only 27 tokens were charged against a fixed ~271ms of
  overhead. Do not compare `pp` across runs unless the prompt is large enough
  to dominate that overhead — the 14K-token figures in `macos-setup.md` →
  Context sizing (~281 pp tok/s, ~30 tg tok/s) are the reference for that
  shape.

## Step 1 — install the daemons and stand the agents down

```bash
cd ~/llm-stuff && git pull

# Stop the agents and keep them from coming back at the next login. Without
# this, logging in later starts a second copy that fights for 8080/8081/8082.
llama-swap/macos/manage.sh stop
launchctl disable "gui/$(id -u)/com.khaney.llama-proxy"
launchctl disable "gui/$(id -u)/com.khaney.llama-swap"

sudo llama-swap/macos/daemons/install-daemons.sh
```

The installer substitutes your home and username, installs to
`/Library/LaunchDaemons` as `root:wheel` 644, lints each plist, and
deliberately does **not** load them.

## Step 2 — reboot, and do not log in

```bash
sudo shutdown -r now
```

Leave the Mac at the login window. If FileVault is on you will have to unlock
at the pre-boot screen — that is expected, and is itself part of the finding.

## Step 3 — verify the stack came up with no session

Over SSH:

```bash
stat -f '%Su' /dev/console          # expect: root  (nobody logged in)

launchctl print system/com.khaney.llama-proxy | grep -E 'state|pid|last exit'
launchctl print system/com.khaney.llama-swap  | grep -E 'state|pid|last exit'

lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:8082 -sTCP:LISTEN
curl -s http://127.0.0.1:8080/health
```

If `/dev/console` shows your username, something logged you in and the test is
invalid — log out and check again.

## Step 4 — the actual question

Run the **exact same** request as Step 0 and compare:

```bash
cd ~/llm-stuff
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"qwen25-coder-1.5b\",\"stream\":true,\"max_tokens\":200,
       \"messages\":[{\"role\":\"user\",\"content\":\"[trial $(date +%s)] Write a bash function that retries a command with exponential backoff, and explain each line.\"}]}" \
  > /dev/null

grep -a '\[done\]' llama-swap/logs/proxy.log | tail -1
```

### Reading the result

| Signal | Metal working | Metal not working |
| --- | --- | --- |
| tg tok/s | ~50+, within ~10% of the 53.9 baseline | far below — a CPU fallback is not a few percent slower |
| gpu watts in `[done]` | same order as 7.4W avg / 8.6W peak | collapsed toward the ~0.002W idle floor |

Both signals should agree. If they disagree — say, throughput holds but watts
read zero — suspect `macmon` rather than Metal: `power-macos.js` shells out to
it, and a daemon context is exactly where a tool that expects a user session
might misbehave. Check by running `macmon pipe -s 1` directly over SSH while a
request is in flight.

## If it works

The M5 Ultra ships headless: daemons, no auto-login, no desktop session. Decide
FileVault separately using the table above, knowing a reboot then needs a
pre-boot unlock.

Follow-ups before that becomes the real setup:

- Point `manage.sh` at `system/` instead of `gui/<uid>`, or teach it to detect
  which domain the stack is installed in.
- `sudo pmset -a sleep 0 disablesleep 1` and `sudo pmset -a autorestart 1` so
  the box neither sleeps nor stays dark after a power failure.
- ~~Log rotation~~ — done. `com.khaney.llama-logrotate` runs
  `llama-swap/macos/rotate-logs.sh` every 5 minutes; `install-daemons.sh`
  installs it alongside the other two. Not `newsyslog`, which cannot work here
  (`macos-setup.md` → Logs).
- Re-tune context and the model set: `mac-m1.yaml` is built for 8GB and says so.
  96GB changes every sizing decision in it.

## If it does not work

Auto-login is the answer. Roll back:

```bash
sudo llama-swap/macos/daemons/install-daemons.sh --uninstall
launchctl enable "gui/$(id -u)/com.khaney.llama-proxy"
launchctl enable "gui/$(id -u)/com.khaney.llama-swap"
llama-swap/macos/manage.sh start
```

Then enable automatic login (System Settings → Users & Groups), require a
password immediately after screen saver so the exposed desktop is locked, and
apply the same `pmset` settings above.

## Record the outcome

Append the result — pass or fail, with the two `[done]` lines — to
`macos-setup.md` → **Start at boot**. The M5 arrives later and this question
should not have to be asked twice.
