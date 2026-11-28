# Updating Strata (llama-swap setup, Windows / devbox)

How to update Strata so llama-swap actually runs the new engine.

## Why `UPDATE.bat` alone is not enough

- llama-swap (`configs/devbox.yaml`, model `qwenflash-st`) runs
  `terminal\.venv\Scripts\python.exe terminal\strata.py serve --profile C:\development\ai\Strata-data\qwenflash-st.json`.
  The llama-swap config has **no engine version in it** and does not need to change.
- The **profile** points at the engine **without** a version in the path (unlike Linux):
  - `"exe"`: `C:\development\ai\Strata\terminal\engine\strata.exe`
  - `"vision" → "exe"`: `C:\development\ai\Strata\terminal\engine\strata-vision.exe`

  So the profile does not need editing either. What has to change is the content of `terminal\engine\`.
- `UPDATE.bat` (= `START-HERE.bat --update`) does `git pull` and updates Python packages and the model pack,
  but it only replaces a ready-made engine that is **older than the checkout's minimum** (`MIN_ENGINE` in
  `terminal\setup.py`, still 0.1.46 as of 0.2.19). 0.1.62 is newer than that, so it is kept and the update still
  reports success ("Strata is updated (engine 0.1.62)").
- `strata update` gets the newest engine from the signed feed, but it puts it in
  `terminal\engine-feed\engine\<VERSION>-windows-x86_64-cuda-cuda13\` and does **not** touch `terminal\engine\`.
  Step 4 copies it over.
- llama-swap's model `inkling` (Inkling-2-Mini, since 2026-11-27) runs on its **own** engine, `strata-inkling`, not on
  `terminal\engine`. Its run config `Strata-data\inkling.json` says `"exe": "component:strata-inkling"`, and the
  llama-swap entry sets `STRATA_COMPONENTS_DIR=...\terminal\engine-feed`. The engine is in
  `$Feed\shapes\inkling2\engine\<VERSION>-windows-x86_64-cuda-cuda13\` and the server starts the newest one there. So the
  same `strata update --components-dir $Feed` in step 3 updates it, and there is nothing to copy. See "Inkling" below.

## Steps

Use an **admin** PowerShell. The scheduled tasks (`\LocalAI\`) and `llama-swap.exe` run elevated. In a
non-admin shell, `manage.ps1 stop` fails with `Port 8080 is owned by unexpected process <pid>:` (with an
empty command line), because it cannot read the elevated process's command line.

Set the versions first (change these each time):

```powershell
$Old     = "0.1.64"   # what terminal\engine has now (see step 1)
$New     = "0.1.65"   # what the feed offers (see step 1)
$Strata  = "C:\development\ai\Strata"
$T       = "$Strata\terminal"
$Py      = "$T\.venv\Scripts\python.exe"
$Profile = "C:\development\ai\Strata-data\qwenflash-st.json"
$Feed    = "$T\engine-feed"
$Eng     = "$T\engine"
$Manage  = "C:\development\ai\llm-stuff\llama-swap\windows\manage.ps1"
$env:PYTHONUTF8 = 1   # same as llama-swap sets
```

### 1. Update the checkout, then see what is installed and what the feed has

```powershell
& "$Strata\UPDATE.bat"                    # git pull, packages, model pack (not the engine, see above)
& $Py "$T\strata.py" --version            # Terminal version, e.g. "strata 0.2.19 (build 0.1.65 ...)"
Get-Content "$Eng\BUILD.json"             # "version" = what runs now ($Old)
& $Py "$T\strata.py" update --check --no-control --components-dir $Feed
```

The check reads the feed and changes nothing. Look for
`Engine   update available: 0.1.64 -> 0.1.65` and `selected for this PC: 0.1.65 windows-x86_64-cuda-cuda13`.
The check does not mention the Inkling engine; only the real update in step 3 reports it.

Before going on, read the release notes (`gh release view -R Niko1221/Strata`) for removed or renamed flags,
moved paths and new defaults. If the checkout was older than 0.2.16, `strata.py` and `data\` moved under
`terminal\` (see "Paths that moved" in `linux\strata-update.md`): check every `Strata\...` path in the profile
and in `configs\devbox.yaml` exists.

### 2. Stop llama-swap

```powershell
& $Manage stop
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object LocalPort -In 8080,8081,8082,8188,8190 | Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process strata, strata-vision, strata-inkling, llama-swap -ErrorAction SilentlyContinue
```

Nothing should be left on 127.0.0.1/0.0.0.0/::. The `tailscaled` listener on 8082 (tailnet addresses only) is
the Tailscale forward and stays. No `strata`/`strata-vision` process should be left: Windows locks a running
`.exe`, so it cannot be replaced.

If `stop` throws `Port 8082 is owned by unexpected process <pid>:` (empty command line) and that process is
already gone, it caught the strata server while it was exiting after llama-swap was killed (seen on the 0.1.65
update). Run `& $Manage stop` again.

### 3. Download and test-start the new engine (into engine-feed)

```powershell
& $Py "$T\strata.py" update --no-control --yes --components-dir $Feed --model-config $Profile
Get-ChildItem "$Feed\engine"              # a new $New-windows-x86_64-cuda-cuda13 folder
Get-Content "$Feed\engine\$New-windows-x86_64-cuda-cuda13\BUILD.json"   # "archs" must include 86 (RTX 3090)
```

It downloads about 490 MB, checks the signature, and test-starts the engine with the profile's model (about
30 s). It should end with `Engine  0.1.64 -> 0.1.65   updated (tested: started, answered one token, stopped)`.
If it reports the engine was **not** changed, read `$Feed\.updates\logs\test-start-$New.log`. The cause is
usually a profile path (for example `read_expert_profile: cannot open`), not the engine. Fix it and rerun with
`--force`.
The `strata components rollback` it mentions switches the engine-feed folders only. It does not change
`terminal\engine` (see "Going back").

Its next line is about the Inkling engine. On 0.2.23 it said `Model engine  The engine for inkling2 is up to date.`
When the feed has a newer one, it installs it in `$Feed\shapes\inkling2\engine\`, next to the old one, and checks it
by starting it once with `--version` (no model load). `inkling` uses it from its next start.

### 4. Copy it into terminal\engine (old one kept in engine\.previous)

This does by hand what setup does when it installs an engine from the feed. The old files go to
`engine\.previous`, where `START-HERE.bat --rollback-engine` looks for them.

```powershell
$NewDir = "$Feed\engine\$New-windows-x86_64-cuda-cuda13"
Remove-Item -Recurse -Force "$Eng\.previous" -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$Eng\.previous" | Out-Null
Get-ChildItem $Eng -File | Move-Item -Destination "$Eng\.previous"
Copy-Item "$NewDir\*" $Eng

# setup treats terminal\engine as "ready-made" only when BUILD.json says so (the feed copy names the build script).
# Python reads this file: write it without a BOM.
$b = Get-Content "$Eng\BUILD.json" -Raw | ConvertFrom-Json
$b.source = "prebuilt"
$b | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM "$Eng\BUILD.json"

Get-Content "$Eng\BUILD.json"                         # "version": $New, "source": "prebuilt"
Get-Content "$Eng\.previous\BUILD.json"               # "version": $Old
```

If `Move-Item` fails with "being used by another process", an engine is still running: go back to step 2.

### 5. Check before starting

```powershell
& $Py "$T\strata.py" doctor --profile $Profile --components
& $Py "$T\strata.py" serve  --profile $Profile --plan
```

- `doctor`: every line should be `ok`, with two expected exceptions:
  - `gpu_driver_probe unverified` is normal. It is only confirmed when the engine starts.
  - `optional_missing mtp C:\development\ai\Strata-data\mtp\rt` is expected here. That folder does not exist,
    and the server drafts with DFlash2 (`Strata-data\dflash2`) instead.
- `--plan`: read the `"notes"`. These two are normal for this profile:
  `drafting: DFlash2 alone (--draft dflash2, --draft-conf 0.7)` and
  `drafting: draft vocabulary: draft_vocab.bin (the default)`. Anything else, read before starting.

Check that the new engine still accepts every flag in the profile. Some flags are not in `--help`
(`--pcie-frac`, `--adapt-decay`, `--vram-reserve-mib`), so search the binary itself:

```powershell
& $Py -c "import json,sys; a=json.load(open(sys.argv[1]))['args']; b=open(sys.argv[2],'rb').read(); m=[f for f in a if f.startswith('--') and f.encode() not in b]; print('MISSING', m if m else 'none')" $Profile "$Eng\strata.exe"
```

A flag listed as `MISSING` was dropped or renamed in the new engine. Look it up in the release notes or
`docs\DETAILS.md` before starting.

Inkling: its plan, with the same component folder llama-swap gives it. `engine_exe` stays
`component:strata-inkling` (it is resolved at the start), and `"notes"` should be empty:

```powershell
$env:STRATA_COMPONENTS_DIR = $Feed
& $Py "$T\strata.py" serve --profile C:\development\ai\Strata-data\inkling.json --plan
Remove-Item Env:STRATA_COMPONENTS_DIR
```

### 6. Start and confirm

```powershell
& $Manage start
& $Manage status
```

The model loads on the first request to `qwenflash-st`. Send one (about 50 s including the load). Keep
`max_tokens` at 200 or more: the model reasons first, and a small budget returns empty content.

```powershell
$body = @{ model="qwenflash-st"; max_tokens=300; messages=@(@{role="user"; content="Reply with just: ok"}) } | ConvertTo-Json -Depth 5
(Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions -Method Post -ContentType application/json -Body $body -TimeoutSec 540).choices[0].message.content
Get-Process strata -ErrorAction SilentlyContinue | Select-Object Id, Path
Select-String "C:\development\ai\Strata-data\qwenflash-st.engine.log" -Pattern 'session is up' | Select-Object -Last 1
```

The last line should say `session is up (engine 0.1.65)`. The process path is always
`terminal\engine\strata.exe`, so the version only shows in the log. After a text-only request, no
`strata-vision` process was running (seen on the 0.1.64 and 0.1.65 updates).

Then the same for `inkling` (about 10-30 s including the swap and the load):

```powershell
$body = @{ model="inkling"; max_tokens=300; messages=@(@{role="user"; content="Reply with just: ok"}) } | ConvertTo-Json -Depth 5
(Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions -Method Post -ContentType application/json -Body $body -TimeoutSec 540).choices[0].message.content
Get-CimInstance Win32_Process -Filter "Name='strata-inkling.exe'" | Select-Object -ExpandProperty ExecutablePath
Select-String "C:\development\ai\Strata-data\inkling.engine.log" -Pattern 'engine started|Auto Host KV' | Select-Object -Last 2
```

The path must be under `$Feed\shapes\inkling2\engine\` and name the newest version there. A path under
`%LOCALAPPDATA%\Strata\components` means the llama-swap entry lost its `STRATA_COMPONENTS_DIR`. Then send one
request to `qwenflash-st` again, so that the model llama-swap preloads is the one loaded.

### 7. Benchmark against the previous engine (optional)

To see whether the new engine is faster here, run `strata-bench-ab.ps1` and add the result to the log in
`strata-bench.md`. Do it before the next update: it compares against `engine\.previous`, which step 4 overwrites.

## Inkling

- **Engine:** see "Why" above. Step 3 updates it, and the update keeps 2 versions in `$Feed\shapes\inkling2\engine\`.
  `strata components engines` lists only the Qwen engines, not this one, so look in the folder.
- **Model files are not updated by this procedure.** `UPDATE.bat` printed `[ok] inkling-2-mini-sq-20: up to date` on
  0.2.23, but the file on disk was the 0.2.22 `Inkling-2-Mini-SQ-20.strata` (19,346,685,952 bytes). 0.2.23 offers a
  new `Inkling-2-Mini-SQv2-20.strata` (19.37 GB). `strata launch` shows it as "Update available" and keeps the old
  file. A new file means editing the `--native` path in `inkling.json`.
- **Drafter:** 0.2.23 replaced DSpark with DFlash 2 (`models\inkling-2-mini\dflash2.safetensors`, 0.55 GB,
  downloaded by `UPDATE.bat`). `inkling.json` has `"drafting": "off"` from the DSpark measurement (0.99x on the 3090),
  so DFlash 2 is not used until that is measured again.
- **Conversation memory on the card is at an edge.** At 128K the engine keeps the part of the conversation memory
  that fits in the VRAM left after the model, and the rest in host RAM. With 4,046 MiB free it kept 48,128 tokens on
  the card. With 4,000 MiB free (0.2.23, same engine) it kept 32,768. Read the `Auto Host KV Offload` line after a
  start. The engine's `--kv fp8|k8v8|k8v4` would fit more on the card. Not measured yet.

## Going back

```powershell
& $Manage stop
& "$Strata\START-HERE.bat" --rollback-engine    # swaps engine\.previous back in (run it again to go forward)
& $Manage start
```

`engine\.previous` holds one generation only. The next step 4 overwrites it. Old folders in
`terminal\engine-feed\engine\` can be deleted once the new engine has run for a while.

## Notes

- **UPDATE.bat while llama-swap runs:** it can still `git pull`, but it cannot replace a running engine (Windows
  locks the `.exe`). Stop the stack first if you expect it to replace the engine.
- **Log messages you can ignore:**
  `this engine was built for sm_0, sm_1, ... sm_9, but a graphics card in use is sm_86` is a false alarm (see
  `linux\strata-update.md`). Check `BUILD.json` yourself: if `archs` lists 86, the engine covers the RTX 3090.
- **Speed switches (from 0.1.65):** the log line
  `strata: sm_86 (Ampere): 14 exact speed switches on by default (STRATA_SM86_PERF=0 turns them off ...)` is for
  information only. Set `STRATA_SM86_PERF=0` only to compare against the old behaviour. (llmserver's RTX 4070
  logs the `sm_89 (Ada)` line instead.) 0.1.66 turns on 17: against 0.1.65 it adds `HC_UPMIX`, `Q80_ROWS1`,
  `EXP_MODE` and `PREFILL_CPU_SHARE_NT`, and drops `QFUSE`.
- **Log messages that mean the profile needs a fix:**
  `the config has a "vision" section but no --vision in its args: added --vision` means the profile's `args`
  lost `--vision` (setup can rewrite the profile). Add `"--vision"` back to `args`.
