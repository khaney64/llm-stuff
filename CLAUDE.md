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
- **llama.cpp mode**: proxy listens on `:8080`, forwards to llama.cpp on `:8081`. Activate with `--backend llamacpp` or by setting `--proxy-port 8080`.
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

### Architecture notes

- **Stream parsing**: Ollama sends newline-delimited JSON (NDJSON); llama.cpp sends SSE (`data: {...}`). Each has its own handler (`handleOllamaStream` / `handleLlamaCppStream`) but they share the `logDone()` summary formatter.
- **Session tracking**: Groups requests by job label (extracted from `[cron:...]`, `[agent:...]`, `[session:...]` tags in the first user message). Sessions accumulate prompt/gen token counts and expire after 60s of inactivity.
- **Context pressure**: When `num_ctx` is known, the `[done]` line shows what percentage of the context window was consumed and flags HIGH/OVER LIMIT.
- **Tool call logging**: Both handlers accumulate streamed tool-call fragments and flush them as formatted blocks on completion.
