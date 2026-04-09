# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repo contains a debug proxy for inspecting API traffic to Ollama or llama.cpp backends.

## Debug Proxy (`proxy.js`)

A zero-dependency Node.js HTTP proxy that sits between a client and an LLM backend (Ollama or llama.cpp), logging request/response details with colored terminal output. No build step or `npm install` required.

Run with: `node proxy.js [options]`

### Dual-backend support

The proxy auto-detects the backend from the listen port, or it can be forced:
- **Ollama mode** (default): proxy listens on `:11434`, forwards to Ollama on `:11435`. Ollama must be reconfigured to listen on 11435.
- **llama.cpp mode**: proxy listens on `:8080`, forwards to llama.cpp on `:8081`. Activate with `--backend llamacpp` or by setting `--proxy-port 8080`. At startup, the proxy queries the llama-server `/props` endpoint to auto-detect `n_ctx`; `--default-ctx` serves as a fallback if the server is unreachable.
- Override any port with `--proxy-port N` and `--backend-port N`.

The proxy translates Ollama-style request fields (e.g. `options.num_predict`) into OpenAI-compat fields (`max_tokens`) when targeting llama.cpp via `transformRequestBody()`.

### Output modes (mutually exclusive)

- `--buffer-thinking` (default) — reassembles thinking tokens into larger blocks before logging
- `--filter-thinking` — suppresses thinking chunks from log output entirely
- `--raw` — prints every raw JSON chunk as-is

### Additional flags

- `--dump-messages` — prints the full messages array from each request
- `--dump-request` — prints the full transformed request body (params + all messages)
- `--message-size N` — max chars per message preview (default 300, 0 = no limit)
- `--default-ctx N` — fallback context size for context-pressure calculation
- `--thinking` — inject `think:true` into requests (default injects `think:false`)
- `--debug-labels` — dump first user message for job-label tuning
- `--log-file [path]` — append `[done]` summary lines to a file (default: `./proxy-done.log`)
- `--power` — enable GPU power monitoring and energy cost tracking
- `--power-provider path` — path to power provider module (default: `./power-nvidia-smi.js`)
- `--electric-rate N` — electricity rate in $/kWh (default: 0.18947)
- `--gpu-idle N` — GPU idle watts to subtract for incremental cost calculation (default: 0)
- `--power-interval N` — power sampling interval in ms (default: 1000)
- `--log-mode M` — logging mode: `file` | `influxdb` | `none` (default: `none`)
- `--influxdb-url URL` — InfluxDB server URL (or env `INFLUXDB_URL`)
- `--influxdb-org ORG` — InfluxDB organization (or env `INFLUXDB_ORG`)
- `--influxdb-bucket B` — InfluxDB bucket (or env `INFLUXDB_BUCKET`)
- `--influxdb-token T` — InfluxDB auth token (or env `INFLUXDB_TOKEN`)

### Architecture notes

- **Stream parsing**: Ollama sends newline-delimited JSON (NDJSON); llama.cpp sends SSE (`data: {...}`). Each has its own handler (`handleOllamaStream` / `handleLlamaCppStream`) but they share the `logDone()` summary formatter.
- **Session tracking**: Groups requests by job label (extracted from `[cron:...]`, `[agent:...]`, `[session:...]` tags in the first user message). Sessions accumulate prompt/gen token counts and expire after 60s of inactivity.
- **Context pressure**: When `num_ctx` is known, the `[done]` line shows what percentage of the context window was consumed and flags HIGH/OVER LIMIT.
- **Tool call logging**: Both handlers accumulate streamed tool-call fragments and flush them as formatted blocks on completion.
- **Power monitoring**: Modular power provider system. The default `power-nvidia-smi.js` reads GPU wattage via `nvidia-smi`. Custom providers can be swapped in via `--power-provider` for AMD GPUs, Intel Arc, or other platforms. Providers export `{ name, test(cb), sample(cb) }`. The proxy tracks per-request energy (Wh) and cost ($), accumulating both in sessions.
- **KV cache tracking**: For llama.cpp backends, the proxy tracks `prompt_past` (cached/reused prompt tokens) vs newly computed tokens. The `[done]` line shows cache hit rate as a percentage. These metrics are written to InfluxDB when enabled (`prompt_tokens_past`, `prompt_tokens_total`, `cache_hit_pct`) and accumulated per session as `session_prompt_tokens_past`.
- **InfluxDB logging**: When `--log-mode influxdb` is active, each completed request writes a point to the `llm_request` measurement via `influxdb-client.js`. Tags include backend, model, job type/name, and hostname. Fields cover tokens, timing, context pressure, cache hit rate, GPU power, and energy cost. Sessions accumulate totals across related requests.

### Supporting files

- `influxdb-client.js` — Zero-dependency InfluxDB v2 line protocol writer using native `http`/`https`.
- `explore-influxdb.js` — CLI tool to query InfluxDB and explore stored proxy metrics.
- `grafana-llm-dashboard.json` — Importable Grafana dashboard for visualizing proxy metrics from InfluxDB.
- `power-nvidia-smi.js` — Default GPU power provider; reads wattage via `nvidia-smi`.
