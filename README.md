# LLM Stuff

Tooling for working with local LLM instances (Ollama, llama.cpp).

## Debug Proxy (`proxy.js`)

A zero-dependency Node.js HTTP proxy that sits between your client and an LLM backend, logging request/response details with colored terminal output. Supports both Ollama and llama.cpp backends.

### Quick start

```bash
# Ollama mode (default) — proxy on :11434, backend on :11435
node proxy.js

# llama.cpp mode — proxy on :8080, backend on :8081
node proxy.js --backend llamacpp
```

For Ollama mode, you must configure Ollama to listen on port **11435** so the proxy can take over the standard 11434 port. Clients need no reconfiguration.

### Output modes

Pick one (mutually exclusive):

| Flag | Behavior |
|------|----------|
| `--buffer-thinking` | Reassemble thinking tokens into larger blocks before logging **(default)** |
| `--filter-thinking` | Suppress thinking chunks from log output entirely |
| `--raw` | Print every raw JSON chunk as-is |

### Options

| Flag | Description |
|------|-------------|
| `--backend ollama\|llamacpp` | Force backend mode (default: auto-detect from port) |
| `--proxy-port N` | Override proxy listen port |
| `--backend-port N` | Override backend port |
| `--dump-messages` | Print the full messages array from each request |
| `--dump-request` | Print the full transformed request body (params + all messages) |
| `--message-size N` | Max chars per message preview (default: 300, 0 = no limit) |
| `--default-ctx N` | Fallback context size for context-pressure calculation |
| `--thinking` | Inject `think:true` into requests (default: injects `think:false`) |
| `--debug-labels` | Dump first user message for job-label tuning |
| `--log-file [path]` | Append `[done]` summary lines to a file (default: `./proxy-done.log`) |

### What it logs

- **Request summaries** — model, temperature, message count, stream flag
- **Thinking blocks** (magenta) — model's chain-of-thought reasoning tokens
- **Content tokens** (green) — actual response text, flushed on sentence boundaries
- **Tool calls** (cyan/yellow) — accumulated and pretty-printed on completion
- **Done lines** — token counts, tok/s, duration, context pressure (% of `num_ctx` used), and session totals
