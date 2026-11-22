#!/usr/bin/env bash
# Same-day A/B of Strata engines with terminal/tools/strata_bench.py, run forward then in reverse order.
# Linux version of ../windows/strata-bench-ab.ps1. Method and results log: strata-bench.md (this folder).
#
# It stops llama-swap, writes one copy of the bench config per run with exe / vision.exe pointing at that
# engine's folder (the installed engine is never swapped), runs a discarded warm-up, then every engine
# forward and in reverse, writes summary.md and starts llama-swap again.
#
# Usage:
#   strata-bench-ab.sh [VERSION ...]          versions from $STRATA/engine-feed/engine (default: 0.1.64 0.1.65)
# Environment:
#   VARIANTS="name:version:KEY=VAL[,KEY=VAL]"  extra runs with env switches, space separated,
#                                             e.g. VARIANTS="0.1.65-sm89off:0.1.65:STRATA_SM89_PERF=0"
#   BASE_CONFIG   bench config (default $STRATA/strata-iq3_s.json, the IQ3_S config the 11-17 reports used)
#   WARMUP_RUNS   discarded warm-up runs of the first engine (default 1)
#   SETTLE_MIN    minutes to wait after stopping llama-swap (default 0)
#   NO_STACK=1    do not stop / start llama-swap
#   OUT_DIR       default ~/llm-stuff/bench/results/strata-ab-<date>-llmserver
set -euo pipefail

STRATA=${STRATA:-/home/kevin/Strata}
MANAGE=/home/kevin/llm-stuff/llama-swap/linux/manage.sh
BASE_CONFIG=${BASE_CONFIG:-$STRATA/strata-iq3_s.json}
WARMUP_RUNS=${WARMUP_RUNS:-1}
SETTLE_MIN=${SETTLE_MIN:-0}
OUT_DIR=${OUT_DIR:-/home/kevin/llm-stuff/bench/results/strata-ab-$(date +%F)-llmserver}
PY=$STRATA/.venv/bin/python
FEED=$STRATA/engine-feed
export STRATA_COMPONENTS_DIR=$FEED

versions=("$@"); [ ${#versions[@]} -gt 0 ] || versions=(0.1.64 0.1.65)

# The run set: "name|version|env" per entry.
set_=()
for v in "${versions[@]}"; do set_+=("$v|$v|"); done
for spec in ${VARIANTS:-}; do IFS=: read -r n v e <<<"$spec"; set_+=("$n|$v|$e"); done

for s in "${set_[@]}"; do
  IFS='|' read -r n v e <<<"$s"
  [ -x "$FEED/engine/$v-linux-x86_64-cuda-cuda13/strata" ] || { echo "no engine $v in $FEED/engine" >&2; exit 2; }
done

mkdir -p "$OUT_DIR/cfg" "$OUT_DIR/runs"

# Plan: warm-up(s) on the first entry, forward, reverse.
plan=()
for ((i = 1; i <= WARMUP_RUNS; i++)); do plan+=("warmup$i|${set_[0]}"); done
for s in "${set_[@]}"; do plan+=("fwd-${s%%|*}|$s"); done
for ((i = ${#set_[@]} - 1; i >= 0; i--)); do s=${set_[$i]}; plan+=("rev-${s%%|*}|$s"); done

echo "plan: $(for p in "${plan[@]}"; do printf '%s ' "${p%%|*}"; done)"
echo "out:  $OUT_DIR"

restart() { [ "${NO_STACK:-}" = 1 ] || { "$MANAGE" start; echo "llama-swap started $(date +%T)"; }; }
if [ "${NO_STACK:-}" != 1 ]; then
  "$MANAGE" stop
  trap restart EXIT
  sleep 5
fi
if ss -lnt | awk '{print $4}' | grep -qE '(^|:)8080$'; then echo "port 8080 is in use: stop llama-swap first" >&2; exit 3; fi
[ "$SETTLE_MIN" -gt 0 ] && { echo "settling $SETTLE_MIN min"; sleep $((SETTLE_MIN * 60)); }

meta=$OUT_DIR/runs.jsonl; : >"$meta"
for p in "${plan[@]}"; do
  IFS='|' read -r label n v e <<<"$p"
  cfg=$OUT_DIR/cfg/strata-$label.json
  # Per-run config: engine paths for this version, its own engine log, the moved expert profile.
  "$PY" -I - "$BASE_CONFIG" "$cfg" "$FEED/engine/$v-linux-x86_64-cuda-cuda13" "$OUT_DIR/runs/$label.engine.log" "$STRATA" <<'EOF'
import json, os, sys
base, out, eng, log, strata = sys.argv[1:]
c = json.load(open(base))
c["exe"] = eng + "/strata"
if (c.get("vision") or {}).get("exe"):
    c["vision"]["exe"] = eng + "/strata-vision"
c["log"] = log
a = c["args"]
if "--expert-profile" in a:
    i = a.index("--expert-profile") + 1
    if not os.path.exists(a[i]):
        a[i] = strata + "/terminal/data/expert-profile.bin"
json.dump(c, open(out, "w"), indent=1)
EOF
  start=$(date +%T); avail=$(awk '/MemAvailable/ {printf "%.1f", $2/1048576}' /proc/meminfo)
  echo "=== $label ($v ${e:-defaults}) start $start MemAvailable=${avail}GiB"
  set +e
  ( cd "$STRATA" && env ${e//,/ } "$PY" terminal/tools/strata_bench.py --config "$cfg" --out "$OUT_DIR/runs/$label" ) \
    >"$OUT_DIR/runs/$label.log" 2>&1
  rc=$?
  set -e
  sm=$(grep -m1 -oE 'sm_[0-9]+ \([A-Za-z]+\): [0-9]+ exact speed switches on' "$OUT_DIR/runs/$label.engine.log" 2>/dev/null || true)
  echo "=== $label exit $rc $(date +%T) ${sm:-no speed-switch line}"
  printf '{"label":"%s","engine":"%s","env":"%s","start":"%s","end":"%s","mem_available_gib":%s,"exit":%d,"switches":"%s"}\n' \
    "$label" "$v" "$e" "$start" "$(date +%T)" "$avail" "$rc" "$sm" >>"$meta"
done

# Summary: the medians strata_bench prints, one column per run, in run order.
"$PY" -I - "$OUT_DIR" "$BASE_CONFIG" <<'EOF'
import json, re, sys, datetime
out, base = sys.argv[1:]
keys = ["chat decode tok/s", "chat first token (s)", "4K prompt tok/s", "4K first token (s)", "16K prompt tok/s",
        "16K first token (s)", "agent turn first token (s)", "agent decode tok/s"]
meta = [json.loads(l) for l in open(f"{out}/runs.jsonl")]
cols = []
for m in meta:
    t = open(f"{out}/runs/{m['label']}.log").read()
    sec = t.split("Results (median", 1)[1] if "Results (median" in t else ""
    v = {}
    for k in keys:
        r = re.search(re.escape(k) + r"\s+([\d.]+)\s+\(([\d.]+) - ([\d.]+)", sec)
        v[k] = f"{r[1]} ({r[2]}-{r[3]})" if r else "-"
    cols.append((m, v))
md = [f"# Strata engine A/B {datetime.date.today()} (llmserver)", "",
      f"Config: `{base}` (engine paths swapped per run). Medians over 3 runs per test, range in brackets.", "",
      "| Metric | " + " | ".join(m["label"] for m, _ in cols) + " |",
      "| --- | " + " | ".join("---:" for _ in cols) + " |"]
md += ["| " + k + " | " + " | ".join(v[k] for _, v in cols) + " |" for k in keys]
md.append("| start / MemAvailable GiB | " + " | ".join(f"{m['start']} / {m['mem_available_gib']}" for m, _ in cols) + " |")
md.append("| speed switches | " + " | ".join(m["switches"] or "none" for m, _ in cols) + " |")
md.append("| exit | " + " | ".join(str(m["exit"]) for m, _ in cols) + " |")
md += ["", "Runs: " + ", ".join(f"`{m['label']}` = {m['engine']}" + (f" with {m['env']}" if m["env"] else "") for m, _ in cols)]
open(f"{out}/summary.md", "w").write("\n".join(md) + "\n")
print("\n".join(md))
EOF
echo
echo "Results: $OUT_DIR"
