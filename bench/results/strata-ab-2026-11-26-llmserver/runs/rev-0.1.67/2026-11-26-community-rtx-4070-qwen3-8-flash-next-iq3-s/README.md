# Community benchmark on NVIDIA GeForce RTX 4070

Measured on 2026-11-26 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 4070, 12 GiB VRAM
- CPU: AMD Ryzen 7 5800XT 8-Core Processor (8 cores, 16 threads); installed RAM: 60.7 GiB; storage: nvme0n1 Samsung SSD 990 PRO 2TB nvme
- OS: Linux 7.0.0-43-generic; GPU driver: 580.178.04; CUDA (driver supports up to): 13.0; engine built for CUDA 13.0
- Strata: project 0.1.69, commit not a git checkout; engine 0.1.67
- GPU detail (after the run, near idle): power_limit_w=200.00, power_draw_w=107.54, pcie=gen4 x16, pstate=P2, temp_c=52
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
| short chat | 46 (43-51) | 0 | 100 (100-100) | 9 | not measured | 43.2 (41.3-51.8) | 0.69 (0.62-0.81) |
| 4K prompt, fresh | 4019 (4019-4019) | 0 (0-0) | 24 cap | 3 | 1948.6 (1848.4-1972.2) | not measured | 2.09 (2.07-2.21) |
| 16K prompt, fresh | 16058 (16058-16058) | 0 (0-0) | 24 cap | 3 | 2196.1 (2187.7-2196.7) | not measured | 7.34 (7.34-7.38) |
| agent session, follow-up turns | 14905 (14859-14930) at the last turn | see below | up to 64 | 3 | see below | 49.3 (40.3-55.2) | 2.39 (1.73-3.00) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.9 % (70.9-71.0); earlier-turn tokens read again per session: 5 (5-5) (earlier turns that the cache did not hold; the 14033 (14032-14033) new tokens of the files are read once); first turn (nothing cached) first token: 1.94 s (1.67-1.97). Corpus: `repo_docs` (8ba45cf16bd6) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 609 | 0 | 609 | 372.8 | 1.665 | 42.2 |
| 1 | 5015 | 641 | 4374 | 1475.8 | 2.996 | 47.7 |
| 2 | 6551 | 5078 | 1473 | 858.3 | 1.75 | 42.2 |
| 3 | 9848 | 6614 | 3234 | 1282.8 | 2.559 | 52.7 |
| 4 | 11982 | 9911 | 2071 | 1046.8 | 2.014 | 45.6 |
| 5 | 14930 | 12044 | 2886 | 1229.0 | 2.387 | 47.8 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 122 s.
