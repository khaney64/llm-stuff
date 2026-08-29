#!/usr/bin/env bash
# Start/stop/restart/status for the mac-m1 inference stack.
# Counterpart to llama-swap/linux/manage.sh and llama-swap/windows/manage.ps1.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

PROXY="com.khaney.llama-proxy"
SWAP="com.khaney.llama-swap"

# `bootstrap` fails if the job is already loaded, and `bootout` fails if it is
# not; both are the desired end state, so tolerate those specific no-ops.
boot_in() {
    local label="$1"
    local plist="$AGENT_DIR/$label.plist"
    [[ -f "$plist" ]] || { echo "manage.sh: $plist missing — run install.sh" >&2; exit 1; }
    launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null || launchctl kickstart -k "$DOMAIN/$label"
}

boot_out() {
    launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
}

case "${1:-status}" in
    start)
        # Proxy first: llama-swap health-checks models through it.
        boot_in "$PROXY"
        boot_in "$SWAP"
        ;;
    stop)
        boot_out "$SWAP"
        boot_out "$PROXY"
        ;;
    restart)
        boot_out "$SWAP"
        boot_out "$PROXY"
        boot_in "$PROXY"
        boot_in "$SWAP"
        ;;
    restart-proxy)
        # proxy.js, proxy.sh, proxy-models.json, or influxdb-env.sh changed.
        launchctl kickstart -k "$DOMAIN/$PROXY"
        ;;
    restart-swap)
        # mac-m1.yaml or macos/server.sh changed (replaces the llama.cpp child).
        launchctl kickstart -k "$DOMAIN/$SWAP"
        ;;
    status)
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
