# Community benchmark on NVIDIA GeForce RTX 4070

Measured on 2026-11-26 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 4070, 12 GiB VRAM
- CPU: AMD Ryzen 7 5800XT 8-Core Processor (8 cores, 16 threads); installed RAM: 60.7 GiB; storage: nvme0n1 Samsung SSD 990 PRO 2TB nvme
- OS: Linux 7.0.0-43-generic; GPU driver: 580.178.04; CUDA (driver supports up to): 13.0; engine built for CUDA 13.0
- Strata: project 0.1.69, commit not a git checkout; engine 0.1.69
- GPU detail (after the run, near idle): power_limit_w=200.00, power_draw_w=108.90, pcie=gen4 x16, pstate=P2, temp_c=52
- Background workloads: not recorded (GPU power limit/draw read above)

## Model and configuration

- Model and quantization: qwen3.8-flash-next-iq3_s
- Context: 131072 tokens; parallel slots: 1
- Settings: the install's own configuration, unchanged; thinking off for the suite; temperature 0

```text
strata --pack iq3_s --native Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf --ple-gguf Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf --expert-profile expert-profile.bin --expert-cache auto --prefill auto --spec 4 --mtp rt --max-context 131072 --kv int8 --spec-min-p 0.5 --adapt-every 1 --adapt-swaps 80 --adapt-decay 0.97
```

## Method

Run by `python tools/strata_bench.py` against the HTTP API of a Strata server (started by the benchmark from the install configuration); model loading is not timed. One warm-up chat and a 1K prompt are discarded first. Every prompt starts with a unique tag, so the conversation cache cannot help the fresh-prompt tests.

- short chat: the three questions of `tools/ab_engine.py`, up to 100 new tokens, 3 runs
- 4K / 16K prompts: generated word lists sized by a calibration request, 24 new tokens, 3 fresh prompts each
- agent session: system prompt and four tools, then 5 turns that each add about 1500 words of a project file and continue from the model's own earlier answers (the way agent clients resend a conversation), 64 new tokens per turn, 3 sessions; the cache numbers come from the answer's usage (`cached_tokens`) and timings (`prompt_n`)
- concurrency (when run): N requests sent at the same moment, total tokens over the wall time of the burst, latency over all requests

## Results

| Configuration | Actual prompt tokens | Reused tokens | Generated tokens | Runs | Prompt tok/s median and range | Decode tok/s median and range | TTFT seconds median and range |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| short chat | 46 (43-51) | 0 | 100 (100-100) | 9 | not measured | 44.6 (41.2-51.1) | 0.69 (0.63-0.79) |
| 4K prompt, fresh | 4019 (4019-4019) | 0 (0-0) | 24 cap | 3 | 1935.9 (1874.0-1972.2) | not measured | 2.11 (2.07-2.18) |
| 16K prompt, fresh | 16058 (16058-16058) | 0 (0-0) | 24 cap | 3 | 2194.5 (2189.9-2201.4) | not measured | 7.35 (7.33-7.37) |
| agent session, follow-up turns | 14886 (14874-14902) at the last turn | see below | up to 64 | 3 | see below | 49.6 (43.1-57.8) | 2.38 (1.71-2.98) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.9 % (70.9-70.9); earlier-turn tokens read again per session: 5 (5-5) (earlier turns that the cache did not hold; the 14032 (14032-14033) new tokens of the files are read once); first turn (nothing cached) first token: 1.95 s (1.66-1.96). Corpus: `repo_docs` (8ba45cf16bd6) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 609 | 0 | 609 | 372.8 | 1.664 | 41.8 |
| 1 | 5015 | 641 | 4374 | 1481.4 | 2.985 | 43.1 |
| 2 | 6551 | 5078 | 1473 | 859.7 | 1.748 | 47.3 |
| 3 | 9848 | 6614 | 3234 | 1283.2 | 2.557 | 53.3 |
| 4 | 11971 | 9901 | 2070 | 1049.8 | 2.007 | 45.2 |
| 5 | 14886 | 12000 | 2886 | 1233.9 | 2.373 | 49.6 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 120 s.
