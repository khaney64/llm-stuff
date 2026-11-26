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

### 2026-11-26: 0.2.22 / engine 0.1.69 (from 0.1.67)

Folder: `bench/results/strata-ab-2026-11-26-llmserver/`. Engines 0.1.67 and 0.1.69 from `engine-feed/engine/`,
defaults. Both print `sm_89 (Ada): 17 speed switches on` in every run. Warm-up + 4 runs, 22:38-22:51.

| Metric (fwd / rev) | 0.1.67 | 0.1.69 | 0.1.69 vs 0.1.67 |
| --- | ---: | ---: | ---: |
| 4K prompt tok/s | 1939 / 1949 | 1936 / 1934 | none (under 1%) |
| 4K first token (s) | 2.10 / 2.09 | 2.11 / 2.11 | none |
| 16K prompt tok/s | 2199 / 2196 | 2195 / 2192 | none |
| 16K first token (s) | 7.34 / 7.34 | 7.35 / 7.36 | none |
| chat decode tok/s | 43.4 / 43.2 | 44.6 / 45.6 | none (+3-6%, under the noise line) |
| chat first token (s) | 0.69 / 0.69 | 0.69 / 0.69 | none |
| agent decode tok/s | 48.3 / 49.3 | 49.6 / 50.3 | none (noise) |
| agent turn first token (s) | 2.38 / 2.39 | 2.38 / 2.38 | none |

Result: **no change on this setup.** 0.1.69's engine work (layer-split lend reservation #7089, Inkling CUDA fixes,
symbol files) does not touch single-card IQ3_S Qwen3.8-Flash-Next on the 4070. Prompts match 0.1.67 within 1% in
both orders; decode is within the ~10% noise line.

Kept: 0.1.69 with its defaults. llama-swap's profile only had its two `exe` paths changed.

### 2026-11-24: 0.2.21.1 / engine 0.1.67 (from 0.1.66)

Folder: `bench/results/strata-ab-2026-11-24-llmserver/`. Engines 0.1.66 and 0.1.67 from `engine-feed/engine/`,
defaults. Both print `sm_89 (Ada): 17 speed switches on` in every run. Warm-up + 4 runs, 18:50-19:02.

| Metric (fwd / rev) | 0.1.66 | 0.1.67 | 0.1.67 vs 0.1.66 |
| --- | ---: | ---: | ---: |
| 4K prompt tok/s | 1926 / 1919 | 1940 / 1933 | +1% |
| 4K first token (s) | 2.12 / 2.12 | 2.10 / 2.11 | none |
| 16K prompt tok/s | 2194 / 2193 | 2197 / 2196 | none |
| 16K first token (s) | 7.35 / 7.36 | 7.34 / 7.35 | none |
| chat decode tok/s | 41.3 / 42.2 | 43.9 / 44.0 | none (+4-6%, under the noise line) |
| chat first token (s) | 0.71 / 0.71 | 0.69 / 0.70 | none |
| agent decode tok/s | 47.1 / 49.1 | 50.3 / 47.8 | none (noise) |
| agent turn first token (s) | 2.38 / 2.39 | 2.39 / 2.38 | none |

Result: **no change on this setup.** 0.1.67's work (Inkling CUDA K/V, sm_120 prefetch, 64-token-tile prefill MoE
for sm_80..89, DSpark slot choice) does not move IQ3_S Qwen3.8-Flash-Next on the 4070. Prompt speeds match 0.1.66
within 1% in both orders; decode is within the ~10% noise line.

Kept: 0.1.67 with its defaults. llama-swap's profile only had its two `exe` paths changed.

### 2026-11-23: 0.2.20 / engine 0.1.66 (from 0.1.65), with 0.1.59 and two variants

Folder: `bench/results/strata-ab-2026-11-23-llmserver/`. Engines 0.1.59, 0.1.65, 0.1.66 with their defaults, plus
two 0.1.66 variants: `sm89old` = `STRATA_L2_PF=1,STRATA_QFUSE=1` (the two switches 0.1.66 took out of the sm_89
defaults, #6431 / #6583) and `chunk32k` = `STRATA_NV_CHUNK=1` (lifts 0.1.66's new 8192 cap on bare `--prefill auto`
for cards of 16.5 GiB or less, #5199). Warm-up + 10 runs, 00:30-00:58.

0.1.66 prints `sm_89 (Ada): 17 speed switches on` (no "exact": it adds `ADAPT_FETCH=2` for cards of 16 GiB or less,
which is not bit-exact). The list: ADAPT_LAG ATTN_DAILY GR_UP75 GU_SWIGLU QSA_ROWS B6_MMVQ_ROWS HC_UPMIX Q80_ROWS1
EXP_MODE SIDE_MIXER DEQUANT_SIDE LFUSE PLE_COMPACT PLE_COPY_STREAM PREFILL_CPU_SHARE_NT PREFILL_CPU_SHARE_MAX
ADAPT_FETCH. 0.1.65 had 11, including L2_PF and QFUSE. The script's grep only knew the "exact" wording and
reported "none" for 0.1.66; fixed in the script, and this run's `summary.md` / `runs.jsonl` were corrected by hand.

| Metric (fwd / rev) | 0.1.59 | 0.1.65 | 0.1.66 | 0.1.66 vs 0.1.65 | sm89old | chunk32k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4K prompt tok/s | 1619 / 1624 | 1479 / 1483 | 1937 / 1938 | **+31%** | 1931 / 1934 | 1925 / 1932 |
| 4K first token (s) | 2.51 / 2.51 | 2.75 / 2.74 | 2.11 / 2.10 | -23% | 2.11 / 2.11 | 2.12 / 2.11 |
| 16K prompt tok/s | 1735 / 1754 | 2155 / 2155 | 2195 / 2193 | +2% | 2194 / 2189 | 2190 / 2192 |
| 16K first token (s) | 9.29 / 9.19 | 7.49 / 7.49 | 7.35 / 7.35 | -2% | 7.35 / 7.37 | 7.37 / 7.36 |
| chat decode tok/s | 40.8 / 43.6 | 42.0 / 43.1 | 41.0 / 41.8 | none (noise) | 42.6 / 41.6 | 42.6 / 44.3 |
| chat first token (s) | 0.83 / 0.83 | 0.74 / 0.74 | 0.71 / 0.70 | -4% | 0.71 / 0.71 | 0.71 / 0.71 |
| agent decode tok/s | 44.8 / 47.8 | 46.9 / 49.3 | 50.1 / 49.3 | none (noise) | 50.0 / 47.9 | 47.1 / 47.5 |
| agent turn first token (s) | 2.36 / 2.37 | 2.43 / 2.44 | 2.44 / 2.44 | none | 2.42 / 2.44 | 2.43 / 2.44 |

Result: **4K prompts +31%, 16K prompts +2%, decode unchanged.** 0.1.65's 4K regression is gone: 0.1.66 against
0.1.59 is 4K +19%, 16K +25%. Every prompt difference holds in both orders to within 1%.

Variants: **neither changes anything here.** Both are within 0.5% of 0.1.66 defaults on prompts; decode differences
(up to 6%) are under the ~10% noise line and do not hold in both directions. Putting L2_PF and QFUSE back does not
bring back the decode loss upstream measured, nor any gain. The chunk cap does nothing on this setup: in serve mode
every 0.1.66 run, capped or not, logged `small expert cache ... prompt chunk auto: 4864 tokens` (the 4070 holds 1,609
of 24,576 experts), so the 8192 vs 32768 ceiling is never reached.

Not comparable to 11-22: "agent turn first token" is 2.4 s for every engine today (1.5-1.6 s on 11-22, 0.1.59
included). The bench tool in the 0.2.20 checkout changed; prompt speeds of 0.1.59 and 0.1.65 match 11-22 within 1%.

Kept: 0.1.66 with its defaults. llama-swap's profile uses bare `--prefill auto`; no `STRATA_NV_CHUNK` needed.

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
