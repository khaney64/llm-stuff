# Benchmarking a Strata update (devbox)

How to check whether a new Strata engine is faster on devbox, and the results of each update. Run it after
`strata-update.md`, when `terminal\engine` holds the new engine and `terminal\engine\.previous` the old one.

Machine: devbox, RTX 3090 24 GiB (sm_86, driver 616.92), i7-13700K, 96 GiB RAM, 2x Samsung 990 PRO, Windows 11.
Model: Qwen3.8-Flash-Next IQ3_S, config `C:\development\ai\Strata\terminal\strata-iq3_s.json` (DFlash2 drafting,
`--vram-reserve-mib 700`). This is the config `tools\strata_bench.py` picks by default. It is close to llama-swap's
`Strata-data\qwenflash-st.json`, but not the same (that one reserves 1600 MiB of VRAM).

## Short version

In an **admin** PowerShell:

```powershell
& C:\development\ai\llm-stuff\llama-swap\windows\strata-bench-ab.ps1
```

It stops llama-swap, then benches the old and the new engine back to back: a discarded warm-up, then old → new,
then new → old. It writes everything to `llm-stuff\bench\results\strata-ab-<date>\` (`summary.md` is the table)
and starts llama-swap again. About 2 minutes per run, so about 12 minutes for two engines.

Then add a section to the results log below and commit `bench\results\strata-ab-<date>\` with it.

## Method, and why

1. **Same day, same config, only the engine changes.** The script writes one copy of the bench config per engine
   whose `exe` and `vision.exe` point at that engine's folder. `terminal\engine` is never swapped, and llama-swap
   is never pointed at an old engine.
2. **Both orders.** Every engine runs once forward and once in reverse. Only a difference that holds in both orders
   counts. On 2026-11-22 the forward series alone made the same engine look up to 2x slower or faster depending
   on its place in the queue (see "Slow start").
3. **Throw away the first run.** `-WarmupRuns 1` (the default) runs the first engine once and does not count it.
   If the forward and reverse numbers for one engine still differ by more than a few percent, run again, with
   `-SettleMinutes 15`.
4. **What the bench measures** (`terminal\tools\strata_bench.py`, suite 1, 3 runs per test, thinking off,
   temperature 0): short chat decode (100 tokens), 4K and 16K fresh prompts (prompt speed, first token), and a
   5-turn agent session with four tools (cache reuse, first token per turn, decode). Prompt speed has tight
   ranges (±2%). Decode ranges are wide (±20%), so a decode difference under about 10% is noise.
5. **Older engines.** Only one old engine is kept (`engine\.previous`). For one before that, download it from its
   GitHub release, check it, unpack it into its own folder and pass it with `-Engines`:

   ```powershell
   gh release download v0.2.16 -R Niko1221/Strata -p "strata-engine-0.1.62-windows-x86_64-cuda-cuda13.tar.gz" -p SHA256SUMS.txt
   # compare (Get-FileHash <file>).Hash with SHA256SUMS.txt, then:
   tar -xzf strata-engine-0.1.62-windows-x86_64-cuda-cuda13.tar.gz -C C:\temp\eng-0.1.62
   ```

   Which release holds which engine: `gh release view <tag> -R Niko1221/Strata --json assets -q '.assets[].name'`.
6. **Switches.** To test an environment switch, add a variant, for example
   `-Variants @(@{ name = "0.1.65-sm86off"; engine = "0.1.65"; env = @{ STRATA_SM86_PERF = "0" } })`.
   The engine log names the switches that are on by default (`sm_86 (Ampere): N exact speed switches ...`).
7. **Don't compare with `docs\bench-results\` in the Strata checkout.** That is where the bench writes when run
   by hand. The 2026-11-18 report there (0.1.62, 923 tok/s at 4K) was very likely taken in the slow state: 0.1.62
   measured 1935 tok/s at 4K on 2026-11-22.

## Slow start

On 2026-11-22, right after llama-swap was stopped, the bench ran slow for about 15 minutes and recovered in steps
over several separate server starts: 4K prompt 651 → 865 → 907 → 1256 → 1250 → 1942 tok/s, then 1930-1960 for
the next five runs, whatever the engine. Each run starts a new server, so this was the machine's state, not the
engine warming up. The cause is not known:

- nothing is saved between runs (only per-process conversation spill files), and the experts are read into RAM
  unbuffered (`expert arena read unbuffered`), not through the file cache;
- the System, Application, Defender and Task Scheduler event logs show nothing for 13:15-13:45;
- the engine logs in the slow window show Windows memory commit almost used up (0.3-1.2 GiB left) and, on one run,
  low-VRAM warnings. The killed llama-swap engine had about 50 GB of RAM pinned. This is a guess, not a finding.

Not yet checked: whether it happens every time after `manage.ps1 stop`. To check, run the script with
`-WarmupRuns 0` straight after a stop and look at whether the forward and reverse numbers agree.

## Results log

Newest first. Medians; `fwd`/`rev` are the forward and reverse series. Raw logs, `results.json` and per-run reports
are in the folder named in each section.

### 2026-11-22: 0.2.19 / engine 0.1.65 (from 0.1.64)

Folder: `bench\results\strata-ab-2026-11-22\`. Engines 0.1.62 (v0.2.16 release), 0.1.64 (`engine\.previous`),
0.1.65 (`engine`), and 0.1.65 with `STRATA_VERIFY_DEVICE_HITS=0` (a new sm_86 default that sets `pcie_frac` to 0).
This run was done by hand before the script existed, and its forward series was in the slow state. Only the reverse
series is clean:

| Metric (reverse series) | 0.1.62 | 0.1.64 | 0.1.65 | 0.1.65 vdh0 |
| --- | ---: | ---: | ---: | ---: |
| 4K prompt tok/s | 1935 | 1928 | 1957 | 1940 |
| 16K prompt tok/s | 2614 | 2632 | 2685 | 2690 |
| 16K first token (s) | 6.19 | 6.14 | 6.03 | 6.00 |
| chat decode tok/s | 89.1 | 95.3 | 100.0 | 89.9 |
| chat first token (s) | 0.39 | 0.40 | 0.35 | 0.39 |
| agent decode tok/s | 116.3 | 110.4 | 118.8 | 118.3 |
| agent turn first token (s) | 1.17 | 1.16 | 1.15 | 1.15 |

Result: **no measurable change.** 0.1.65 against 0.1.62: prompt +1% (4K) and +3% (16K), chat decode +12% (inside
the decode noise), agent decode +2%. The release notes claim +12-26% prompt and +13-20% decode for RTX 30 cards
(sm_86); this box does not show it. `STRATA_VERIFY_DEVICE_HITS=0` made no difference. In the slow window
`STRATA_SM86_PERF=0` (all 14 sm_86 switches off) gave 4K 865 tok/s and chat decode 39 tok/s; that run was not
repeated in a clean state.

Kept: 0.1.65 with its defaults. Nothing was changed in the profile.
