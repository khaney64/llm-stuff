#!/usr/bin/env python3
"""Parse proxy-done.log and summarize stats by job/session and model."""

import re
import sys
from collections import defaultdict
from datetime import datetime

LOG_FILE = "proxy-done.log"
if len(sys.argv) > 1:
    LOG_FILE = sys.argv[1]

# Regex to parse each [done] line
LINE_RE = re.compile(
    r"^(?P<ts>\S+)\s+\[done\]\s+"
    r"(?:job|session)=(?P<job>\S+)\s+"
    r"(?P<model>\S+)\s+"
    r"reason=(?P<reason>\S+)\s+"
    r"prompt=(?P<prompt>\d+)\s+"
    r"\((?P<ctx_pct>[\d.]+)%\s+of\s+(?P<ctx_size>\d+)\s+ctx\)\s+"
    r"gen=(?P<gen>\d+)\s+"
    r"ratio=(?P<ratio>[\d.]+)%\s+"
    r"pp=(?P<pp>[\d.]+)tok/s\((?P<pp_time>\S+?)\)\s+"
    r"tg=(?P<tg>[\d.]+)tok/s\((?P<tg_time>\S+?)\)\s+"
    r"total=(?P<total>[\d.]+)s\s+"
    r"elapsed=(?P<elapsed>[\d.]+)s\s+"
    r"session:\s+prompt=(?P<sess_prompt>\d+)\s+"
    r"gen=(?P<sess_gen>\d+)\s+"
    r"elapsed=(?P<sess_elapsed>[\d.]+)s"
)

# Parse a duration string like "5655ms" or "0.82s" into seconds
def parse_dur(s):
    if s.endswith("ms"):
        return float(s[:-2]) / 1000
    if s.endswith("s"):
        return float(s[:-1])
    return float(s)

class Stats:
    def __init__(self):
        self.values = []
    def add(self, v):
        self.values.append(v)
    @property
    def n(self): return len(self.values)
    @property
    def avg(self): return sum(self.values) / len(self.values) if self.values else 0
    @property
    def mn(self): return min(self.values) if self.values else 0
    @property
    def mx(self): return max(self.values) if self.values else 0
    @property
    def total(self): return sum(self.values)

jobs = defaultdict(lambda: {
    "models": set(),
    "requests": 0,
    "reasons": defaultdict(int),
    "prompt": Stats(),
    "gen": Stats(),
    "ctx_pct": Stats(),
    "ctx_size": set(),
    "pp": Stats(),       # prompt processing tok/s
    "tg": Stats(),       # text generation tok/s
    "elapsed": Stats(),
    "total": Stats(),
    "sess_prompt": Stats(),
    "sess_gen": Stats(),
    "sess_elapsed": Stats(),
    "dates": set(),
    "first_ts": None,
    "last_ts": None,
})

models_seen = set()
total_lines = 0
parse_errors = 0

with open(LOG_FILE, "r") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        total_lines += 1
        m = LINE_RE.match(line)
        if not m:
            parse_errors += 1
            continue

        d = m.groupdict()
        job = d["job"]
        j = jobs[job]

        j["models"].add(d["model"])
        models_seen.add(d["model"])
        j["requests"] += 1
        j["reasons"][d["reason"]] += 1
        j["prompt"].add(int(d["prompt"]))
        j["gen"].add(int(d["gen"]))
        j["ctx_pct"].add(float(d["ctx_pct"]))
        j["ctx_size"].add(int(d["ctx_size"]))
        j["pp"].add(float(d["pp"]))
        j["tg"].add(float(d["tg"]))
        j["elapsed"].add(float(d["elapsed"]))
        j["total"].add(float(d["total"]))
        j["sess_prompt"].add(int(d["sess_prompt"]))
        j["sess_gen"].add(int(d["sess_gen"]))
        j["sess_elapsed"].add(float(d["sess_elapsed"]))

        ts = d["ts"][:10]  # date portion
        j["dates"].add(ts)
        if j["first_ts"] is None or d["ts"] < j["first_ts"]:
            j["first_ts"] = d["ts"]
        if j["last_ts"] is None or d["ts"] > j["last_ts"]:
            j["last_ts"] = d["ts"]

# --- Output ---
print("=" * 100)
print(f"PROXY-DONE.LOG SUMMARY")
print(f"  Total lines: {total_lines}  |  Parse errors: {parse_errors}")
print(f"  Models seen: {', '.join(sorted(models_seen))}")
print("=" * 100)

for job_name in sorted(jobs.keys()):
    j = jobs[job_name]
    n = j["requests"]
    print()
    print(f"{'─' * 100}")
    print(f"  JOB: {job_name}   model(s): {', '.join(sorted(j['models']))}")
    print(f"  Requests: {n}   Days active: {len(j['dates'])}   "
          f"Period: {j['first_ts'][:10]} → {j['last_ts'][:10]}")
    print(f"  Context window: {', '.join(str(c) for c in sorted(j['ctx_size']))}")
    print(f"  Stop reasons: {dict(j['reasons'])}")
    print()

    def row(label, s, fmt=",.1f", unit=""):
        print(f"    {label:<28s}  avg={s.avg:{fmt}}{unit}   "
              f"min={s.mn:{fmt}}{unit}   max={s.mx:{fmt}}{unit}   "
              f"total={s.total:{fmt}}{unit}")

    row("Prompt tokens",       j["prompt"],  fmt=",.0f", unit=" tok")
    row("Gen tokens",          j["gen"],     fmt=",.0f", unit=" tok")
    row("Context usage %",     j["ctx_pct"], fmt=".1f",  unit="%")
    row("Prompt proc (pp)",    j["pp"],      fmt=",.1f", unit=" tok/s")
    row("Text gen (tg)",       j["tg"],      fmt=",.1f", unit=" tok/s")
    row("Inference time",      j["total"],   fmt=".2f",  unit="s")
    row("Elapsed (wall)",      j["elapsed"], fmt=".2f",  unit="s")
    print()
    print(f"    {'Session-end totals:':<28s}  (last request of each session group)")
    row("  Session prompt tok",  j["sess_prompt"], fmt=",.0f", unit=" tok")
    row("  Session gen tok",     j["sess_gen"],    fmt=",.0f", unit=" tok")
    row("  Session elapsed",     j["sess_elapsed"],fmt=".2f",  unit="s")

print()
print(f"{'─' * 100}")
print()

# Overall summary table
print("OVERALL COMPARISON (per-request averages)")
print()
hdr = f"  {'Job':<36s} {'Reqs':>5s} {'Days':>4s} {'Avg Prompt':>10s} {'Avg Gen':>8s} {'Avg Ctx%':>8s} {'Avg PP':>10s} {'Avg TG':>9s} {'Avg Elapsed':>11s}"
print(hdr)
print("  " + "─" * (len(hdr) - 2))
for job_name in sorted(jobs.keys()):
    j = jobs[job_name]
    print(f"  {job_name:<36s} {j['requests']:>5d} {len(j['dates']):>4d} "
          f"{j['prompt'].avg:>10,.0f} {j['gen'].avg:>8,.0f} {j['ctx_pct'].avg:>7.1f}% "
          f"{j['pp'].avg:>9,.1f} {j['tg'].avg:>8,.1f} {j['elapsed'].avg:>10.2f}s")
print()
