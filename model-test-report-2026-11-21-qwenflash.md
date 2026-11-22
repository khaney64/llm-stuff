# Model Test Comparison Report: Strata vs llama.cpp on Qwen3.8 Flash Next, 2026-11-21

Qwen3.8-Flash-Next (a 512-expert MoE, `qwen4exp` architecture) served two ways on the same RTX 3090, from the
**same GGUF files**, and tested with the same prompts. Both engines keep the model's experts mostly in system RAM.

## 0. Test environment

**Hardware:** one NVIDIA RTX 3090 (24 GB, sm_86) on `devbox`, driver 616.92, 96 GB RAM.

| | Strata (`qwenflash-st`) | llama.cpp (`qwenflash-lc`) |
| --- | --- | --- |
| Engine | Strata terminal v0.2.18, engine 0.1.64 (prebuilt, CUDA 13.0) | llama.cpp b12359 (pre-built) |
| Weights | `Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S` (2 files, 51.1 + 26.8 GB) | the same files |
| Expert placement | adaptive GPU expert cache, all experts pinned in RAM, CPU computes misses in parallel | `-fit` (no `-ngl`): a fixed split chosen at load, with expert tensors overridden to the CPU |
| Speculative decoding | DFlash2 drafter (`--draft dflash2 --spec 6`) | none (the GGUF has no MTP layers) |
| KV cache | int8, 32K resident on the GPU | q8_0 K/V, flash attention |
| Context | 204,800 | 204,800 |
| Prompt cache | yes | yes |
| VRAM in use | 23.7 GiB | 23.7 GiB |

The llama.cpp entry is `server.ps1 -Build b12359 -Model qwenflash-lc`. The GGUF's second file holds a single tensor,
the 26.8 GB PLE n-gram table. llama.cpp loads it as an ordinary split, while Strata reads it with `--ple-gguf`.

**How the measurements were taken:**
- **Path:** unlike the TensorFold report, every request went through the stack Hermes uses: llama-swap on `:8080`,
  then the debug proxy on `:8081`, then the engine on `:8082`, with the model selected by name. So the numbers include
  the proxy, and the per-request power figures are in InfluxDB.
- **Sampling:** every request was streamed at temperature 0. Thinking was off except in §3.
- **Timing:** TTFT and decode speed were measured on the client side. Decode speed is generated tokens divided by the
  time from the first to the last streamed token.
- **Warm-up:** each suite began with one warm-up request.
- **Proxy fix:** the proxy applies a per-model policy from `proxy-models.json`. `qwenflash-lc` was missing from it at
  first, so the proxy forced thinking off for it. It now shares the `qwen38-flash-strata` profile. The thinking result
  in §3 is a rerun after that fix.

## 1. Decode speed by content type

| Prompt | Prompt tok | Gen tok (st / lc) | Strata decode | llama.cpp decode | Speed-up | Strata total | llama total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| prose (short story) | 36 | 570 / 649 | **85.1** tok/s | 24.0 | 3.5× | 7.2 s | 28.6 s |
| code: new module + tests | 57 | 1406 / 2000 | **110.3** | 25.9 | 4.3× | 13.6 s | 78.9 s |
| code: C# refactor | 253 | 276 / 276 | **94.3** | 26.5 | 3.6× | 3.9 s | 13.1 s |
| JSON extraction (3.6K-token doc) | 3,639 | 440 / 445 | **106.5** | 27.2 | 3.9× | 6.4 s | 28.2 s |
| summary (3.6K-token doc) | 3,625 | 517 / 531 | **75.8** | 25.8 | 2.9× | 9.1 s | 27.7 s |
| single tool call | ~290 | 40 / 40 | **70.9** | 35.5 | 2.0× | 1.8 s | 5.3 s |

- **llama.cpp decodes at a steady 24–27 tok/s** whatever the content. Every token's experts on the CPU set the pace.
- **Strata's drafter accepts 82–94% of its drafts:**
  - code: 1086 of 1210
  - JSON: 355 of 378
  - refactor: 200 of 245
  - prose: 226 of 319
  - summary: 286 of 346

  So it decodes 3–4× faster on everything but the one-line tool call.
- **Output quality:**
  - The JSON was valid on both engines, with the same 7 items.
  - Both tool calls were identical: `get_weather {"city":"Pittsburgh","units":"f"}`.
  - llama.cpp hit the 2000-token cap on the new-module prompt. Strata finished in 1406 tokens. These are different
    greedy paths, not a measured quality difference.

## 2. Long-prompt prefill and retrieval

Each prompt is TensorFold documentation with one hidden "needle" sentence in the middle. A unique nonce at the very
start of each prompt stops either engine from reusing a cached prefix.

| Prompt | Strata TTFT | Strata prefill | llama.cpp TTFT | llama prefill | Speed-up | Needle (st / lc) |
| --- | ---: | ---: | ---: | ---: | ---: | :---: |
| 8K (7.8K tok) | 3.5 s | 2,241 tok/s | 23.5 s | 331 tok/s | 6.8× | ✓ / ✓ |
| 32K (30.4K tok) | 11.8 s | 2,572 tok/s | 75.9 s | 400 tok/s | 6.4× | ✓ / ✓ |
| 60K (61.3K tok) | 23.0 s | 2,665 tok/s | 130.2 s | 470 tok/s | 5.7× | ✓ / ✓ |

- **Strata prefills at 2,200–2,700 tok/s.** It reads prompts 8,192 tokens at a time and streams the next layer's
  experts to the GPU while the current layer's attention runs.
- **llama.cpp prefills at 330–470 tok/s,** with `--ubatch-size 2048` and the experts on the CPU.
- **Retrieval:** both engines found the needle at every length.

## 3. Reasoning (thinking on)

The prompt was the meeting-trains problem (the answer is 10:56:40 at about 155.6 km).

| | Gen tokens | Reasoning chars | Decode | Total | Final line |
| --- | ---: | ---: | ---: | ---: | --- |
| Strata | 4,378 | 11,225 | **97.2** tok/s | 46.0 s | `10:57, 155.56 km` ✓ |
| llama.cpp | 2,331 | 5,562 | 26.6 tok/s | 90.2 s | `10:57, 155.6 km` ✓ |

Both answers are correct. Strata reasoned for almost twice as many tokens and still finished in half the time. In
the first llama.cpp run, before the proxy fix, thinking was forced off. That run answered correctly too, in 1,772
tokens with no reasoning block.

## 4. Agentic tool calling (`ollama-model-tests` agentic-chat)

This is the suite's multi-turn portfolio-risk task: 8 tools and 3 portfolios, with managed context, temperature 0.2,
`num_ctx` 65536 and thinking off. It was run with `bench/agentic_chat_oa.py` and scored with
`evaluate_agentic_chat.py --mode gpu --ctx-size 65536`. Results are under
`ollama-model-tests/models/{qwenflash-st,qwenflash-lc}/results/agentic-chat/gpu/ctx-65536`.

| | Grade | Turns | Tool calls | Tools used | Wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| Strata | **A (10.0)** | 7 | 20 / 20 ok | 6/8 | **31.1 s** |
| llama.cpp | **A (10.0)** | 6 | 19 / 19 ok | 6/8 | 160.5 s (about 100 s without the swap) |

- **Same quality:** both used the same six tools and left out `generate_report` and `send_notification`, as
  `qwen38-27b` and `qwen27-tf` did. All four models score 10.0 on this task.
- **The llama.cpp wall time includes a model swap:** its first turn took 65.9 s because llama-swap was loading it.
  Without that, it is about 100 s against Strata's 31 s.

## 5. Long coding session at 120K (`bench/long_session.py`)

This simulates a coding-agent session. Each turn pastes real source files (TensorFold's `.zig` files), then asks for
up to 800 tokens of code, with thinking off and greedy decoding. The context grows through about 19K, 36K, 62K, 97K and
118K, then two short follow-ups at about 120K show the steady state. The full history is resent every turn.

**Time to first token, in seconds (decode tok/s in brackets):**

| Turn | Context | New tokens computed | Strata | llama.cpp |
| --- | ---: | ---: | ---: | ---: |
| 0 files | 18.8K | 18,846 | 7.6 (90) | 45.4 (26) |
| 1 files | 35.5K | 16,234 | 6.6 (113) | 37.9 (25) |
| 2 files | 62.4K | 26,205 | 10.6 (107) | 58.4 (23) |
| 3 files | 97.5K | 34,341 | 14.4 (112) | 78.4 (21) |
| 4 files | 118.4K | 20,329 | 9.1 (106) | 46.2 (20) |
| 5 follow-up (+39 tok) | 119.2K | 40 | **0.70** (103) | **1.23** (20) |
| 6 follow-up (+45 tok) | 120.1K | 46 | **0.75** (105) | **1.29** (20) |
| **Session total** | | | **95.4 s** | **495.0 s** |

- **Both prompt caches work.** Each turn computes only the new tokens, so a follow-up at 120K starts in about a second
  on both engines.
- **Strata's decode does not fall off with context.** It stays at 103–113 tok/s at 98K–120K. llama.cpp drops from 26
  to 20 tok/s.
- **For comparison:** the dense `qwen38-27b` on llama.cpp ran this session in 265 s in the TensorFold report. Strata
  runs the much larger Flash Next MoE through it in 95 s.

## 6. Why Strata is faster

Strata is its own engine, not a llama.cpp build. It reuses ggml's i-quant formats, GPU dot products and CPU i-quant
kernels (`engine/third_party/ggml`), but the scheduling, memory placement and model graph are its own, written for a
few MoE models (`Strata/docs/HOW_IT_WORKS.md`, `DETAILS.md`). The gap comes from four things:

1. **An adaptive expert cache.** Each token uses 10 of 24,576 experts. Strata fills spare VRAM with the most-used
   ones, about 700 per GB, and keeps relearning which those are. llama.cpp's `-fit` makes one fixed placement at load,
   so every token pays CPU time on the offloaded layers, whichever experts it needs.
2. **CPU and GPU work at the same time.** Strata computes the experts that aren't on the card on the CPU while the GPU
   computes the cached ones. llama.cpp mostly alternates between them.
3. **Speculative decoding.** The DFlash2 drafter is accepted 82–94% of the time here. llama.cpp has no drafter for this
   GGUF.
4. **Pipelined prefill.** Strata reads 8K chunks and overlaps the PCIe expert transfers with attention.

## 7. Takeaways

1. **Strata is 3–4× faster at decode and 6× faster at prefill** on this card, with the same output quality on every
   check: JSON, tool call, needle at 8K–60K, reasoning answer, and agentic grade.
2. **Keep `qwenflash-st` as the Flash Next model for Hermes.**
3. **Keep `qwenflash-lc`, but don't route agents to it:**
   - It costs only two config entries, because it shares Strata's GGUF.
   - It's a fallback if a Strata update breaks.
   - It's an independent reference for Strata's output.
   - It's a yardstick for new llama.cpp builds.
4. **Revisit `qwenflash-lc` when:**
   - a GGUF with the MTP layers and llama.cpp MTP support for `qwen4exp` appear, which could close 1.5–2× of the gap;
   - llama.cpp gains dynamic expert placement or overlapped CPU/GPU expert compute.
5. **Not tried:** tuning `qwenflash-lc` beyond `-fit`. Options include an explicit `--n-cpu-moe`, `--load-mode none`
   (llama.cpp warns that CPU tensor overrides with mmap enabled cost performance), and a larger `--ubatch-size`. None
   of these is likely to close a 4× gap.
6. **Turbofit, the reason for this test, isn't needed.** Its Qwen3.8 Flash Next recipes run Strata itself. Its only
   non-Strata recipe is llama.cpp with `--n-cpu-moe`, on a pinned build 2,090 commits older than b12359. So
   `qwenflash-lc` already is that comparison.

## Appendix: harness and data

- Raw results: `bench/results/qwenflash-2026-11-21/`. This has `qwenflash-{st,lc}-oa.json`,
  `qwenflash-{st,lc}-long.json` and `qwenflash-lc-thinking-rerun.json`.
- Agentic results: `ollama-model-tests/models/qwenflash-{st,lc}/results/agentic-chat/gpu/ctx-65536`. The report card
  is `ollama-model-tests/reports/gpu/report_card_agentic_chat.md`.
- **Commands:** each is run against the llama-swap base URL `http://127.0.0.1:8080`.
  - `oa_bench.py <base> <model> <label> <out.json>`
  - `long_session.py <base> <model> <label> <out.json>`
  - `agentic_chat_oa.py <base> <model>`
- **Config changes made for this test:**
  - The `qwenflash-lc` entries in `llama.cpp/pre-built/server.ps1` and `llama-swap/configs/devbox.yaml`.
  - `qwenflash-lc` added to the `qwen38-flash-strata` profile in `proxy-models.json`.
  - `strata.py serve` added to the 8082 port guard in `llama-swap/windows/manage.ps1`. Without it, `manage.ps1
    restart` throws while Strata is loaded.
- **Restarting only `LlamaProxy`:** the first request right after the restart got a 502. Wait a few seconds before
  sending traffic.
