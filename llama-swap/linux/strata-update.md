# Updating Strata (llama-swap setup)

What to do after `strata update` so llama-swap actually runs the new engine.

## Why this is needed

- llama-swap (`configs/llmserver.yaml`) runs
  `strata.py serve --profile /home/kevin/Strata-data/qwenflash-st-150k.json`.
  The llama-swap config has **no engine version in it** and does not need to change.
- The **profile** pins the engine by full path, including the version, in two places:
  - `"exe"` (top level): `.../engine-feed/engine/<VERSION>-linux-x86_64-cuda-cuda13/strata`
  - `"vision" → "exe"`: `.../engine-feed/engine/<VERSION>-linux-x86_64-cuda-cuda13/strata-vision`
- `strata update` downloads the new engine into `/home/kevin/Strata/engine-feed/engine/` but does
  **not** edit the profile. Without the steps below, the old engine keeps running.

## Steps

Set the versions first (change these each time):

```sh
OLD=0.1.62        # what the profile uses now (see step 1)
NEW=0.1.64        # newest folder in engine-feed/engine
PROFILE=/home/kevin/Strata-data/qwenflash-st-150k.json
STRATA=/home/kevin/Strata
export STRATA_COMPONENTS_DIR=$STRATA/engine-feed    # same as llama-swap sets
```

### 1. See what is installed and what the profile uses

```sh
ls $STRATA/engine-feed/engine/
grep '"exe"' $PROFILE
cat $STRATA/engine-feed/engine/$NEW-linux-x86_64-cuda-cuda13/BUILD.json   # "archs" must include 89 (RTX 4070)
$STRATA/.venv/bin/python $STRATA/strata.py --version
```

If the Terminal (`strata --version`) is much older than the new engine, update the checkout
too (`cd $STRATA && git pull`) so the Python side matches the engine.

### 2. Stop llama-swap

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh stop     # also stops llama-proxy
ps -eo args | grep engine-feed | grep -v grep || echo "engine stopped"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

### 3. Back up the profile and point it at the new engine

```sh
cp $PROFILE $PROFILE.bak-$OLD
sed -i "s#/$OLD-linux-x86_64-cuda-cuda13/#/$NEW-linux-x86_64-cuda-cuda13/#g" $PROFILE
diff $PROFILE.bak-$OLD $PROFILE          # expect exactly the two "exe" lines
python3 -m json.tool $PROFILE >/dev/null && echo "JSON ok"
```

### 4. Check before starting

```sh
cd $STRATA
.venv/bin/python strata.py doctor --profile $PROFILE --components
.venv/bin/python strata.py serve  --profile $PROFILE --plan
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

### 5. Start and confirm

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh start
/home/kevin/llm-stuff/llama-swap/linux/manage.sh status
```

The model loads on the first request. After that:

```sh
ps -eo args | grep engine-feed | grep -v grep     # should show $NEW for strata and strata-vision
```

nvtop shows the same path.

## Going back

```sh
/home/kevin/llm-stuff/llama-swap/linux/manage.sh stop
cp $PROFILE.bak-$OLD $PROFILE
/home/kevin/llm-stuff/llama-swap/linux/manage.sh start
```

Keep the old engine folder until the new one has run for a while. Old folders in
`engine-feed/engine/` can be deleted after that.

## Log messages you can ignore

- `this engine was built for sm_0, sm_1, ... sm_9, but a graphics card in use is sm_89` -
  false alarm. A bug in `serve/server.py` (`engine_arch_note`) reads the `BUILD.json` string
  `"75;86;89;120"` one character at a time. Check `BUILD.json` yourself (step 1); if it lists
  `89`, the engine covers the RTX 4070. `strata update` does not make this message go away.

## Log messages that mean the profile needs a fix

- `the config has a "vision" section but no --vision in its args: added --vision` - the
  profile's `args` lost `--vision` (this can happen if setup rewrites the profile). Vision still
  works, but add `"--vision"` back to the end of `args` to stop the message.
