# Proxy Token Usage Incident - 2026-05-02

## Summary

On 2026-05-01, proxy `[done]` lines and InfluxDB `llm_request` points stopped receiving token counts for some llama.cpp streams. The visible symptom was `prompt=? gen=?` in proxy logs, followed by missing `prompt_tokens` and `gen_tokens` fields in InfluxDB.

After updating both servers to the latest proxy, token usage returned. A second issue appeared: cache hit rate dropped from the usual high 90% range to the high 40% range. That was a proxy normalization bug, not evidence that llama.cpp had previously overstated cache reuse.

## Timeline

InfluxDB showed the first missing token usage point on `llmserver/qwen35-9b/chat` at `2026-05-01T16:58:46Z`.

The first missing token usage point on `devbox/qwen36-27b/chat` appeared later at `2026-05-01T18:39:36Z`.

That ordering matched the deployment history: `llmserver` was adjusted first, then `devbox` models later.

## Root Cause

The OpenClaw config change added:

```json
"stream_options": {
  "include_usage": true
}
```

Before that change, the proxy depended on llama.cpp-specific stream metadata on the final chunk:

```js
json.timings.prompt_n
json.timings.predicted_n
json.timings.cache_n
```

With `stream_options.include_usage=true`, llama.cpp can emit OpenAI-compatible usage in a separate stream chunk:

```js
json.usage.prompt_tokens
json.usage.completion_tokens
json.usage.prompt_tokens_details.cached_tokens
```

That usage chunk may arrive after the chunk containing `finish_reason`. The old proxy logged `[done]` immediately on `finish_reason`, so it could miss the later usage data and emit `prompt=? gen=?`.

## Changes Made

The proxy now captures both token metadata formats:

- llama.cpp `timings`
- OpenAI-style `usage`

It also defers final `[done]` metric logging until `[DONE]` or stream end, giving usage chunks time to arrive after `finish_reason`.

This restored token counts on both servers after deployment.

## Cache Hit Rate Finding

The apparent cache hit drop was caused by mixing two different prompt-token meanings.

Old llama.cpp `timings.prompt_n` represented newly computed prompt tokens. The proxy calculated cache hit rate as:

```text
cache_n / (cache_n + prompt_n)
```

New OpenAI-style `usage.prompt_tokens` represents total prompt tokens, including cached tokens. The proxy incorrectly kept using:

```text
cached_tokens / (cached_tokens + prompt_tokens)
```

That double-counted cached tokens in the denominator, which drives a real 99% cache hit rate down to about 50%.

Example from InfluxDB:

```text
cached=18652
usage.prompt_tokens=18671
stored cache_hit_pct=49.97
incorrect formula: 18652 / (18652 + 18671) = 50.0%
correct formula:   18652 / 18671 = 99.9%
```

## Final Semantics

The proxy keeps the existing `[done]` and InfluxDB field meanings:

- `prompt_tokens`: newly computed prompt tokens
- `prompt_tokens_past`: cached/reused prompt tokens
- `prompt_tokens_total`: total prompt tokens
- `cache_hit_pct`: cached/reused prompt tokens divided by total prompt tokens

For OpenAI-style usage chunks:

```text
prompt_tokens = usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens
prompt_tokens_past = usage.prompt_tokens_details.cached_tokens
prompt_tokens_total = usage.prompt_tokens
cache_hit_pct = prompt_tokens_past / prompt_tokens_total
```

For llama.cpp timing chunks:

```text
prompt_tokens = timings.prompt_n
prompt_tokens_past = timings.cache_n
prompt_tokens_total = timings.cache_n + timings.prompt_n
cache_hit_pct = prompt_tokens_past / prompt_tokens_total
```

## Verification

Token usage returned after both servers were updated with the proxy change that captures usage chunks and delays final logging.

The cache-rate correction should restore high cache hit rates for repeated-context requests while preserving existing Grafana and InfluxDB field names.
