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

The run that counts (used from 2026-11-24): llama-swap's 1600 MiB reserve (item 7), a 15-minute settle and two
warm-ups, so the slow start cannot reach the measured runs. About 30 minutes:

```powershell
$Out = "C:\development\ai\llm-stuff\bench\results\strata-ab-$(Get-Date -Format yyyy-MM-dd)-<new>-r1600"
New-Item -ItemType Directory -Force $Out | Out-Null
$c = Get-Content C:\development\ai\Strata\terminal\strata-iq3_s.json -Raw | ConvertFrom-Json
$i = [array]::IndexOf($c.args, '--vram-reserve-mib'); $c.args[$i + 1] = '1600'
$c | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM "$Out\base-iq3_s-r1600.json"
& C:\development\ai\llm-stuff\llama-swap\windows\strata-bench-ab.ps1 -BaseConfig "$Out\base-iq3_s-r1600.json" `
    -OutDir $Out -SettleMinutes 15 -WarmupRuns 2
```

Read the two warm-up columns first. If the 4K prompt there is far below the measured columns (under about
1800 tok/s), the slow state reached the bench: check that forward and reverse still agree.

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
7. **Bench at llama-swap's VRAM reserve.** The default config reserves 700 MiB. At that reserve an engine without
   the 0.1.66 WDDM floor can fill the card so far that Windows pages GPU memory to RAM, and prompt speed falls by a
   third (2026-11-22 evening). Pass a copy of the config with `--vram-reserve-mib 1600` as `-BaseConfig`, like
   `bench\results\strata-ab-2026-11-22-0.1.66-r1600\base-iq3_s-r1600.json`.
8. **Don't compare with `docs\bench-results\` in the Strata checkout.** That is where the bench writes when run
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

On 2026-11-24, with a 15-minute settle after `manage.ps1 stop`, it did not happen: the first warm-up already gave
4K 1860 tok/s and 16K 2754 tok/s, within 2% of the measured runs. `mem.csv` in that run's folder logs memory every
30 s. What it showed:

- Just before the stop, llama-swap's engine left 1.1 GiB of commit free. The pagefile had peaked at its full
  32 GB at some point, and the Memory Compression store held 5.5 GB.
- Within 10 s of the stop, free RAM was 67.6 GiB and free commit 68.2 GiB. The pagefile was back to 1.6 GB and
  nothing was paging in afterwards. The compression store only shrank to 5.3 GB over the 15 minutes.
- Every bench engine took free commit down to 0.1-1.1 GiB while it ran (both engines), and free RAM to 12-15 GiB.
  So each run sits at the commit limit, as llama-swap does. Whether the slow start needs that and something
  else at the same time is still unknown.

Still not checked: whether it happens every time without a settle. To check, run the script with
`-SettleMinutes 0 -WarmupRuns 0` straight after a stop and see whether the forward and reverse numbers agree.

## Results log

Newest first. Medians; `fwd`/`rev` are the forward and reverse series. Raw logs, `results.json` and per-run reports
are in the folder named in each section.

### 2026-11-27: Inkling-2-Mini SQ-20 at 128K (engine strata-inkling 0.1.70)

A different family, not an engine A/B. Goal: coding sessions at 128K or more (Hermes compacts at 75%).
Folders: `bench\results\inkling-sq20-128k-2026-11-27\` (pictures on) and
`bench\results\inkling-sq20-128k-novision-2026-11-27\` (`--vision off`). Each has `bench\` (strata_bench.py
`--long`), `needles.json` and the logs.

Set up with `strata launch --family inkling-2-mini --model SQ-20 --context 128k --port 8090` from the source
checkout (Strata 0.2.22). Inkling has its own engine package in
`%LOCALAPPDATA%\Strata\components\shapes\inkling2\engine\`; `terminal\engine` is not used. llama-swap was stopped
from 21:45. The benches ran from about 22:05, so after the slow-start window. One run of each setup, run against the
launched server with `--url`, so the server's settings are the launch's, not `strata-iq3_s.json`'s.

| Metric | pictures on | pictures off | qwenflash-st 0.1.69 (11-26, fwd) |
| --- | ---: | ---: | ---: |
| chat decode tok/s | 80.6 | 80.2 | 91.5 |
| chat first token (s) | 0.11 | 0.11 | 0.38 |
| 4K prompt tok/s | 2166 | 2140 | 1951 |
| 16K prompt tok/s | 2052 | 2030 | 2698 |
| 16K first token (s) | 7.89 | 7.99 | 5.99 |
| 32K prompt tok/s | 1889 | 1864 | - |
| 32K first token (s) | 17.10 | 17.34 | - |
| agent decode tok/s | 74.9 | 73.8 | 103.9 |
| agent turn first token (s) | 2.01 | 2.03 | 1.88 |
| agent cache hit % | 70.7 | 70.7 | - |

Long context, `tools\needle_bench.py --lengths 32k,64k,120k --depths 10,50,90` (thinking at the model's default,
`low`). Time is the whole request:

| Prompt tokens | Found | Time, pictures on / off |
| ---: | :---: | ---: |
| 34,461 | 3 of 3 | 23 / 23 s |
| 66,580 | 3 of 3 | 51 / 52 s |
| 126,307 | 3 of 3 | 131 / 132 s |

Result: **it works at 128K on the 3090, with one limit**. All the experts fit on the card (`experts=3072 VRAM / 0
host`, 14.66 GB), but the conversation memory does not: `global KV = 47360 VRAM + 83712 mapped host tokens (2616
MiB host RAM)`. Prompt reading falls from about 2,170 tok/s at 4K to about 960 tok/s at 126K (prompt tokens over the
whole request time), so a cold read of a full 128K conversation takes about 2 minutes. Recall held at every depth. The
server also cut the prompt chunk to 512 tokens (`4025 MiB free after the experts`).

- **Pictures off changes nothing.** The picture reader goes on the card only with the first picture, so free VRAM
  after load was 4025 MiB with pictures on and 4030 MiB with them off. The two columns are within 1-2%, which is
  also this bench's run-to-run spread.
- **DSpark drafting is off.** launch's probe measured 0.99x (32K) and 1.00x (128K) at about 80 tok/s plain decoding,
  below its 1.10x bar. The docs say it pays off on cards that keep experts in RAM, not on this one.
- **Not tried yet:** `--kv q4_0` (about twice the tokens on the card), and 150-160K context (launch's plan accepts
  160K; more of the conversation would go to RAM).

Kept: `Strata-data\inkling.json` (the launch's run config: SQ-20, 131072 context, `--vram-experts-gb 14.66`,
drafting off, no picture reader, port 8082) behind llama-swap as model `inkling` in `configs\devbox.yaml`. Through
llama-swap the first request took 28 s including the load, and the engine log gave the same split (48128 VRAM +
82944 host tokens).

### 2026-11-26: 0.2.22 / engine 0.1.69 (from 0.1.67)

Folder: `bench\results\strata-ab-2026-11-26-0.1.69-r1600\`. The standard run: `--vram-reserve-mib 1600`
(`base-iq3_s-r1600.json`, its args identical to the 11-24 run's), a 15-minute settle, 2 discarded warm-ups (0.1.67).
No slow start: the warm-ups gave 4K 1927 / 1917 tok/s.

| Metric (fwd / rev) | 0.1.67 | 0.1.69 |
| --- | ---: | ---: |
| 4K prompt tok/s | 1944 / 1982 | 1951 / 1941 |
| 16K prompt tok/s | 2703 / 2712 | 2698 / 2712 |
| 16K first token (s) | 5.97 / 5.96 | 5.99 / 5.96 |
| chat decode tok/s | 90.9 / 87.4 | 91.5 / 89.8 |
| chat first token (s) | 0.39 / 0.39 | 0.38 / 0.37 |
| agent decode tok/s | 102.0 / 101.3 | 103.9 / 102.9 |
| agent turn first token (s) | 1.94 / 1.86 | 1.88 / 1.90 |

Result: **no measurable change**, as expected: 0.2.22 has no Qwen engine change on NVIDIA. No difference holds in
both orders. 0.1.67's last run (rev) read 4K 2% higher than its first, and 0.1.69 sat between the two. Both
engines turn on the same 17 sm_86 switches, with 7,376-7,444 expert cache slots. No WDDM or low-VRAM warnings.

From 0.2.22 the server sizes the conversation cache from free RAM (#7044). Here that gave 4096-5120 MiB, varying
from start to start, and the same for both engines, because the server, not the engine, decides it. llama-swap's
profile gets the same (4096 MiB at the first start). Free commit during the runs was 0.4-1.6 GiB, about the same as
on 11-24 (0.1-1.1 GiB, before this change), so the cache did not make the commit limit worse.

The pagefile held 3.8 GB when the stack was stopped, before the bench started. That was left over from two days of
llama-swap running, and the cause is not known. It reached 6.2 GB during the bench. The bench numbers match 0.1.67,
so this is an observation, not a change between versions.

Kept: 0.1.69 with its defaults. Nothing was changed in the profile.

### 2026-11-24: 0.2.21 / engine 0.1.67 (from 0.1.66)

Folder: `bench\results\strata-ab-2026-11-24-0.1.67-r1600\`. Config `--vram-reserve-mib 1600`
(`base-iq3_s-r1600.json`, otherwise the same as `terminal\strata-iq3_s.json`). It ran after a 15-minute settle,
with 2 discarded warm-ups (0.1.66), and llama-swap was stopped throughout.

| Metric (fwd / rev) | 0.1.66 | 0.1.67 |
| --- | ---: | ---: |
| 4K prompt tok/s | 1886 / 1902 | 1897 / 1887 |
| 16K prompt tok/s | 2753 / 2739 | 2748 / 2741 |
| 16K first token (s) | 5.86 / 5.90 | 5.88 / 5.89 |
| chat decode tok/s | 93.8 / 91.8 | 93.0 / 91.4 |
| chat first token (s) | 0.38 / 0.37 | 0.37 / 0.37 |
| agent decode tok/s | 106.4 / 105.7 | 101.1 / 101.9 |
| agent turn first token (s) | 1.89 / 1.89 | 1.87 / 1.90 |

Result: **no measurable change**, as the release notes say for Qwen. Prompt speed and first-token times match within
1%. Agent decode is 4-5% lower in both orders, but its ranges are ±20% (81-131 tok/s), so that is noise. Both
engines turn on the same 17 sm_86 switches. Expert cache: 7,330-7,439 slots on 0.1.66 and 7,439-7,524 on 0.1.67
(it varies from start to start). No WDDM or low-VRAM warnings were logged. 0.1.67's Qwen change is an accuracy
fix in prompt reading (#6776), which can change answers after a few tokens. This bench does not check answers.

Kept: 0.1.67 with its defaults. Nothing was changed in the profile.

### 2026-11-22 (evening): 0.2.20 / engine 0.1.66 (from 0.1.65)

Two runs, both with `STRATA_SM86_PERF=0` on 0.1.66 as a variant:

- `bench\results\strata-ab-2026-11-22-0.1.66\`: the default bench config (`--vram-reserve-mib 700`), after a
  15-minute settle.
- `bench\results\strata-ab-2026-11-22-0.1.66-r1600\`: the same config with `--vram-reserve-mib 1600`, as in
  llama-swap's `qwenflash-st.json` (`base-iq3_s-r1600.json` in the folder). **This is the one that counts.**

At 1600 MiB (fwd / rev):

| Metric | 0.1.65 | 0.1.66 | 0.1.66 sm86off |
| --- | ---: | ---: | ---: |
| 4K prompt tok/s | 1935 / 1943 | 1902 / 1907 | 1913 / 1919 |
| 16K prompt tok/s | 2697 / 2651 | 2753 / 2732 | 2721 / 2711 |
| 16K first token (s) | 5.98 / 6.10 | 5.86 / 5.91 | 5.93 / 5.97 |
| chat decode tok/s | 98.3 / 89.5 | 96.3 / 88.4 | 79.8 / 77.0 |
| chat first token (s) | 0.36 / 0.36 | 0.37 / 0.39 | 0.43 / 0.44 |
| agent decode tok/s | 104.5 / 106.2 | 102.7 / 99.4 | 92.5 / 93.8 |
| agent turn first token (s) | 1.97 / 1.96 | 1.91 / 1.93 | 2.00 / 2.00 |

Result: **no measurable change at llama-swap's settings.** 0.1.66 against 0.1.65: 4K prompt -2%, 16K prompt +2-3%,
decode the same within noise. The release notes' CUDA speedups do not show here.

`STRATA_SM86_PERF=0` (all 17 sm_86 switches off): prompt speed the same, chat decode 13-17% lower and agent decode
6-10% lower in both orders, and the same direction in the 700 MiB run. The switches help decode; keep them on.

At 700 MiB, 0.1.66 read +45% (4K) and +54% (16K) over 0.1.65, in both orders. That is the reserve, not the engine:

- 0.1.66 adds a Windows WDDM floor: `keeping 1280 MiB VRAM reserve (was 700 MiB) so the driver does not page GPU
  memory to host RAM`, so it ran with ~7,570 expert slots. 0.1.65 kept 700 MiB and filled 8,251 slots (15.65 GiB),
  and its 4K prompt fell to 1320 tok/s.
- That morning, 0.1.65 with the same 700 MiB config measured 1957 tok/s. Its engine log was not kept, so why it did
  not page then is not known (free VRAM at start decides the slot count).
- Even at 1600 MiB, 0.1.65 warned twice that under 1024 MiB of VRAM was free at the start of a request. 0.1.66
  did not.

The server picks `--draft-conf` from the slot count (`CONF_STEPS` in `terminal\strata_control\drafting.py`): 0.5 at
700 MiB, 0.7 at 1600 MiB. That is one more reason to bench at the reserve llama-swap uses.

From 0.2.20, `strata_bench.py`'s agent test sends the repo's own documents instead of generated filler (#6628), so
agent rows are not comparable with earlier sections (agent first token 1.15 s -> 1.9 s on the same engine).

Kept: 0.1.66 with its defaults. Nothing was changed in the profile.

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
