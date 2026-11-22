# Benchmarking a Strata update (llmserver)

How to check whether a new Strata engine is faster on llmserver, and the results of each update. Run it after
`strata-update.md`, once the new engine is in `/home/kevin/Strata/engine-feed/engine/`. The method is devbox's
(`../windows/strata-bench.md`, read its "Method, and why"); this file covers what differs on Linux and the results.

Machine: llmserver, RTX 4070 12 GiB (sm_89, driver 580.178.04, CUDA 13.0), Ryzen 7 5800XT, 64 GB DDR4 at
3000 MT/s (4 x 16 GB, set by hand; `sudo dmidecode -t memory | grep 'Configured Memory Speed'`), Samsung 990 PRO,
Linux 7.0.0-43.
Model: Qwen3.8-Flash-Next IQ3_S, config `/home/kevin/Strata/strata-iq3_s.json`: the config of the 11-16 / 11-17
community reports (131K context, `--spec-min-p 0.5`, `--adapt-swaps 80`, no vision). It is **not** llama-swap's
profile (`Strata-data/qwenflash-st-150k.json`: 150K context, vision, `--pcie-frac 0.55`, `--spec-min-p 0.70`,
`--adapt-swaps 160`). Engine A/B is about the engine, so it keeps the older config for comparison with earlier runs.

## Short version

```sh
~/llm-stuff/llama-swap/linux/strata-bench-ab.sh 0.1.64 0.1.65        # old and new engine versions
```

It stops llama-swap, runs a discarded warm-up, then every engine forward and in reverse, writes
`~/llm-stuff/bench/results/strata-ab-<date>-llmserver/summary.md` and starts llama-swap again. About 2.5 minutes
per run: 7 runs (three engines) take about 17 minutes.

Options (environment): `VARIANTS="0.1.65-sm89off:0.1.65:STRATA_SM89_PERF=0"` adds a run with a switch,
`BASE_CONFIG=...` another config, `WARMUP_RUNS`, `SETTLE_MIN`, `NO_STACK=1` (do not touch llama-swap), `OUT_DIR`.
Versions are folder names in `engine-feed/engine/`; for an older engine, download it from its GitHub release as
devbox does and unpack it there as `<version>-linux-x86_64-cuda-cuda13`.

Then add a section to the results log below and commit the results folder with it.

## Differences from devbox

- Each run gets its own engine log (`runs/<label>.engine.log`), and the summary shows whether the sm_89 speed-switch
  line was printed, so a switch variant can be checked.
- `MemAvailable` is recorded at each start (Linux has no commit limit to read).
- The config's `--expert-profile` is moved to `terminal/data/` if the old `data/` path no longer exists (0.2.16 layout).
- **No slow start seen.** On 2026-11-22 the warm-up, started 5 s after `manage.sh stop`, matched the counted runs
  of the same engine within 1% on prompt speed, and forward and reverse agreed within 1%. MemAvailable stayed at
  58.7-58.9 GiB. One observation; keep the warm-up and both orders anyway.

## Results log

Newest first. Medians; `fwd`/`rev` are the forward and reverse series. Raw logs, per-run reports and `summary.md`
are in the folder named in each section.

### 2026-11-22: 0.2.19 / engine 0.1.65 (from 0.1.64), with 0.1.59

Folder: `bench/results/strata-ab-2026-11-22-llmserver/`. Engines 0.1.59, 0.1.64, 0.1.65 from `engine-feed/engine/`,
defaults (0.1.65 printed `sm_89 (Ada): 11 exact speed switches on` in both runs). Warm-up + 6 runs, 19:08-19:25.

| Metric (fwd / rev) | 0.1.59 | 0.1.64 | 0.1.65 | 0.1.65 vs 0.1.64 |
| --- | ---: | ---: | ---: | ---: |
| 4K prompt tok/s | 1638 / 1626 | 1665 / 1668 | 1482 / 1482 | **-11%** |
| 4K first token (s) | 2.49 / 2.51 | 2.45 / 2.44 | 2.75 / 2.75 | +12% |
| 16K prompt tok/s | 1735 / 1742 | 1835 / 1836 | 2159 / 2155 | **+18%** |
| 16K first token (s) | 9.29 / 9.25 | 8.78 / 8.78 | 7.47 / 7.49 | -15% |
| chat decode tok/s | 41.4 / 41.8 | 42.6 / 41.9 | 42.6 / 41.6 | none |
| chat first token (s) | 0.84 / 0.82 | 0.74 / 0.73 | 0.75 / 0.73 | none |
| agent decode tok/s | 45.5 / 48.9 | 47.8 / 47.8 | 47.5 / 45.8 | none (noise) |
| agent turn first token (s) | 1.61 / 1.60 | 1.55 / 1.57 | 1.52 / 1.52 | -2% |

Result: **long prompts faster, 4K prompts slower, decode unchanged.** Every prompt difference holds in both orders
to within 1%. 0.1.65 against 0.1.59: 16K prompt +24%, 4K prompt -9%. Decode is 41-43 tok/s (chat) and 45-49 tok/s
(agent) on every engine. The release notes' decode gain for Ada does not show here.

Same day, outside the A/B (single forward runs, scratch folder, not committed): 0.1.65 with `STRATA_SM89_PERF=0`
gave 4K 1447, 16K 2139, chat decode 43.2, i.e. the sm_89 switches are worth 1-3% on prompts and nothing measurable
on decode. 0.1.60, 0.1.62 and 0.1.63 matched 0.1.64 (4K 1660-1692, 16K 1835, chat decode 42-43).

Not comparable: the 11-17 hand-run community report (`fork/bench/rtx-4070-coder-iq1m-iq3s`, engine 0.1.59, same
config) gave chat decode 53.4 and agent decode 57.0. 0.1.59 measures 41-43 / 45-49 today with the 0.2.19 bench and
server. Its prompt speeds match today's within 1%. The decode gap is not the engine; it is either the decode noise
(about +/-20%) or the newer bench / server (the agent turns are shorter now). Not investigated.

Kept: 0.1.65 with its defaults. llama-swap's profile was not changed.
