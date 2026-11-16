# Dual RTX 3090 on devbox

Bring-up runbook for the second 3090 (48 GB total). Covers burn-in inside the
30-day return window, llama.cpp multi-GPU configuration, and the models chosen
for the coding bench.

Host: ASRock B760 Pro RS, i7-13700K, 96 GB RAM, NVIDIA driver 616.92.
The existing card (`GPU-9aaead17-d9f2-e568-0acf-f9e26133ef52`) is GPU 0 today, in
PCIe 01:00.0 (Gen4 x16), capped at 260 W by
`C:\development\ai\llama.cpp\pre-built\cap-3090-power.bat`. For airflow it moves
to the chipset slot and becomes **GPU 1**. The new card goes in 01:00.0 and
becomes **GPU 0**. Its sysmetrics history is relabelled to match; see
[Metrics history retag](#metrics-history-retag-sysmetrics-gpu-tag).

## Before installing

- **PSU.** Two stock 3090s draw 350 W each, with transient spikes near 600 W,
  and the 13700K adds up to ~250 W. You need 1000 W or more to run both cards
  at stock, or 850 W once both are capped at 260 W. Use a separate PCIe cable
  for each 8-pin connector, not the daisy-chained pigtail.
- **Slot.** The B760 Pro RS's second full-length slot is wired from the chipset
  (expect PCIe 4.0 x4; check the manual). For llama.cpp `--split-mode layer`,
  this is fine: only activations cross the bus. It rules out
  `--split-mode row`/`tensor`.
- **Airflow.** 3090s are 3-slot cards. If the board allows a gap between them,
  leave one. Otherwise the top card breathes the bottom card's exhaust; watch
  its temperatures closely during step 5.
- **Tools.** Install HWiNFO64 and OCCT. HWiNFO is the only easy way to read
  **GPU Memory Junction Temperature** (GDDR6X). NVML/`nvidia-smi` and
  `sysmetrics` don't expose it on GeForce cards.

## Burn-in (new card = GPU 0)

`cap-3090-power.bat` now caps both indexes at 260 W. For burn-in, run the new
card at **stock** so any marginal hardware shows up while it can still be
returned: `nvidia-smi -i 0 -pl 350`. Re-run the bat when burn-in is done.

1. **Detect.**
   ```
   nvidia-smi --query-gpu=index,name,pci.bus_id,pcie.link.gen.current,pcie.link.width.current,power.limit,vbios_version --format=csv
   llama-server.exe --list-devices        # expect CUDA0 and CUDA1, ~24 GB each
   ```
   Link width reads low at idle. Re-check it under load.
2. **VRAM test.** OCCT → Memory/VRAM, select GPU 0, test all 24 GB, 30–60 min.
   The pass mark is **0 errors**. Any error is grounds to return the card.
3. **Thermal/stability stress.** Run OCCT 3D Adaptive, or 3DMark Time Spy
   Extreme Stress Test (20 loops, ≥ 97% frame-rate stability), for 30–60 min.
   Watch these in HWiNFO:

   | Sensor | Good | Concern |
   |---|---|---|
   | GPU core | < 80 °C | > 83 °C (thermal target) |
   | GPU hotspot | < 95 °C | > 105 °C, or hotspot − core > 20 °C (paste/mount) |
   | Memory junction | < 95 °C | ≥ 104 °C sustained; 110 °C throttles (tired pads) |
   | Fans | steady | rattle/grind, or 100% fan just to hold temperatures |

   Also check: no driver resets (Event Viewer → System, source `nvlddmkm`), no
   WHEA errors, no visual artifacts. Note any coil whine.
4. **Real-workload soak, GPU 0 only, 2–4 h.** Pin a model to the new card, for
   example `$env:CUDA_VISIBLE_DEVICES=0` before launching `server.ps1 -Model qwen38-27b`,
   and loop long-context requests through it. Log while it runs:
   ```
   nvidia-smi dmon -i 0 -s pucvmet -d 5 > burnin-gpu0.log
   nvidia-smi -q -d PERFORMANCE -i 0     # throttle reasons: expect only SW power cap / idle
   ```
5. **Both cards together, 2+ h.** Load a dual-GPU profile (`qwen38-27b-q6` or
   `nemotron-bolt`) and repeat the soak. This tests PSU headroom with both
   cards loaded, and whether the top card heat-soaks.
6. **Long tail.** Keep `sysmetrics` running for the whole return window. It
   writes per-GPU `temp_c`, `power_w`, `fan_pct`, clocks and PCIe throughput
   tagged `gpu=0|1` and the card's `gpu_uuid`. A slow upward creep in GPU 0's temperatures at the same
   load is the thing to catch before day 30.
7. **Finish.** Run `cap-3090-power.bat` (260 W on both), confirm the cap with
   `nvidia-smi -q -d POWER`, and re-check temperatures at the cap.

### Results

| Date | Test | GPU | Duration | Peak core / hotspot / mem-junction | Errors / notes |
|---|---|---|---|---|---|
| 2026-11-12 | llama-bench Qwen3.8-27B Q4, pp4096/tg512, 260 W cap | 0 | 3 min (stopped) | 87.9 / 105.5 / 68 °C | Thermal limit (88 °C) within ~25 s at 100% fan (~4,900 rpm); SM clock fell to ~350 MHz at ~195 W. Hotspot − core ~19 °C. GPU 1 idle at 27 °C throughout. Cooling fault suspected |
| 2026-11-12 | Same llama-bench, `-r 30`, 260 W cap (baseline, old FE) | 1 | 12 min | 56 / 71 / 96 °C | pp4096 1409.6 ± 8.5 t/s, tg512 38.8 ± 0.4 t/s. Power-limited (no thermal limit), fan ≤ 57%, ~1,180 MHz average. GPU 0's estimated pp from its stopped run is ~350–400 t/s |
| | OCCT VRAM | 0 | | | |
| | OCCT 3D / Time Spy | 0 | | | |
| | llama soak | 0 | | | |
| | llama soak, both | 0+1 | | | |

## Metrics history retag (sysmetrics `gpu` tag)

sysmetrics tags each card by its NVML index (`gpu`, plus `topic`
`metrics/<host>/gpu/<idx>`). When the old card moves from index 0 to index 1,
its history has to move with it, or it would read as the new card's history.
InfluxDB can't edit tags in place, so `sysmetrics/retag-gpu.js` copies the
points with the new tags and then deletes the old series. The proxy's `llm`
bucket has no per-card data and needs nothing. llmserver isn't affected.

The read commands need `INFLUXDB_HOME_TOKEN`. `backup`, `copy` and `delete`
also need `INFLUXDB_WRITE_TOKEN`, a key with write and delete rights on
`sysmetrics`. `delete` re-runs `verify` first and refuses to run if the counts
differ.

```
node sysmetrics/retag-gpu.js count  --host devbox --from 0 --to 1
node sysmetrics/retag-gpu.js backup --host devbox --from 0
node sysmetrics/retag-gpu.js copy   --host devbox --from 0 --to 1
node sysmetrics/retag-gpu.js verify --host devbox --from 0 --to 1
node sysmetrics/retag-gpu.js delete --host devbox --from 0 --to 1
```

### Before the swap
- [x] 2026-11-07: Old card's UUID recorded: `GPU-9aaead17-d9f2-e568-0acf-f9e26133ef52`
- [x] 2026-11-07: Baseline (`count`): 18,467,720 points (1,846,772 for each of 10 fields),
      2026-06-28T19:30:41Z → 2026-11-07T16:51:38Z; no gpu=1 points
- [x] Deploy the updated `sysmetrics.py`. Not done before the swap: the task runs a copy at
      `C:\sysmetrics\sysmetrics.py`, so `copy` was given `--uuid`/`--name` explicitly. Done on swap day (below)

### Swap day, in order
- [x] 2026-11-12: Write key `INFLUXDB_SYSMETRICS_WRITE_TOKEN` (write on `sysmetrics` and
      `sysmetrics_gpu_backup`) and bucket created. Reads use `INFLUXDB_HOME_TOKEN`
- [x] 2026-11-12: SysMetrics task stopped. All steps use `--stop 2026-11-12T14:40:50Z`
- [x] 2026-11-12: `backup`: 19,301,060 points
- [x] 2026-11-12: `copy`: 19,301,060 points. The first attempt failed on a script bug (mixed float/int
      count after `to()`, now fixed) and left partial Jun 28 points as a separate series. Jun 28
      was deleted from gpu=1 and the backup, then copied again
- [x] 2026-11-12: `verify`: every field 1,930,106 = 1,930,106; backup bucket matches too
- [x] 2026-11-12: `delete`
- [x] 2026-11-12: `count`: gpu=0 has 0 points; gpu=1 has 19,301,060, 2026-06-28T19:30:41Z → 2026-11-12T14:40:29Z
- [x] 2026-11-12: Power off; old card into the chipset slot, new card into 01:00.0
- [x] 2026-11-12: NVML: index 0 = `GPU-ec60240e-4b03-d2ea-a4eb-49750e91a552` (new, 01:00.0, drives
      the display); index 1 = `GPU-9aaead17-…` (old, 04:00.0). HWiNFO numbers the cards the other
      way round; NVML, `nvidia-smi` and CUDA (`CUDA_DEVICE_ORDER=PCI_BUS_ID` in `server.ps1`) are what count
- [x] 2026-11-12: Copied `sysmetrics/sysmetrics.py` over `C:\sysmetrics\sysmetrics.py` (task stopped;
      starts at boot with the new card in)
- [x] 2026-11-12: SysMetrics started at boot but sent no GPU points: `nvmlInit()` ran once at import,
      before the driver was ready, and GPU collection stayed off. `sysmetrics.py` now retries the
      init every 60 s; redeployed and restarted. New points carry `gpu_uuid`/`gpu_name` for both cards
- [ ] Grafana shows gpu=0 (new card) and gpu=1 (old card, full history continuing as one line)
- [ ] Import the updated `sysmetrics/grafana-dashboard.json` (mirrored to
      `C:\development\home\grafana\dashboards\SysMetrics.json`) in Grafana
- [x] 2026-11-12: Idle draw with the display on GPU 0: GPU 0 ~30 W, GPU 1 ~8 W. `--gpu-idle` in
      `proxy.ps1` 15 → 38 (the proxy subtracts it from the summed draw); restart the proxy to apply
- [x] 2026-11-12: The "Cap 3090 Max Power" boot task (`llama.cpp\pre-built\cap-3090-power.bat`, 260 W on
      `-i 0` and `-i 1`) failed at boot with exit 9 (driver not loaded), leaving both cards at 350 W.
      The batch file now retries for up to 5 min; ran it, both cards are at 260 W
- [-] Move the monitor to GPU 1 (BIOS primary display), re-measure idle, and update `--gpu-idle`
      (superseded: the blower failed burn-in and was removed, see below)
- [x] 2026-11-12: After the next reboot: the cap task returned 0 (now `nvidia-smi -pl 260` for every
      card) and GPU points arrived from boot

### Blower returned, back to one card (2026-11-12)
The new card throttled at its thermal limit on burn-in (see Results) and was removed. The FE went
back to 01:00.0 and is GPU 0 again, so its history was moved back. Full findings, a comparison
with another listing's chart, and the test plan for a replacement are in `3090-blower-evaluation.md`.
- [x] Backed up to `sysmetrics_gpu_backup`: the blower's 7,980 points (`gpu=0`, `gpu_uuid=GPU-ec60240e-…`)
      and the FE's 8,040 points from today (`gpu=1`, 14:40 → 21:30Z)
- [x] Deleted the blower's points from `sysmetrics` (predicate on its `gpu_uuid`)
- [x] `retag-gpu.js` count queries now regroup by `_field` before `count()`: today's FE series came
      back as two tables with the same key, which `count()` rejects
- [x] `copy --from 1 --to 0 --stop 2026-11-12T21:30:00Z`: 19,309,040 points; `verify` OK per field
      (1,930,904 each); `delete` of gpu=1. After: gpu=0 has 19,309,040 points,
      2026-06-28T19:30:41Z → 2026-11-12T21:23:46Z; gpu=1 has 0. The FE's live data continues as gpu=0
- [x] 2026-11-12: FE idle with the display on it settles at ~19.6–20 W (brief ~100 W redraw spikes);
      `--gpu-idle` in `proxy.ps1` 38 → 20
- [-] Remove or retarget the `Devices = "CUDA0,CUDA1"` profiles in `server.ps1` / `llama-swap/configs/devbox.yaml`
      (kept 2026-11-12 in case another 3090 arrives; `qwen38-27b-q6`, `qwen38-27b-x2`, `flint-40b`
      and `nemotron-bolt` won't load on one card, so don't pick them in llama-swap until then)

### Cleanup
- [ ] After a week of correct dashboards, delete the bucket `sysmetrics_gpu_backup`
- [x] 2026-11-12: Dashboard updated: `GPU` variable (filtered by host); legends read `<host> gpu<N>`;
      tag variants merged into one line per card; Power panel adds an "all GPUs [host]" total
- [ ] Optional: deploy the new `sysmetrics.py` to llmserver (`/opt/sysmetrics`) for UUID tags there

## llama.cpp on two GPUs

With no flags, the CUDA build uses every visible GPU with `--split-mode layer`.
It assigns whole layers to each card in proportion to free VRAM, so each token
crosses the PCIe link once per GPU boundary. That suits the x4 second slot.
`server.ps1` accepts these per-model fields:

| Field | Flag | Use |
|---|---|---|
| `Devices` | `--device` | `"CUDA0,CUDA1"`, or `"CUDA1"` to keep a ≤ 24 GB model on one card |
| `SplitMode` | `--split-mode` | `layer` (default) or `none`; not `row`/`tensor` on an x4 link |
| `TensorSplit` | `--tensor-split` | e.g. `"3,2"` if GPU 0's display or compute buffers leave it short |
| `MainGpu` | `--main-gpu` | holds the scratch/output buffers; with `none`, the only GPU used |
| `SpecType` + `SpecDraftModel` | `--spec-type`, `--spec-draft-model` | separate-drafter speculation, e.g. Nemotron's DFlash drafter |

The dual-GPU profiles set `NGpuLayers = 99` instead of `"auto"`. If a context
setting stops fitting, the server then fails to load instead of quietly moving
layers to the CPU. After starting a profile, check its log for:

- `offloaded N/N layers to GPU`
- model and KV buffers on both `CUDA0` and `CUDA1`
- no growth in Task Manager → GPU → Shared GPU memory (Windows sysmem fallback)

The proxy's `power-nvidia-smi.js` now sums every GPU's `power.draw`. Once the
card is in, measure the idle draw of both cards together and set `--gpu-idle`
in `proxy.ps1` to it (currently 15 W, for one card).

## Models for the coding bench

| Profile | Weights | Size | Notes |
|---|---|---|---|
| `qwen38-27b` (baseline) | Qwen3.8-27B UD-Q4_K_M | 16.5 GB | current orchestrator implementer |
| `qwen38-27b-q6` | Qwen3.8-27B UD-Q6_K_XL | 25.3 GB | same model, near-lossless, 262k context |
| `qwen38-27b-x2` | Qwen3.8-27B UD-Q4_K_M | 16.5 GB | 2 slots × 131k for two concurrent jobs |
| `flint-40b` | flint UD-Q6_K_XL (Recursive, 40B-A2.5B MoE) | 36.3 GB | released 2026-10-21; vendor-reported SWE-bench Verified 74.2 |
| `nemotron-bolt` | NVIDIA Nemotron 3.5 Bolt 74B-A9B 24GB + DFlash drafter | 22.0 GB | QAD-trained 2-bit; NVIDIA "32GB recipe" |

**Why Nemotron Bolt runs at 2-bit.** The "24GB" checkpoint isn't a post-hoc
2-bit quant. NVIDIA trained the experts to IQ2_XXS with quantization-aware
distillation, and its published scores (Terminal-Bench 2.1 50.98) are for that
2-bit file. Unsloth also ships ordinary quants of the BF16 parent
(`unsloth/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-GGUF`). Of those, only UD-Q3_K_XL
(39.0 GB) fits in 48 GB; UD-Q4_K_XL is 50.2 GB. A post-training 3-bit quant
isn't automatically better than a QAD 2-bit one. Add it as a second Nemotron
variant only if the 24GB build looks promising on the bench.

All new profiles use llama.cpp `b12015`. `b11574` loads Qwen but fails on Flint
(`unknown model architecture: 'flint'`) and Nemotron Bolt (per-layer expert
counts). For a fair speed comparison, also run the baseline on `b12015`.
