# M1 Mac Mini (8GB) — Discovery & Pipeline Validation Plan

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

**Decision needed:** report `gpu_power` alone (apples-to-apples vs nvidia-smi's
GPU-only number) or `sys_power` / `cpu_power + gpu_power + ane_power` (honest
total energy cost). Leaning toward the latter for cost-tracking accuracy —
confirm before wiring into InfluxDB permanently.

## Checklist

### 1. Power provider module
- [ ] Write `power-macos.js` implementing the same `sample(callback)` contract
      as `power-nvidia-smi.js`, shelling out to `macmon pipe -s 1` and parsing
      JSON
- [ ] Decide and implement the power-field question above
- [ ] Test `node proxy.js --power --power-provider ./power-macos.js ...` end
      to end, confirm wattage appears in console `[done]` lines
- [ ] Confirm InfluxDB write includes the macOS power fields alongside
      existing `gpu_avg_watts` / `gpu_peak_watts` / `gpu_energy_wh` tags,
      tagged with `host: os.hostname()` so it's distinguishable from the
      Linux/Windows nodes in Grafana/InfluxDB queries

### 2. llama.cpp Metal build
- [ ] Clone/build llama.cpp with `-DGGML_METAL=ON -DGGML_ACCELERATE=ON`
- [ ] Confirm `llama-server` starts and loads a small GGUF model (e.g.
      Qwen2.5-Coder-1.5B Q4) without wired-limit errors
- [ ] `curl -s http://localhost:8080/props | jq` — confirm response shape
      matches what proxy.js's auto-detection expects (`serverCtx`,
      `serverBuildInfo`, `serverModel`) — **not yet verified, do this next**
- [ ] `curl -s http://localhost:8080/slots | jq` — same check
- [ ] Run a chat completion through `proxy.js` pointed at this server, confirm
      `[done]` line logs prompt/gen tok/s correctly

### 3. MLX serving path
- [ ] Install `mlx-lm`, run `mlx_lm.server` with an MLX-quantized version of
      the same small test model
- [ ] Compare its OpenAI-compatible streaming response shape against
      llama.cpp's — specifically whether `timings.prompt_per_second`,
      `timings.cache_n`, and `usage.prompt_tokens_details.cached_tokens` are
      present (proxy.js's `deriveLlamaTimingMetrics` and cache-hit logging
      depend on these; MLX may not populate all of them)
- [ ] Note any field gaps found — these will need proxy.js changes before the
      M5 Ultra arrives, not after

### 4. proxy.js port/host sanity
- [ ] Confirm proxy.js binds correctly on macOS (no Gatekeeper/firewall
      prompt blocking `0.0.0.0` listen)
- [ ] Confirm backend auto-detection from port (8080 → llama.cpp,
      11434 → ollama) behaves the same as on Linux/Windows

### 5. System monitoring commands (reference)
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

### 6. Not in scope for this machine
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
