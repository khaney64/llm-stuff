#!/usr/bin/env bash
# Bounds the launchd StandardOutPath logs on macOS. Driven by the
# com.khaney.llama-logrotate daemon on a StartInterval, so it runs with nobody
# logged in — the same requirement that put the stack in the system domain.
#
# newsyslog cannot do this job. It rotates by renaming, and launchd holds fd 1
# and 2 open on these files for the life of each daemon, so after a rename both
# processes keep writing into the renamed archive while the new file stays
# empty. That failure is silent, which makes it worse than no rotation at all.
#
# Truncating in place keeps the inode, so the open fds stay valid. launchd opens
# StandardOutPath with O_APPEND, so writes resume at offset 0 rather than
# leaving a null hole — verified on mac-m1: truncate to 0 bytes, drive two
# requests, file comes back at 151 bytes with no NULs.
#
# The window between `cp` and the truncate is small but real: anything written
# in it is lost. That is an acceptable trade for stdout logs.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "rotate-logs.sh: macOS only. Uses BSD stat and launchd log paths." >&2
    exit 2
fi

# Overridable so the script can be exercised from a scratch copy without being
# dropped into the checkout first.
REPO_DIR="${REPO_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOG_DIR="$REPO_DIR/llama-swap/logs"

# Defaults match rotating-log.ps1 on devbox. Override from the plist's
# EnvironmentVariables — a 96GB box will want different numbers than this 8GB
# one. Disk cost is (KEEP + 1) * MAX_BYTES per log file.
MAX_BYTES="${MAX_BYTES:-52428800}"   # 50MB
KEEP="${KEEP:-5}"

rotate() {
    local f="$1"

    if [[ ! -f "$f" ]]; then
        return 0
    fi

    local size
    size="$(stat -f%z "$f")"
    if (( size < MAX_BYTES )); then
        return 0
    fi

    # Shift archives down; the oldest falls off the end.
    local i
    for (( i = KEEP - 1; i >= 1; i-- )); do
        if [[ -f "$f.$i" ]]; then
            mv -f "$f.$i" "$f.$((i + 1))"
        fi
    done

    cp "$f" "$f.1"
    : > "$f"
    printf '%s rotated %s at %d bytes (keeping %d)\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$f" "$size" "$KEEP"
}

for name in proxy.log llama-swap.log; do
    rotate "$LOG_DIR/$name"
done
