#!/usr/bin/env bash
# Start/stop/restart/status for the mac-m1 inference stack.
# Counterpart to llama-swap/linux/manage.sh and llama-swap/windows/manage.ps1.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

PROXY="com.khaney.llama-proxy"
SWAP="com.khaney.llama-swap"

is_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

domain_up() { launchctl print "$DOMAIN" >/dev/null 2>&1; }

# LaunchAgents live in the Aqua session, so gui/<uid> exists only while someone
# is logged in at the desktop. Over SSH with the machine sitting at the login
# window every bootstrap fails with "125: Domain does not support specified
# action" and the stack just stays down. Diagnose that once, up front, instead
# of retrying into a wall and reporting a generic failure.
domain_hint() {
    echo "manage.sh: launchd domain $DOMAIN is not reachable." >&2
    echo "  LaunchAgents only run inside a logged-in desktop session." >&2
    echo "  Console is currently owned by: $(stat -f '%Su' /dev/console)" >&2
    echo "  Log in at the console or via Screen Sharing, or enable automatic" >&2
    echo "  login (System Settings > Users & Groups) for unattended boots." >&2
}

require_domain() { domain_up || { domain_hint; exit 1; }; }

# `bootout` returns before launchd has finished tearing the job down. Bootstrapping
# into that window fails ("Operation in progress") and so does kickstart, because
# the job is neither fully loaded nor fully gone — which silently leaves the
# service stopped. Wait for it to actually disappear.
boot_out() {
    local label="$1"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    for _ in $(seq 1 100); do
        is_loaded "$label" || return 0
        sleep 0.1
    done
    echo "manage.sh: $label still loaded 10s after bootout" >&2
    return 1
}

# `bootstrap` fails if the job is already loaded; kickstart is the right verb then.
boot_in() {
    local label="$1"
    local plist="$AGENT_DIR/$label.plist"
    [[ -f "$plist" ]] || { echo "manage.sh: $plist missing — run install.sh" >&2; exit 1; }
    if is_loaded "$label"; then
        launchctl kickstart -k "$DOMAIN/$label"
        return
    fi
    # Keep the last attempt's stderr: "failed to bootstrap" on its own sends you
    # hunting, while launchctl's own message usually names the cause outright.
    local err=""
    for _ in $(seq 1 30); do
        err=$(launchctl bootstrap "$DOMAIN" "$plist" 2>&1) && return 0
        is_loaded "$label" && return 0
        sleep 0.5
    done
    echo "manage.sh: failed to bootstrap $label: ${err:-(no output from launchctl)}" >&2
    return 1
}

case "${1:-status}" in
    start)
        require_domain
        # Proxy first: llama-swap health-checks models through it.
        boot_in "$PROXY"
        boot_in "$SWAP"
        ;;
    stop)
        # No domain check: with no session there is nothing loaded to stop, and
        # stop should stay idempotent.
        boot_out "$SWAP"
        boot_out "$PROXY"
        ;;
    restart)
        require_domain
        boot_out "$SWAP"
        boot_out "$PROXY"
        boot_in "$PROXY"
        boot_in "$SWAP"
        # Both agents must actually be loaded afterwards; a silent half-start is
        # the failure mode this command exists to avoid.
        for label in "$PROXY" "$SWAP"; do
            is_loaded "$label" || { echo "manage.sh: $label did not come back up" >&2; exit 1; }
        done
        ;;
    restart-proxy)
        # proxy.js, proxy.sh, proxy-models.json, or influxdb-env.sh changed.
        require_domain
        launchctl kickstart -k "$DOMAIN/$PROXY"
        ;;
    restart-swap)
        # mac-m1.yaml or macos/server.sh changed (replaces the llama.cpp child).
        require_domain
        launchctl kickstart -k "$DOMAIN/$SWAP"
        ;;
    status)
        # Report rather than exit: an unreachable domain is the answer to
        # "why does everything say not loaded", not a reason to refuse.
        domain_up || domain_hint
        for label in "$PROXY" "$SWAP"; do
            echo "── $label ──"
            launchctl print "$DOMAIN/$label" 2>/dev/null \
                | grep -E '^\s+(state|pid|last exit code|path) ' || echo "  not loaded"
        done
        echo "── listeners ──"
        lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:8082 -sTCP:LISTEN 2>/dev/null || echo "  none on 8080/8081/8082"
        ;;
    logs)
        exec tail -n 100 -F "$REPO_DIR/llama-swap/logs/proxy.log" "$REPO_DIR/llama-swap/logs/llama-swap.log"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|restart-proxy|restart-swap|status|logs}" >&2
        exit 2
        ;;
esac
