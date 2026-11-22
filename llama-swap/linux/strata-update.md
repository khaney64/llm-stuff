# Updating Strata (llama-swap setup)

How to update the Strata checkout and engine so llama-swap runs the new version.
Last done 2026-11-22: 0.2.15 / engine 0.1.60 → 0.2.19 / engine 0.1.65.

## Why this is needed

- llama-swap (`configs/llmserver.yaml`) runs
  `$STRATA/.venv/bin/python $STRATA/terminal/strata.py serve --profile /home/kevin/Strata-data/qwenflash-st-150k.json`.
  The llama-swap config has **no engine version in it**, but it does name the path to `strata.py`
  (see "Paths that moved" below).
- The **profile** pins the engine by full path, including the version, in two places:
  - `"exe"` (top level): `.../engine-feed/engine/<VERSION>-linux-x86_64-cuda-cuda13/strata`
  - `"vision" → "exe"`: `.../engine-feed/engine/<VERSION>-linux-x86_64-cuda-cuda13/strata-vision`
  It also names files inside the checkout (`--expert-profile .../terminal/data/expert-profile.bin`).
- `strata update` downloads the new engine into `/home/kevin/Strata/engine-feed/engine/` but does
  **not** edit the profile. Without the steps below, the old engine keeps running.

## Paths that moved in 0.2.16 (read this when updating from 0.2.15 or older)

Upstream reorganized the repository in 0.2.16 (commit `4058aa782`). The top level is now `app/`,
`engine/`, `terminal/`, `docs/`, `tools/`. Two things broke here:

| Old path | New path | Used by |
|---|---|---|
| `$STRATA/strata.py` | `$STRATA/terminal/strata.py` | llama-swap `cmd` in `configs/llmserver.yaml` |
| `$STRATA/data/expert-profile.bin` | `$STRATA/terminal/data/expert-profile.bin` | profile `args` (`--expert-profile`) |

Symptoms if not fixed:
- `can't open file '/home/kevin/Strata/strata.py'`: llama-swap cannot start the model.
- `read_expert_profile: cannot open .../data/expert-profile.bin`: the engine stops during load.
  `strata update` then reports "did not start correctly ... NOT changed" and keeps the old engine.
  The new engine is fine; fix the profile and run `strata update --force`.

Also gone in 0.2.16: `SETUP.bat`, `UPDATE.bat`, `update.sh` (use `git pull` + `strata update`).
Old top-level `strata_cli/`, `strata_control/` and `serve/` folders may remain in the checkout with only
`__pycache__` in them. They are ignored by git and harmless.

Check every `/home/kevin/Strata/...` path in the profile and in llama-swap's config still exists:

```sh
grep -ho '/home/kevin/Strata/[^" ]*' $PROFILE /home/kevin/llm-stuff/llama-swap/configs/llmserver.yaml \
  | sort -u | while read p; do [ -e "$p" ] || echo "MISSING $p"; done; echo "path check done"
```

(The two engine `exe` paths show as MISSING until the new engine is installed; that is expected before step 4.)

## Steps

Set the variables first (change the versions each time):

```sh
OLD=0.1.64        # what the profile uses now (see step 1)
NEW=0.1.65        # newest folder in engine-feed/engine after step 4
PROFILE=/home/kevin/Strata-data/qwenflash-st-150k.json
STRATA=/home/kevin/Strata
PY="$STRATA/.venv/bin/python $STRATA/terminal/strata.py"
export STRATA_COMPONENTS_DIR=$STRATA/engine-feed    # same as llama-swap sets
```

### 1. See what is installed and what the profile uses

```sh
ls $STRATA/engine-feed/engine/
grep '"exe"' $PROFILE
$PY --version
cd $STRATA && git fetch origin && git status -sb | head -1     # how far behind
```

The checkout has two remotes: `origin` = upstream (Niko1221/Strata), `fork` = khaney64/Strata.
Pull from `origin`.

### 2. Stop llama-swap

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh stop     # also stops llama-proxy
ps -eo args | grep engine-feed | grep -v grep || echo "engine stopped"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

`strata update` test-starts the new engine on the GPU, so the running one must be stopped first.

### 3. Update the checkout

```sh
cd $STRATA && git pull --ff-only origin main
$PY --version            # new Terminal version and the engine build it expects
```

If upstream moved files again, run the path check above and fix the profile / llama-swap config
before going on.

### 4. Update the engine

```sh
cp $PROFILE $PROFILE.bak-$OLD
$PY update --yes --model-config $PROFILE
```

It downloads the engine and Control, test-starts the engine with this profile (load + one token)
and installs it only if that works. If it says "NOT changed", read the log it names
(`engine-feed/.updates/logs/test-start-<NEW>.log`), fix the cause, then `$PY update --yes --force --model-config $PROFILE`.

```sh
ls $STRATA/engine-feed/engine/
cat $STRATA/engine-feed/engine/$NEW-linux-x86_64-cuda-cuda13/BUILD.json   # "archs" must include 89 (RTX 4070)
```

### 5. Point the profile at the new engine

```sh
sed -i "s#/$OLD-linux-x86_64-cuda-cuda13/#/$NEW-linux-x86_64-cuda-cuda13/#g" $PROFILE
diff $PROFILE.bak-$OLD $PROFILE          # expect the two "exe" lines (plus any path fixes you made)
python3 -m json.tool $PROFILE >/dev/null && echo "JSON ok"
```

### 6. Check before starting

```sh
cd $STRATA
$PY doctor --profile $PROFILE --components
$PY serve  --profile $PROFILE --plan
```

- `doctor`: every line should be `ok`. `gpu_driver_probe unverified` is normal (it is only
  confirmed when the engine starts).
- `--plan`: `"notes": []` is the goal. Read any note it prints.

Check that the new engine still accepts every flag in the profile. Some flags are not in
`--help` (`--pcie-frac`, `--adapt-decay`, `--vram-reserve-mib`), so check the binary as well:

```sh
D=$STRATA/engine-feed/engine/$NEW-linux-x86_64-cuda-cuda13
for f in $(python3 -c "import json;print(' '.join(a for a in json.load(open('$PROFILE'))['args'] if a.startswith('--')))"); do
  grep -a -q -- "$f" $D/strata || echo "MISSING $f"
done; echo "flag check done"
```

A `MISSING` flag means the new engine dropped or renamed it. Look it up in the release notes
or `docs/DETAILS.md` before starting.

### 7. Start and confirm

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh start
/home/kevin/llm-stuff/llama-swap/linux/manage.sh status
ps -eo args | grep engine-feed | grep -v grep     # should show $NEW for strata and strata-vision
journalctl --user -u llama-swap.service --since "5 min ago" --no-pager | grep -iE 'warn|error|traceback'
```

The model is preloaded on start (`hooks.on_startup.preload`). Send one test request.
Use `max_tokens` of 200 or more: the model reasons first, and a small budget leaves `content` empty.

```sh
curl -s localhost:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwenflash-st","messages":[{"role":"user","content":"Say hi in three words."}],"max_tokens":200}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

nvtop shows the same engine path.

### 8. Benchmark the new engine (optional)

To see whether the new engine is faster here, run the A/B benchmark in `strata-bench.md`
(`strata-bench-ab.sh <old> <new>`). Do not compare against a single earlier run or a report in
`docs/bench-results/`: decode varies about ±20% between runs.

## Going back

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh stop
cp $PROFILE.bak-$OLD $PROFILE
/home/kevin/llm-stuff/llama-swap/linux/manage.sh start
```

If the checkout was also pulled across a layout change, the old profile may point at paths that
no longer exist. Either check out the old commit (`git checkout <old>`) or keep the path fixes.
`$PY components rollback` switches the active engine back as well.

Keep the old engine folder until the new one has run for a while. Old folders in
`engine-feed/engine/` can be deleted after that.

## Log messages you can ignore

- `this engine was built for sm_0, sm_1, ... sm_9, but a graphics card in use is sm_89` -
  false alarm. A bug in `serve/server.py` (`engine_arch_note`) reads the `BUILD.json` string
  `"75;86;89;120"` one character at a time. Check `BUILD.json` yourself (step 4); if it lists
  `89`, the engine covers the RTX 4070. `strata update` does not make this message go away.
  (Not seen on 0.2.19 / 0.1.65.)
- `sm_89 (Ada): 11 exact speed switches on by default` - new in 0.2.19, informational.
  `STRATA_SM89_PERF=0` turns them off if you need to compare against the old behaviour.

## Log messages that mean the profile needs a fix

- `the config has a "vision" section but no --vision in its args: added --vision` - the
  profile's `args` lost `--vision` (this can happen if setup rewrites the profile). Vision still
  works, but add `"--vision"` back to the end of `args` to stop the message.
- `read_expert_profile: cannot open ...` - a path in `args` points into the checkout at a place
  that moved. See "Paths that moved".
