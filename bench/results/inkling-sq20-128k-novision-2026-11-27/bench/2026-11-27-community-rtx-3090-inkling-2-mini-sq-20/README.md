# Community benchmark on NVIDIA GeForce RTX 3090

Measured on 2026-11-27 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 3090, 24 GiB VRAM
- CPU: 13th Gen Intel(R) Core(TM) i7-13700K (16 cores, 24 threads); installed RAM: 95.8 GiB; storage: not read
- OS: Windows 11 (10.0.26200); GPU driver: 616.92; CUDA (driver supports up to): 13.4
- Strata: project 0.1.69, commit not a git checkout; engine strata-inkling-0.1.70
- GPU detail (after the run, near idle): power_limit_w=260.00, power_draw_w=254.76, pcie=gen4 x16, pstate=P2, temp_c=59
- Background workloads: not recorded (GPU power limit/draw read above)

## Model and configuration

- Model and quantization: inkling-2-mini-sq-20
- Context: 131072 tokens; parallel slots: 1
- Settings: the install's own configuration, unchanged; thinking off for the suite; temperature 0

## Method

Run by `python tools/strata_bench.py --long` against the HTTP API of a Strata server (already running); model loading is not timed. One warm-up chat and a 1K prompt are discarded first. Every prompt starts with a unique tag, so the conversation cache cannot help the fresh-prompt tests.

- short chat: the three questions of `tools/ab_engine.py`, up to 100 new tokens, 3 runs
- 4K / 16K prompts: generated word lists sized by a calibration request, 24 new tokens, 3 fresh prompts each
- agent session: system prompt and four tools, then 5 turns that each add about 1500 words of a project file and continue from the model's own earlier answers (the way agent clients resend a conversation), 64 new tokens per turn, 3 sessions; the cache numbers come from the answer's usage (`cached_tokens`) and timings (`prompt_n`)
- concurrency (when run): N requests sent at the same moment, total tokens over the wall time of the burst, latency over all requests

## Results

| Configuration | Actual prompt tokens | Reused tokens | Generated tokens | Runs | Prompt tok/s median and range | Decode tok/s median and range | TTFT seconds median and range |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| short chat | 44 (43-50) | 0 | 100 (100-100) | 9 | not measured | 80.2 (79.1-80.5) | 0.11 (0.09-0.12) |
| 4K prompt, fresh | 4075 (4075-4075) | 0 (0-0) | 24 cap | 3 | 2139.9 (2136.6-2141.7) | not measured | 1.94 (1.92-1.95) |
| 16K prompt, fresh | 16128 (16128-16128) | 0 (0-0) | 24 cap | 3 | 2030.1 (2026.5-2031.0) | not measured | 7.99 (7.98-7.99) |
| 32K prompt, fresh | 32208 (32208-32208) | 0 (0-0) | 24 cap | 3 | 1864.2 (1862.7-1865.4) | not measured | 17.34 (17.30-17.34) |
| agent session, follow-up turns | 16127 (16126-16128) at the last turn | see below | up to 64 | 3 | see below | 73.8 (71.9-77.4) | 2.03 (1.13-3.14) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.7 % (70.7-70.8); earlier-turn tokens read again per session: 261 (196-261) (earlier turns that the cache did not hold; the 15268 (15267-15283) new tokens of the files are read once); first turn (nothing cached) first token: 0.41 s (0.40-0.41). Corpus: `repo_docs` (8ba45cf16bd6) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 556 | 0 | 556 | 1367.8 | 0.397 | 80.1 |
| 1 | 5759 | 555 | 5204 | 1658.7 | 3.137 | 77.2 |
| 2 | 7374 | 5758 | 1616 | 1520.7 | 1.131 | 75.0 |
| 3 | 10742 | 7373 | 3369 | 1585.9 | 2.178 | 73.8 |
| 4 | 13037 | 10741 | 2296 | 1538.6 | 1.562 | 73.4 |
| 5 | 16126 | 13083 | 3043 | 1540.4 | 2.024 | 71.9 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 144 s.
