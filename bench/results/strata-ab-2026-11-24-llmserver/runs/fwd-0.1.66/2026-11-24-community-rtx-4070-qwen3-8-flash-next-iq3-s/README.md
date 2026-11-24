# Community benchmark on NVIDIA GeForce RTX 4070

Measured on 2026-11-24 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 4070, 12 GiB VRAM
- CPU: AMD Ryzen 7 5800XT 8-Core Processor (8 cores, 16 threads); installed RAM: 60.7 GiB; storage: nvme0n1 Samsung SSD 990 PRO 2TB nvme
- OS: Linux 7.0.0-43-generic; GPU driver: 580.178.04; CUDA (driver supports up to): 13.0; engine built for CUDA 13.0
- Strata: project 0.1.68, commit not a git checkout; engine 0.1.66
- GPU detail (after the run, near idle): power_limit_w=200.00, power_draw_w=111.01, pcie=gen4 x16, pstate=P2, temp_c=53
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
| short chat | 46 (43-51) | 0 | 100 (100-100) | 9 | not measured | 41.3 (39.8-49.9) | 0.71 (0.64-0.81) |
| 4K prompt, fresh | 4019 (4019-4019) | 0 (0-0) | 24 cap | 3 | 1925.5 (1873.7-1977.1) | not measured | 2.12 (2.06-2.18) |
| 16K prompt, fresh | 16058 (16058-16058) | 0 (0-0) | 24 cap | 3 | 2194.2 (2185.7-2194.6) | not measured | 7.35 (7.35-7.38) |
| agent session, follow-up turns | 14834 (14832-14880) at the last turn | see below | up to 64 | 3 | see below | 47.1 (40.9-54.3) | 2.38 (1.74-2.99) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.9 % (70.9-70.9); earlier-turn tokens read again per session: 5 (5-5) (earlier turns that the cache did not hold; the 13995 (13995-13997) new tokens of the files are read once); first turn (nothing cached) first token: 1.90 s (1.67-1.93). Corpus: `repo_docs` (2b296b05373b) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 609 | 0 | 609 | 372.5 | 1.669 | 38.2 |
| 1 | 5017 | 643 | 4374 | 1480.4 | 2.988 | 45.9 |
| 2 | 6553 | 5080 | 1473 | 859.1 | 1.749 | 40.9 |
| 3 | 9850 | 6616 | 3234 | 1270.9 | 2.585 | 41.9 |
| 4 | 11923 | 9890 | 2033 | 1050.7 | 1.972 | 50.7 |
| 5 | 14832 | 11946 | 2886 | 1230.4 | 2.381 | 51.4 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 122 s.
