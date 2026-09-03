# M1 Mac Mini (8GB) — Discovery & Pipeline Validation Plan

> **Status (2026-08-29): sections 1, 2, 3, 5 and 6 are done and verified on the
> hardware.** llama.cpp is built with Metal, both models serve behind
> llama-swap, proxy.js logs to InfluxDB with `macmon` power, and both tiers run
> as launchd agents. The runbook is `macos-setup.md`. Section 4 (MLX) is the
> one remaining item — it was not part of this pass. Per-item results are
> recorded in the checklist below.

## Purpose

This M1 Mini (8GB) is **not** a performance testbed — its numbers are meaningless
as a predictor of M5 Ultra (96GB) throughput. Its job is to de-risk the
**software pipeline** before the M5 Ultra arrives (~10 weeks out), so setup day
is "run script, download weights, benchmark" rather than first-time debugging.

Existing stack this needs to integrate with:
- `proxy.js` (github.com/khaney64/llm-stuff) — Node.js proxy in front of
  llama-server / mlx_lm.server, logs metrics to InfluxDB, has a pluggable
  `--power-provider` module architecture (default: `power-nvidia-smi.js`)
- Currently running on Ubuntu (RTX 4070) and Windows (RTX 3090)
- OpenClaw / Hermes Agent as agentic framework consuming the proxy's
  OpenAI-compatible endpoint
- InfluxDB as the shared metrics backend across all inference nodes

## Environment / access

- Reachable via SSH alias `mac-m1` (e.g. `ssh mac-m1 "ls ~/llama"`)
- `~/llama/llama.cpp` — git clone of the llama.cpp repo (build target for
  the Metal build below)
- `~/llama/models/` — contains the two test models already downloaded:
  - `nomic-embed-text-v1.5.f16.gguf`
  - `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`
- `~/llm-stuff` — git clone of github.com/khaney64/llm-stuff, same repo
  that runs on the Ubuntu/Windows boxes. Notable existing files to reuse
  rather than duplicate:
  - `proxy.js`, `proxy.sh` — proxy.sh is presumably the Linux/macOS launcher
    (vs. `proxy.ps1` for Windows) — check whether it needs any macOS-specific
    path handling before assuming it works as-is
  - `power-nvidia-smi.js` — existing power provider to use as the template/
    contract reference when writing `power-macos.js` (see below)
  - `llama-swap/` — existing subfolder; check what's already configured here
    before writing a new llama-swap config from scratch
  - `proxy-models.json` — likely the existing per-model generation policy
    file (`--model-config`); check whether the two test models need entries
    added here
  - `influxdb-client.js` — shared InfluxDB writer, should work unmodified
  - `ubuntu-setup.md` — precedent for a per-platform setup doc; a
    `macos-setup.md` following the same structure would be a reasonable
    place to capture what this checklist discovers
  - `kv-cache-tracking.md`, `model-test-report-2026-04-11.md`,
    `proxy-token-usage-incident-2026-05-02.md` — worth a quick skim for
    prior art before re-deriving anything already documented

## Already confirmed (as of this session)

- `iogpu.wired_limit_mb` on this machine is `0` (system default policy,
  ~75% of 8GB ≈ 6.1GB ceiling)
- Baseline memory pressure is already tight at idle: 5.27/8.0GB RAM (65.8%),
  1.50/2.0GB swap in use, "System-wide memory free percentage: 58%" — real
  headroom is roughly 2-2.5GB
- `macmon` installs cleanly via Homebrew, runs without sudo (reads SMC via
  IOKit private API, unlike `powermetrics` which requires root every call)
- `macmon pipe -s 1` returns clean JSON with a top-level `gpu_power` field
  (watts), plus `cpu_power`, `ane_power`, `sys_power`, and `memory.*` —
  confirmed working, sample captured

## Decision: don't override wired_limit_mb on this machine

8GB total leaves too little slack to safely raise the GPU ceiling — default
~6.1GB is already aggressive relative to the ~2-2.5GB real headroom observed.
Keep default (`0`) and test with small models only (1-3B range, e.g.
Qwen2.5-Coder-1.5B at Q4, already in rotation on `llmserver`).

## Open design question: which power fields to report

On the 3090/4070 boxes, `nvidia-smi` GPU watts ≈ the whole inference power
story. On Apple Silicon, CPU does real work too (tokenization, KV cache
orchestration) — the captured sample showed `gpu_power: 0.0016W` at idle vs
`cpu_power: 1.95W` and `sys_power: 10.99W`. Reporting `gpu_power` alone would
undercount real energy cost and make the Mac look artificially cheaper per
request in the `$` cost column than it actually is.

**Decided: `gpu_power` alone**, matching what `nvidia-smi` reports on the other
nodes so the `$`-per-request column stays comparable across hosts. Whole-system
power is captured separately, outside this pipeline.

The concern about undercounting is real but smaller than the idle sample
suggested: measured under Metal inference, GPU power goes from **0.002W idle to
2.5W average / 8.9W peak**, so the GPU signal is not noise. Because idle is
effectively zero, `--gpu-idle 0` is correct on this host — there is no baseline
to subtract, unlike the 11W (llmserver) and 15W (devbox) the discrete cards
draw at rest.

`power-macos.js` takes the field from `MACMON_POWER_FIELD`, so switching to
`sys` or `cpu+gpu+ane` later is an environment variable, not a code change.

## Checklist

### 1. Power provider module
- [x] Read `~/llm-stuff/power-nvidia-smi.js` first to confirm the exact
      `sample(callback)` contract, then write `~/llm-stuff/power-macos.js`
      alongside it, shelling out to `macmon pipe -s 1` and parsing JSON
- [x] Decide and implement the power-field question above — **done**, `gpu_power`, overridable via `MACMON_POWER_FIELD`
- [x] Test `node ~/llm-stuff/proxy.js --power --power-provider ./power-macos.js ...`
      end to end, confirm wattage appears in console `[done]` lines
- [x] Confirm InfluxDB write includes the macOS power fields alongside
      existing `gpu_avg_watts` / `gpu_peak_watts` / `gpu_energy_wh` tags,
      tagged with `host: os.hostname()` so it's distinguishable from the
      Linux/Windows nodes in Grafana/InfluxDB queries

### 2. llama.cpp Metal build
- [x] Build `~/llama/llama.cpp` with `-DGGML_METAL=ON -DGGML_ACCELERATE=ON` — **b10686**, also `-DGGML_METAL_EMBED_LIBRARY=ON` so the shaders don't have to be found relative to cwd under launchd
- [x] Confirm `llama-server` starts and loads
      `~/llama/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` without
      wired-limit errors
- [x] `curl -s http://localhost:8080/props | jq` — confirm response shape
      matches what proxy.js's auto-detection expects (`serverCtx`,
      `serverBuildInfo`, `serverModel`) — **verified**: `n_ctx` 32768,
      `build_info` `b10686-3173a5647`, `total_slots` 1. Note
      `default_generation_settings.model` is `null`, so the model name comes
      from the `model_path` fallback in `fetchServerCtx()` — that fallback
      chain is load-bearing on this build, not decorative.
- [x] `curl -s http://localhost:8080/slots | jq` — same check; returns an
      array, as `fetchServerSlots()` expects
- [x] Run a chat completion through `proxy.js` pointed at this server, confirm
      `[done]` line logs prompt/gen tok/s correctly — pp 137-182 tok/s, tg ~50 tok/s
- [x] Repeat the `/props`/`/slots` check with
      `~/llama/models/nomic-embed-text-v1.5.f16.gguf` served via
      `llama-server --embedding`, confirm `/v1/embeddings` responds

### 3. Model swapping (llama-swap)
- [x] Check what's already in `~/llm-stuff/llama-swap/` before writing a new
      config — may already have a partial setup from earlier exploration — had linux/ and windows/ only; added `macos/` and `configs/mac-m1.yaml`
- [x] Check whether `~/llm-stuff/proxy-models.json` needs entries added for
      `qwen2.5-coder-1.5b-instruct-q4_k_m` and `nomic-embed-text-v1.5.f16` — **yes**, added `qwen25-coder-small` and `nomic-embed` profiles
- [x] Configure llama-swap with both models (see draft config from prior
      discussion — one llama-server entry per model, or Ollama for the
      embed model if testing the mixed-backend scenario deliberately) — both via llama.cpp; no Ollama needed
- [x] Trigger swaps by alternating requests, watch `vm_stat`/`memory_pressure`
      before/after each swap to confirm memory is actually freed on unload,
      not just marked idle — **memory is genuinely freed**: wired 2.77GB → 1.98GB, system free 33% → 46% on unload
- [x] Confirm embedding requests and chat requests interleaving correctly
      triggers a swap each time, rather than llama-swap losing track of which
      backend is "current" when the two models use different serving stacks — 4 alternating swaps, all correct, ~1.5s each

### 4. MLX serving path — IN PROGRESS (2026-09-03)
- [x] Install `mlx-lm` — `mlx-lm 0.31.3` / `mlx 0.32.2` in a venv at
      `~/mlx/venv` on Homebrew Python 3.14.2 (arm64). All wheels available; the
      install is 432MB. Metal confirmed live: `mx.default_device()` is
      `Device(gpu, 0)` and `mx.metal.is_available()` is `True`.
- [x] **MLX cannot read GGUF.** `mlx_lm/gguf.py` is export-only —
      `convert_to_gguf`, reachable solely from `mlx_lm.fuse --export-gguf`.
      There is no load path. Models are safetensors + `config.json` +
      tokenizer, so every model is a second download alongside its GGUF twin.
      `mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit` (~880MB) is the
      counterpart to `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`.
- [x] `llama-swap` compatibility: `mlx_lm server` serves `/health` and
      `/v1/models`, so `checkEndpoint: /health` works unchanged. Added
      `llama-swap/macos/server-mlx.sh` and a `qwen25-coder-1.5b-mlx` entry in
      `mac-m1.yaml`, both on port 8082, so the two backends are selectable by
      model id in a single request instead of by editing config.
- [x] Response-shape comparison **(from source; needs confirming against a live
      response)**:

  | proxy.js needs | llama.cpp | MLX | Impact |
  | --- | :---: | :---: | --- |
  | `usage.prompt_tokens` | yes | **yes** | prompt count survives |
  | `usage.completion_tokens` | yes | **yes** | gen count survives |
  | `usage.prompt_tokens_details.cached_tokens` | yes | **yes** | cache-hit % survives |
  | `timings.prompt_ms` | yes | **no** | — |
  | `timings.prompt_per_second` | yes | **no** | pp tok/s → null |
  | `timings.predicted_ms` | yes | **no** | duration → null |
  | `timings.predicted_per_second` | yes | **no** | tg tok/s → null |

- [ ] **Required proxy.js change, and it is not cosmetic.** MLX emits no
      `timings` object at all, and `deriveLlamaTimingMetrics` reads *only* from
      it, so on MLX all five of `promptTokSec`, `tokSec`, `promptMs`,
      `durationSec` and `totalSec` come back `null`. The `[done]` line loses
      its throughput numbers and the InfluxDB timing fields go empty — on the
      machine doing the real work. Token counts and cache-hit tracking are
      unaffected.

      The fix is a wall-clock fallback: the proxy already records
      `requestStart` and computes `elapsed`, so `tg` can be derived from
      `completion_tokens` over the generation window and `pp` from
      `prompt_tokens` over time-to-first-token. That needs a first-token
      timestamp, which is not currently captured. Doing it that way is
      backend-agnostic and would work for llama.cpp and Ollama too, rather
      than special-casing MLX.
- [x] Live run confirms the table exactly. Final chunk from `mlx_lm.server`:

      ```json
      {"model": "qwen25-coder-1.5b-mlx", "choices": [],
       "usage": {"prompt_tokens": 51, "completion_tokens": 200, "total_tokens": 251,
                 "prompt_tokens_details": {"cached_tokens": 0}}}
      ```

      `usage` complete, `cached_tokens` present, **no `timings` key at all**.
      Prompt caching works and reports (`cache=25reused` on repeat requests),
      so cache-hit tracking survives unchanged.
- [x] Wall-clock fallback verified end to end — the `[done]` line carries real
      `pp`/`tg` for MLX where it would otherwise have been blank.
- [x] **Integration gotcha, cost an hour: mlx-lm resolves the *request's*
      model field, not just its `--model`.** `ModelProvider._model_map` holds
      one entry (`"default_model"` → the CLI argument); anything else falls
      through to a Hugging Face lookup, so llama-swap forwarding its own model
      id made mlx-lm try to download a repo named `qwen25-coder-1.5b-mlx` and
      404 — with the correct model already loaded. Fixed by serving from
      `$MODEL_DIR` with a bare relative name so request, load key and response
      all match. This also keeps the InfluxDB `model` tag readable: mlx-lm
      echoes the request's model string back, and proxy.js tags from the
      response, so the alternatives (`"default_model"` or an absolute path)
      would both have polluted the tag the whole comparison is keyed on.
- [x] Throughput comparison, same weights, same box, warm:

      | | tg tok/s | gpu avg / peak | total | pp tok/s |
      | --- | ---: | ---: | ---: | ---: |
      | llama.cpp | **52.9** | 7.7W / 8.7W | 3.84s | 431 |
      | MLX | 50.1 | **4.4W / 5.3W** | 4.20s | 146 |

      **llama.cpp is ~5% faster on generation; MLX draws ~43% less GPU power.**
      Per token that is 0.146 W·s for llama.cpp against 0.088 for MLX — MLX is
      roughly 40% more energy-efficient here despite being slower. MLX is not
      the automatic speed win it is often assumed to be, at least not at this
      size on this hardware.

- [ ] **Do not compare the `pp` column across backends.** llama.cpp's figure
      is its own prefill-only `prompt_per_second`; MLX's comes from the
      wall-clock fallback, which measures `prompt_tokens` over time-to-first-
      token and so also carries tokenization, template application and the
      first token's own generation. 431 vs 146 is a measurement artifact, not a
      3x prefill gap. `tg` *is* comparable — both cover the generation window,
      with the fallback biased high by roughly one token in `gen` (~0.5% at
      200 tokens). Worth making the docs or the log output say this before
      someone reads the pp numbers as a benchmark.
- [ ] Re-measure on the M5. Per this document's own framing this 8GB M1 is a
      pipeline-validation node and its performance numbers are meaningless in
      absolute terms; only the *shape* of the result (MLX slower but cooler)
      should carry forward, and even that needs confirming at 96GB with a model
      worth serving.

### 5. proxy.js port/host sanity
- [x] Confirm `~/llm-stuff/proxy.sh` (vs. `proxy.ps1` on Windows) launches
      cleanly on macOS — check for any Linux-specific assumptions before
      trusting it as-is — **needed changes**; now host-profile aware
- [x] Confirm proxy.js binds correctly on macOS (no Gatekeeper/firewall
      prompt blocking `0.0.0.0` listen) — proxy.js binds 127.0.0.1:8081 and
      llama-swap binds `0.0.0.0:8080`, both with no prompt, and 8080 answers on
      the LAN IP (192.168.86.34). The host was renamed to `mac-m1`
      (`scutil --set HostName`) so it tags cleanly in InfluxDB. Note the
      application firewall is currently
      **disabled** on this host, so this did not exercise the prompt path — if
      it is ever enabled, macOS will ask to allow incoming connections for the
      `llama-swap` binary on first bind.
- [x] Confirm backend auto-detection from port (8080 → llama.cpp,
      11434 → ollama) behaves the same as on Linux/Windows

### 6. Write up findings
- [x] Once the above checks pass, write `~/llm-stuff/macos-setup.md` following
      the same structure as the existing `ubuntu-setup.md`, so the M5 Ultra
      setup has a per-platform reference doc matching the others — **written**

### 7. System monitoring commands (reference)
```bash
# Current wired limit (0 = system default ~75%)
sysctl iogpu.wired_limit_mb

# Memory pressure snapshot
memory_pressure

# Page-level memory detail
vm_stat

# What's running and its RSS
ps aux | grep -E 'llama-server|mlx_lm|python' | grep -v grep

# GPU/CPU power, no sudo needed
macmon                 # live TUI
macmon pipe -s 1        # one JSON sample, for scripting
```

### 8. Not in scope for this machine
- Model quality/benchmark comparisons (8GB can't run anything representative
  of what the M5 Ultra will host)
- Absolute tok/s numbers — not predictive of M5 Ultra performance
- `iogpu.wired_limit_mb` tuning beyond confirming the command works — the real
  tuning work happens on the M5 Ultra where there's actual headroom to give

## Reference: draft power-macos.js

```js
// power-macos.js — power provider for proxy.js's --power-provider flag
const { spawn } = require('child_process');

module.exports = {
  sample(callback) {
    const proc = spawn('macmon', ['pipe', '-s', '1']);
    let buf = '';
    proc.stdout.on('data', chunk => buf += chunk);
    proc.on('close', () => {
      try {
        const json = JSON.parse(buf.trim());
        // TODO: resolve open design question above — gpu_power alone,
        // or a combined total (sys_power, or cpu+gpu+ane)?
        callback(json.gpu_power ?? null);
      } catch {
        callback(null);
      }
    });
    proc.on('error', () => callback(null));
  }
};
```
