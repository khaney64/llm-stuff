# KV Cache Tracking

## What the KV Cache Data Tells You

llama.cpp maintains a KV cache that stores previously computed prompt token representations. When you send a follow-up request that shares a prefix with a previous request (same system prompt, same conversation history), llama.cpp skips recomputing those tokens and reuses them from cache. `prompt_n_past` is how many tokens it reused; `prompt_n` is how many it had to compute fresh.

## What to look for in the `[done]` line

```
pp=1847tok/s(270ms) cache=503reused+344computed(59.4%) tg=126tok/s(4.2s)
```

- **High cache hit %** (>50%) — the server is efficiently reusing prior computation. Common in multi-turn conversations where the system prompt + history is stable.
- **Low/zero cache hit %** — every request is computing from scratch. This happens when: the model was swapped, the server restarted, the prompt prefix changed, or you're using `--no-slot-save` on llama-server.
- **Correlation with prompt speed** — when cache hits are high, `pp=` (prompt tok/s) should be very fast because it's only computing the new tail of the prompt. If `pp` is still slow despite high cache, something else is wrong.

## Dashboard Panels

- **Avg Cache Hit Rate** (stat) — quick health check. If this is consistently low across your workloads, you're paying full prompt processing cost every request.
- **Cache Hit Rate %** (time series) — shows cache efficiency over time. Look for drops — they indicate server restarts, model switches, or prompt structure changes that invalidated the cache.
- **Cached vs Computed Tokens** (stacked bars) — visualizes the ratio over time. Green (cached) should dominate in steady-state multi-turn workloads. If orange (computed) dominates, you're burning GPU cycles reprocessing the same tokens.
- **Cache Reuse by Job** — shows which jobs benefit most from caching. Agentic workloads with long, stable system prompts should show high reuse. One-shot batch jobs won't benefit much.

## Context Pressure Fix

The context pressure % now reflects **total** tokens in the KV cache (cached + computed), not just newly computed. Previously, a request reusing 3000 cached tokens + 500 new tokens in an 8K context would show ~6% pressure. Now it correctly shows ~44%. This means you'll get more accurate HIGH/OVER LIMIT warnings.

## InfluxDB Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompt_tokens_past` | int | Tokens reused from KV cache |
| `prompt_tokens_total` | int | Total prompt tokens (cached + computed) |
| `cache_hit_pct` | float | Cache hit percentage: `past / (past + computed) * 100` |
| `session_prompt_tokens_past` | int | Cumulative cached tokens across session |

## Practical Takeaways

- If cache hit rate is consistently 0% on llama-server, check that you're using slot persistence (`--slot-save-path` or keeping slots alive).
- If it drops suddenly, the server likely restarted or the model was reloaded.
- For Ollama requests, these fields will be absent — Ollama doesn't expose this data.
