# Community benchmark on NVIDIA GeForce RTX 3090

Measured on 2026-11-26 with `tools/strata_bench.py` (suite 1, 3 runs per test, medians with ranges). Speeds are the engine's own timings; first-token times are measured by the client over HTTP. Speed only: no correctness check was run.

## Hardware and software

- GPU and VRAM: NVIDIA GeForce RTX 3090, 24 GiB VRAM
- CPU: 13th Gen Intel(R) Core(TM) i7-13700K (16 cores, 24 threads); installed RAM: 95.8 GiB; storage: not read
- OS: Windows 11 (10.0.26200); GPU driver: 616.92; CUDA (driver supports up to): 13.4; engine built for CUDA 13.0
- Strata: project 0.1.69, commit not a git checkout; engine 0.1.67
- GPU detail (after the run, near idle): power_limit_w=260.00, power_draw_w=245.00, pcie=gen4 x16, pstate=P2, temp_c=54
- Background workloads: not recorded (GPU power limit/draw read above)

## Model and configuration

- Model and quantization: qwen3.8-flash-next-iq3_s
- Context: 204800 tokens; parallel slots: 1
- Settings: the install's own configuration, unchanged; thinking off for the suite; temperature 0

```text
strata.exe --pack iq3_s --native Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf --ple-gguf Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf --expert-profile expert-profile.bin --expert-cache auto --prefill auto --spec 4 --mtp rt --max-context 204800 --kv int8 --kv-resident 32768 --vision --vram-reserve-mib 1600 --spec-min-p 0.5 --pool-workers 10 --adapt-every 1 --adapt-swaps 160 --adapt-decay 0.97
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
| short chat | 46 (43-51) | 0 | 100 (100-100) | 9 | not measured | 90.9 (71.6-110.2) | 0.39 (0.35-0.44) |
| 4K prompt, fresh | 4019 (4019-4019) | 0 (0-0) | 24 cap | 3 | 1943.7 (1921.8-1950.9) | not measured | 2.10 (2.10-2.13) |
| 16K prompt, fresh | 16058 (16058-16058) | 0 (0-0) | 24 cap | 3 | 2703.0 (2694.0-2725.3) | not measured | 5.97 (5.92-5.98) |
| agent session, follow-up turns | 14904 (14894-14921) at the last turn | see below | up to 64 | 3 | see below | 102.0 (79.2-117.2) | 1.94 (1.28-2.19) |

Ranges are the lowest and highest of the runs; `Runs` counts requests that returned a token.

### Agent session (conversation cache)

Cache hit over the follow-up turns: 70.9 % (70.9-70.9); earlier-turn tokens read again per session: 5 (5-5) (earlier turns that the cache did not hold; the 14032 (14032-14033) new tokens of the files are read once); first turn (nothing cached) first token: 1.24 s (1.18-1.29). Corpus: `repo_docs` (8ba45cf16bd6) [README.md, docs/HOW_IT_WORKS.md, docs/DETAILS.md, docs/INSTALL.md, docs/MODELS.md].

| Turn (run 1) | Prompt tokens | Reused | Read | Prompt tok/s | First token (s) | Decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 609 | 0 | 609 | 532.2 | 1.177 | 69.2 |
| 1 | 5007 | 633 | 4374 | 2038.6 | 2.186 | 86.1 |
| 2 | 6543 | 5070 | 1473 | 1085.4 | 1.389 | 79.2 |
| 3 | 9840 | 6606 | 3234 | 1641.4 | 2.001 | 87.6 |
| 4 | 11965 | 9895 | 2070 | 1292.5 | 1.633 | 113.7 |
| 5 | 14894 | 12008 | 2886 | 1509.4 | 1.944 | 93.6 |

Per-request data: `results.json`. Engine log lines from the start: `engine-log-excerpt.txt` (when this run started the server).

## Correctness and limitations

Not measured: this is a speed suite. The conversation uses the model's own replies, so token counts differ a little between runs. Machine details come from the server, `nvidia-smi`/`rocm-smi` and the OS; background load is not recorded. Total time of the suite: 83 s.
