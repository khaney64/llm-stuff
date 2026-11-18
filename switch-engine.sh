#!/usr/bin/env bash
# Point Strata's run configs at another installed engine.
#
#   switch-engine.sh                    list installed engines and what each config runs now
#   switch-engine.sh 0.1.61             switch the llama-swap profiles to engine 0.1.61
#   switch-engine.sh 0.1.61 --bench     also switch the benchmark configs (~/Strata/strata-*.json)
#   switch-engine.sh 0.1.61 --dry-run   show what would change, change nothing
#
# The engine must already be installed (`strata update` puts it in $ENGINES). The llama-swap profiles are the
# `--profile` files named in $LLAMA_SWAP_CONFIG. Each changed file is first copied to <file>.bak-<timestamp>.
# Only "exe" and "vision" -> "exe" change; everything else in the file is kept. Restart the model in llama-swap
# afterwards: a running engine keeps its old version until it starts again.
set -euo pipefail

ENGINES=${STRATA_COMPONENTS_DIR:-/home/kevin/Strata/engine-feed}/engine
BACKEND=${STRATA_ENGINE_BACKEND:-linux-x86_64-cuda-cuda13}
LLAMA_SWAP_CONFIG=${LLAMA_SWAP_CONFIG:-/home/kevin/llm-stuff/llama-swap/configs/llmserver.yaml}
BENCH_CONFIGS=(/home/kevin/Strata/strata-*.json)
PY=python3

profiles() {
  grep -oE -- '--profile[[:space:]]+[^[:space:]]+' "$LLAMA_SWAP_CONFIG" | awk '{print $2}' | sort -u
}

show() {  # file -> one line with the engine it runs and that engine's version
  "$PY" - "$1" <<'EOF'
import json, sys, pathlib
f = sys.argv[1]
d = json.load(open(f))
exe = d.get("exe") or "?"
ver = "?"
b = pathlib.Path(exe).parent / "BUILD.json"
if b.exists():
    ver = json.load(open(b)).get("version", "?")
print(f"  {ver:<8} {f}\n           exe: {exe}")
EOF
}

if [[ $# -eq 0 ]]; then
  echo "Installed engines ($ENGINES):"
  for d in "$ENGINES"/*/; do
    d=${d%/}
    [[ -x $d/strata ]] && printf '  %s\n' "$(basename "$d")"
  done
  echo
  echo "llama-swap profiles ($LLAMA_SWAP_CONFIG):"
  while read -r p; do [[ -f $p ]] && show "$p" || echo "  missing: $p"; done < <(profiles)
  echo
  echo "Benchmark configs:"
  for p in "${BENCH_CONFIGS[@]}"; do [[ -f $p ]] && show "$p"; done
  exit 0
fi

VERSION=$1; shift
BENCH=0; DRY=0
for a in "$@"; do
  case $a in
    --bench) BENCH=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

DIR=$ENGINES/$VERSION-$BACKEND
if [[ ! -x $DIR/strata ]]; then
  echo "No engine $VERSION at $DIR/strata." >&2
  echo "Installed:" >&2
  ls -1 "$ENGINES" >&2
  echo "Install a new one with: strata update" >&2
  exit 1
fi

TARGETS=()
while read -r p; do TARGETS+=("$p"); done < <(profiles)
if [[ $BENCH -eq 1 ]]; then
  for p in "${BENCH_CONFIGS[@]}"; do [[ -f $p ]] && TARGETS+=("$p"); done
fi
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No configs found (no --profile in $LLAMA_SWAP_CONFIG)." >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
CHANGED=0
for f in "${TARGETS[@]}"; do
  if [[ ! -f $f ]]; then echo "skip (missing): $f"; continue; fi
  if "$PY" - "$f" "$DIR" "$DRY" "$STAMP" <<'EOF'
import json, os, shutil, sys
f, engine_dir, dry, stamp = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
text = open(f).read()
d = json.loads(text)
changes = []
new_exe = os.path.join(engine_dir, "strata")
if d.get("exe") != new_exe:
    changes.append(("exe", d.get("exe"), new_exe))
    d["exe"] = new_exe
v = d.get("vision")
if isinstance(v, dict) and v.get("exe"):
    new_v = os.path.join(engine_dir, "strata-vision")
    if not os.access(new_v, os.X_OK):
        print(f"  ! {f}: the new engine has no strata-vision; vision.exe left as it is")
    elif v["exe"] != new_v:
        changes.append(("vision.exe", v["exe"], new_v))
        v["exe"] = new_v
if not changes:
    print(f"unchanged (already on it): {f}")
    sys.exit(1)
print(("would change: " if dry else "changed: ") + f)
for key, old, new in changes:
    print(f"    {key}: {old}\n      -> {new}")
if not dry:
    shutil.copy2(f, f"{f}.bak-{stamp}")
    indent = 1 if text.startswith("{\n \"") else 2
    tmp = f + ".tmp"
    with open(tmp, "w") as out:
        json.dump(d, out, indent=indent, ensure_ascii=False)
        out.write("\n")
    os.replace(tmp, f)
EOF
  then CHANGED=$((CHANGED + 1)); fi
done

echo
if [[ $DRY -eq 1 ]]; then
  echo "Dry run: nothing was changed."
elif [[ $CHANGED -gt 0 ]]; then
  echo "Done: $CHANGED file(s) now run engine $VERSION (backups end in .bak-$STAMP)."
  echo "Restart the model in llama-swap, then check its engine log for: session is up (engine $VERSION)"
fi
