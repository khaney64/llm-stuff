# Multi-model ports plan

Status: **plan only — nothing in this document has been applied.** Written
2026-09-04 to be executed from devbox, which has ssh to llmserver and mac-m1.

Covers three linked changes:

1. Renumber the loopback ports so a proxy leg and its backend are visually paired.
2. Teach `proxy.js` to serve more than one backend from a single process.
3. Let a host keep more than one model resident, which is what forces 1 and 2.

The end state keeps the agent-facing contract unchanged: every caller talks to
llama-swap on `8080` and names a model. Nothing below is LAN-visible.

## Why this is needed

`llama-swap/configs/mac-m1.yaml` already carries a `groups` block that pins
`nomic-embed` (`persistent: true`) alongside a swapping `coder` group. It has
never taken effect: the running llama-swap there started 2026-09-03 13:21, the
edit landed 17:07, and llama-swap only reads its YAML at process start.

That is fortunate, because the config cannot work as written. Every model on
every host launches on the same backend port and points at the same proxy:

```yaml
cmd:   ... --port 8082 --host 127.0.0.1
proxy: http://127.0.0.1:8081
```

`proxy.sh:92-93` starts a single-backend proxy (`--proxy-port 8081
--backend-port 8082`), and `proxy.js:1372` forwards to one module-level
`BACKEND_PORT`. So the moment groups actually keep two models up, the second
`llama-server` fails to bind 8082, `/health` never answers, and llama-swap
blocks until `healthCheckTimeout` (600s) expires.

This has never bitten because devbox and llmserver leave every model ungrouped,
which defaults to `swap: true` + `exclusive: true` — one model at a time, so
reusing 8082 is safe. mac-m1 is the first host to need two at once.

**Trap to know about before touching mac-m1:** running `manage.sh restart-swap`
there today applies the groups block and produces exactly the 600s hang above.
Either finish this plan first or revert the groups block before restarting.

## The port scheme

`8080` stays llama-swap on every host. Below it, the slot number is the last
digit and the `81`/`82` prefix says which tier:

| Tier | Slot 1 | Slot 2 | Slot 3 | Rule |
| --- | --- | --- | --- | --- |
| proxy.js leg | 8181 | 8182 | 8183 | `8180 + N` |
| llama.cpp / MLX backend | 8281 | 8282 | 8283 | `8280 + N` |

So `8181 → 8281`, `8182 → 8282`, and the pairing is readable at a glance in
`lsof`, `ss`, and log lines. The old `8081`/`8082` pair is retired entirely,
which also removes the collision with `proxy.js`'s own built-in llama.cpp
defaults (`8080 → 8081`, `proxy.js:363-366`) that the rollback procedure uses.

**Reserve the pair even when the proxy leg is skipped.** A model that bypasses
`proxy.js` (see *Embeddings*, below) still takes backend port `828N` and leaves
`818N` unused. Adding telemetry later is then a one-line change — point
`proxy:` at `818N` and add a matching `--route` — with no renumbering.

### Slot assignment

A slot belongs to a *concurrently resident* model, not to a model definition.
Everything in a swapping group shares one slot, because only one member is ever
up.

| Host | Slot 1 | Slot 2 | Notes |
| --- | --- | --- | --- |
| devbox | all 12 models | — | all exclusive; renumber only |
| llmserver | 7 chat/vision models | `nomic-embed` | slot 1 members swap among themselves |
| mac-m1 | `coder` group (llama.cpp + MLX) | `nomic-embed` | slot 1 members swap among themselves |

devbox needs no second slot and no functional change at all — its migration is a
pure rename. That makes it the right host to prove the numbering on first.

## proxy.js: `--route`

### Why routes, not model-based dispatch

The obvious design — read `model` from the request body and pick a backend — does
not survive contact with llama-swap. llama-swap health-checks *through* the proxy
(`checkEndpoint: /health`), and `proxy.js:1373` forwards `req.url` blind. A
`/health` request carries no body and no model, so a model-sniffing proxy cannot
tell which backend to check. `/props` and `/slots` polling has the same problem.

Keying on the **inbound listen port** avoids all of it. The socket already
identifies the backend before a single byte of body is read, so `/health`,
`/props`, `/slots` and real traffic all route identically with no special cases.

### CLI

```
--route LISTEN:BACKEND      repeatable; e.g. --route 8181:8281 --route 8182:8282
```

- `--proxy-port` / `--backend-port` stay for the single-backend case and mean
  exactly `--route <proxy>:<backend>`.
- Mixing `--route` with either of the old flags should be a startup error, not a
  silent precedence rule.
- **`--backend llamacpp` becomes mandatory.** The auto-detect heuristic is
  `IS_LLAMACPP = IS_LLAMACPP_ARG || (!BACKEND_ARG && PROXY_PORT === 8080)`
  (`proxy.js:371`). Under the new numbering no listen port is ever 8080, so
  without the explicit flag every host silently falls into Ollama mode. Both
  launchers already pass it (`proxy.sh:99`, `proxy.ps1:25`); do not drop it.

### Per-route state

Four module-level globals become one record per route:

| Global | Line | Becomes |
| --- | --- | --- |
| `serverCtx` | `proxy.js:375` | per-route `/props` `n_ctx` |
| `serverBuildInfo` | `proxy.js:376` | per-route llama.cpp build number |
| `serverModel` | `proxy.js:377` | per-route detected model |
| `serverSlots` | `proxy.js:378` | per-route slot count |

25 references in total. They feed context-pressure maths (`proxy.js:1243`), the
per-model policy lookup (`proxy.js:562`, `1272`) and the InfluxDB `build` tag
(`proxy.js:782`), so each has to read the record for the route that served the
request, not a global.

`pollProps` / `pollSlots` (`proxy.js:1425`, `1444`) currently poll one backend on
a 60s timer; they need to iterate routes. The startup banner (`proxy.js:1495-1499`)
should print one line per route.

Log output should carry the route or its detected model, or two concurrently
streaming backends will interleave `[done]` lines with no way to tell them apart.

### Power attribution caveat

This is a real consequence of co-residency and is worth deciding on explicitly
rather than discovering in Grafana.

`proxy.js` samples GPU wattage during a request and attributes the draw above
`--gpu-idle` to that request. GPU power is a **host-wide** measurement. Once two
models can serve at once, an embedding burst that overlaps a chat generation is
billed to the chat request, and the energy and `$` figures for both are wrong.

Options, in increasing order of effort: accept it and note it on the Grafana
panels; suppress energy fields when more than one backend was active during the
request window; or attribute by active-request count. Cheapest defensible
approach is the middle one — the proxy already knows how many requests are in
flight per route.

## Embeddings do not need a proxy leg

`proxy.js` gates its `[done]` summary and its InfluxDB write behind `isChatUrl()`
(`proxy.js:839-841`), which matches only `chat/completions`, `completions`,
`api/chat`, `api/generate`. `/v1/embeddings` does not match. `grep -n "embed"
proxy.js` returns nothing — the proxy has no embedding awareness at all.

So routing `nomic-embed` through a proxy leg buys **zero telemetry** today. Point
it straight at its backend port and leave the paired proxy port reserved:

```yaml
  nomic-embed:
    cmd: ... --model nomic-embed --port 8282 --host 127.0.0.1
    proxy: http://127.0.0.1:8282
```

This was decided on 2026-09-03 and is unchanged; the agreed shape for
instrumenting embeddings later (own `job_type=embed` label, one point per batch,
`batch_size` field, wall-clock `pp tok/s`, pressure fields suppressed) is
recorded but not scheduled.

`--route` earns its keep when a second **chat** model becomes co-resident.
llmserver's 12GB could hold `qwen3vl-8b` plus a small chat model; mac-m1's 8GB
cannot, so its coder variants stay a swapping group.

## Measured: llmserver co-residency (2026-09-04)

Benchmarked on a spare port with llama-swap stopped, so these are clean numbers.

**Tuning nomic beyond mac-m1's settings buys almost nothing.** All configs were
verified to produce byte-comparable vectors — cosine `1.00000000` against
baseline in every case, so none of this carries re-index risk:

| Config | VRAM | b1 | b5 | b16 | b64 | 40x5 concurrent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A baseline (mac-m1 match) | 492MB | 0.004s | 0.021s | 0.062s | 0.247s | 0.62s |
| B wide ubatch (`-b/-ub 8192`) | 492MB | 0.004s | 0.021s | 0.062s | 0.248s | 0.62s |
| C `--parallel 4` (`-c 8192`) | 864MB | 0.004s | 0.018s | 0.057s | 0.214s | 0.51s |
| D `--parallel 8` (`-c 16384`) | 864MB | 0.004s | 0.018s | 0.064s | 0.246s | 0.61s |
| E baseline + `--flash-attn` | 492MB | 0.004s | 0.020s | 0.061s | 0.248s | 0.62s |

Wide ubatch and flash-attn do nothing. `--parallel 4` is the only real gain —
~13% at batch 64, ~18% under concurrency — for +372MB, which is exactly the
resource co-residency is short of. Nomic is a 137M-parameter model and the
logged median batch is 5 docs (21ms); the bottleneck is per-request overhead,
not compute. **Recommendation: leave the config matching mac-m1.**

Workload shape, from 31,759 logged `/v1/embeddings` requests on mac-m1: median
~5 docs per request, p90 ~15, max 423; median latency there 0.394s.

**Load order decides whether co-residency works at all.** `qwen3vl-8b` runs with
`-fit on` and no explicit `-ngl` (its `M_NGL` is commented out in llmserver's
`server.sh`), so it sizes itself to whatever VRAM is free at load time:

| Order | Total VRAM | qwen3vl generation |
| --- | ---: | ---: |
| qwen3vl alone | 10715MB | 45.9 tok/s |
| nomic (493MB) first, then qwen3vl | 10727MB | 37.3 tok/s |

Loading nomic first works with no context reduction and no config change —
`-fit` gives back ~480MB — but costs **18.8%** of vision generation throughput
(45.9 → 37.3, ±0.1 over 4 runs), because the layers it stops offloading run on
CPU. Embeddings served concurrently in 10.6ms for 2 docs.

Load qwen3vl first and nomic may not fit at all: a freshly started qwen3vl
leaves 1159MB, but the instance running before this test held 11504MB and left
only 361MB, against nomic's 216MB first CUDA buffer — it OOM'd on load. So the
leftover headroom is not stable enough to rely on. `persistent: true` on the
embed group plus preload ordering is what makes this deterministic.

**Not yet measured:** capping qwen3vl's context so both fit with *all* layers on
GPU, trading context for the 18.8% instead. Standalone footprints are
`-c 65535` → 10714MB, `-c 49152` → 10216MB, `-c 32768` → 8896MB, so ~49152 plus
an explicit `-ngl` looks like it would free enough. Worth measuring before
committing to the load-order approach.

## Files to change

### Committed, in this repo

| File | Change |
| --- | --- |
| `proxy.js` | `--route` parsing, per-route state, per-route pollers, route-tagged logs |
| `proxy.test.js:11-12,194-195` | fixtures use 8081/8082; add route-parsing coverage |
| `proxy.sh:92-93` | `--route 8181:8281` (plus `8182:8282` where a second chat backend exists) |
| `proxy.ps1:6,17-18` | same, and the `Stop-ManagedPortOwner` pattern on line 6 |
| `llama-swap/configs/devbox.yaml` | 12 × `-Port 8082` → `8281`, 12 × `proxy:` → `8181` |
| `llama-swap/configs/llmserver.yaml` | 7 chat models → `8281`/`8181`; `nomic-embed` → `8282` direct |
| `llama-swap/configs/mac-m1.yaml` | coder + MLX → `8281`/`8181`; `nomic-embed` → `8282` direct |
| `llama-swap/macos/server.sh:37` | default `port="8082"` → `8281` |
| `llama-swap/macos/server-mlx.sh:38` | default `port="8082"` → `8281` |
| `llama-swap/macos/start-swap.sh:7,25,35,37,44,45` | waits for proxy on 8081 → 8181 |
| `llama-swap/macos/manage.sh:157` | `lsof` port list |
| `llama-swap/macos/daemons/install-daemons.sh:8` | comment naming the port trio |
| `llama-swap/macos/daemons/com.khaney.llama-swap.plist:11` | comment naming port 8081 |
| `llama-swap/linux/manage.sh:17` | `ss` filter `:8080\|:8081\|:8082` |
| `llama-swap/windows/manage.ps1:23-24,40` | stop patterns and the port list |
| `llama-swap/windows/start-swap.ps1:5,11,16` | stop pattern and the proxy wait |
| `llama-swap/ARCHITECTURE.md` | port table, per-host rows, rollback section |
| `CLAUDE.md` | the dual-backend port description |
| `macos-setup.md`, `ubuntu-setup.md` | any port references in the runbooks |

### Host-local, not in this repo

| Host | File | Change |
| --- | --- | --- |
| llmserver | `~/llama/server.sh` | `PORT=8081` default (line 117) is legacy and now actively confusing; set `8281` |
| devbox | `C:\development\ai\llama.cpp\pre-built\server.ps1` | check the `-Port` default for the same problem |
| mac-m1 | — | none; its launcher lives in the repo |

Backups already exist for llmserver's launcher
(`server.sh.pre-llama-swap-20260726`, `server.sh.pre-nomic-20260904`).

## Migration order

Renumbering and multi-route are separable. Do them in that order so each step is
independently verifiable.

1. **proxy.js `--route`** plus tests, still driven by the old ports. Merge and
   confirm nothing changed.
2. **devbox renumber.** Pure rename, one slot, no behaviour change — proves the
   numbering. `manage.ps1 restart`, then `/v1/models` and one completion.
3. **llmserver renumber**, still single-slot. `systemctl --user restart
   llama-proxy.service llama-swap.service`.
4. **llmserver slot 2**: `nomic-embed` on 8282 direct, plus a `groups` block
   pinning it so an embedding request stops evicting `qwen3vl-8b`.
5. **mac-m1 renumber and slot 2** together — it is the host whose groups block is
   already written and already wrong, so it changes once.
6. **Repoint grepai** once the host you want is stable.

Restart llama-swap after any YAML change; it reads config only at start and runs
without `--watch-config`.

## Verification

Per host, after its step:

```bash
# nothing left on the retired ports, one listener per new port
lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:8082 -iTCP:8181 -iTCP:8182 \
        -iTCP:8281 -iTCP:8282 -sTCP:LISTEN

curl -s http://<host>:8080/v1/models          # every model still advertised
curl -s http://<host>:8080/health
```

Then one real completion through 8080 and, on a host with slot 2, an embedding
request while a completion is in flight — that is the case the whole plan exists
to support. Confirm both `[done]` lines appear and name the right model.

For embeddings specifically, cross-host vector agreement is the check that
matters. Measured 2026-09-04 on identical input, llmserver vs mac-m1: cosine
`0.99999973`, max elementwise delta `8.5e-05` — CUDA/Metal rounding only. Any
larger divergence means the two launchers disagree on `--pooling` or context.

## Rollback

Each host is independent, and llama-swap holds no state, so rollback is `git
checkout` of that host's config plus a service restart.

The deeper fallback in `ARCHITECTURE.md` — stop llama-swap, run `proxy.js` on its
native `8080 → 8081` defaults, put the model on 8081 — becomes *more* reliable
under this scheme, because 8081 and 8082 are no longer occupied by the managed
stack.

## Decisions

Taken:

- 8080 stays llama-swap; `818N`/`828N` pairs below it.
- Route on inbound listen port, not on the request's `model` field.
- Reserve both ports of a pair even when the proxy leg is skipped.
- `nomic-embed` bypasses `proxy.js` until embeddings are instrumented.
- Keep llmserver's and mac-m1's nomic launcher args byte-identical.

Open:

- Power attribution when two backends serve concurrently (see above).
- Whether devbox ever needs a second slot, or stays single-slot indefinitely.
- Whether a startup assertion should verify that each model's `cmd` port, its
  `proxy:` URL and the proxy's routes agree. Three places must match by hand
  today, and a mismatch only surfaces as a 600s health-check timeout.
