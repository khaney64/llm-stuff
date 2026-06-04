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
- **llama.cpp mode**: proxy listens on `:8080`, forwards to llama.cpp on `:8081`. Activate with `--backend llamacpp` or by setting `--proxy-port 8080`. At startup, the proxy queries the llama-server `/props` endpoint to auto-detect `n_ctx`, build number, and model name; these are also re-polled every 60s, and any change is logged. `--default-ctx` serves as a fallback if the server is unreachable.
- Override any port with `--proxy-port N` and `--backend-port N`.

The proxy translates Ollama-style request fields (e.g. `options.num_predict`) into OpenAI-compat fields (`max_tokens`) when targeting llama.cpp via `transformRequestBody()`.

### Output modes (mutually exclusive)

- `--buffer-thinking` (default) — reassembles thinking tokens into larger blocks before logging
- `--filter-thinking` — suppresses thinking chunks from log output entirely
- `--raw` — prints every raw JSON chunk as-is

### Additional flags

- `--help`, `-h` — print the full options list and exit
- `--dump-messages` — prints the full messages array from each request
- `--dump-request` — prints the full transformed request body (params + all messages)
- `--dump-request-file [path]` — write raw request body and headers to files (default dir: `./request-dumps`)
- `--dump-transformed-request-file [path]` — write transformed request body to files (default dir: `./request-dumps`)
- `--message-size N` — max chars per message preview (default 300, 0 = no limit)
- `--default-ctx N` — fallback context size for context-pressure calculation
- `--thinking` — inject `think:true` (Ollama) or enable thinking via `chat_template_kwargs` (llama.cpp); default injects `think:false`
- `--thinking-budget N` — thinking budget tokens for llama.cpp (default: 8192)
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
- **Build info tracking**: For llama.cpp backends, the proxy auto-detects the server build number from `/props` and includes it as a `build` tag in InfluxDB points.
- **InfluxDB logging**: When `--log-mode influxdb` is active, each completed request writes a point to the `llm_request` measurement via `influxdb-client.js`. Tags include backend, model, job type/name, hostname, and build number. Fields cover tokens, timing, context pressure, cache hit rate, GPU power, and energy cost. Sessions accumulate totals across related requests.

### Supporting files

- `influxdb-client.js` — Zero-dependency InfluxDB v2 line protocol writer using native `http`/`https`.
- `explore-influxdb.js` — CLI tool to query InfluxDB and explore stored proxy metrics.
- `grafana-llm-dashboard.json` — Importable Grafana dashboard for visualizing proxy metrics from InfluxDB.
- `power-nvidia-smi.js` — Default GPU power provider; reads wattage via `nvidia-smi`.
- `model-test-report-*.md` — Model test comparison reports benchmarking local models against the test suite.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
