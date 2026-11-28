# Community benchmark on NVIDIA GeForce RTX 3090

Measured on 2026-11-27 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 3090, 24 GiB VRAM
- CPU: 13th Gen Intel(R) Core(TM) i7-13700K (16 cores, 24 threads); installed RAM: 95.8 GiB; storage: not read
- OS: Windows 11 (10.0.26200); GPU driver: 616.92; CUDA (driver supports up to): 13.4
- Strata: project 0.1.69, commit not a git checkout; engine strata-inkling-0.1.70
- GPU detail (after the run, near idle): power_limit_w=260.00, power_draw_w=259.14, pcie=gen4 x16, pstate=P2, temp_c=54
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
| short chat | 44 (43-50) | 0 | 100 (100-100) | 9 | not measured | 80.6 (79.7-81.0) | 0.11 (0.09-0.12) |
| 4K prompt, fresh | 4075 (4075-4075) | 0 (0-0) | 24 cap | 3 | 2165.8 (2165.2-2176.8) | not measured | 1.90 (1.90-1.91) |
| 16K prompt, fresh | 16128 (16128-16128) | 0 (0-0) | 24 cap | 3 | 2052.4 (2048.8-2055.0) | not measured | 7.89 (7.88-7.89) |
| 32K prompt, fresh | 32208 (32208-32208) | 0 (0-0) | 24 cap | 3 | 1889.3 (1881.7-1890.9) | not measured | 17.10 (17.07-17.15) |
| agent session, follow-up turns | 16136 (16127-16144) at the last turn | see below | up to 64 | 3 | see below | 74.9 (72.3-78.4) | 2.01 (1.10-3.13) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.7 % (70.7-70.9); earlier-turn tokens read again per session: 260 (196-261) (earlier turns that the cache did not hold; the 15267 (15266-15283) new tokens of the files are read once); first turn (nothing cached) first token: 0.41 s (0.39-0.41). Corpus: `repo_docs` (8ba45cf16bd6) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 556 | 0 | 556 | 1382.1 | 0.393 | 81.1 |
| 1 | 5756 | 555 | 5201 | 1681.8 | 3.112 | 78.4 |
| 2 | 7371 | 5755 | 1616 | 1530.4 | 1.107 | 75.0 |
| 3 | 10740 | 7370 | 3370 | 1595.4 | 2.184 | 73.3 |
| 4 | 13035 | 10739 | 2296 | 1543.3 | 1.542 | 73.8 |
| 5 | 16136 | 13093 | 3043 | 1556.6 | 2.003 | 72.7 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 143 s.
