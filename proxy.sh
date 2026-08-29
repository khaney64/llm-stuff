#!/usr/bin/env bash
# Launcher for proxy.js on the Linux and macOS inference nodes.
# (Windows uses proxy.ps1; its settings are kept in sync by hand.)
#
# Usage: proxy.sh [host-profile]
#
# The host profile picks the handful of settings that genuinely differ between
# boxes — power provider, idle-power baseline, context fallback. Everything
# else is shared, so a change to the common flags applies everywhere.
#
# Profile resolution, first match wins:
#   1. $1                      — explicit, e.g. `./proxy.sh mac-m1`
#   2. $PROXY_HOST_PROFILE     — for a service unit that wants to pin it
#   3. `hostname -s`           — the normal path
#   4. `uname -s`              — unknown host: pick sane defaults by OS so a
#                                new box (e.g. the M5) runs before it is named

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Secrets (InfluxDB credentials). Both names are gitignored; llmserver uses
# env.sh, mac-m1 uses influxdb-env.sh. Source whichever exist.
for env_file in "$SCRIPT_DIR/env.sh" "$SCRIPT_DIR/influxdb-env.sh"; do
    if [[ -f "$env_file" ]]; then
        # shellcheck disable=SC1090
        source "$env_file"
    fi
done

# These files get hand-copied between the Windows, Linux and macOS boxes, and a
# CRLF copy leaves a trailing \r on every value. The token then produces
# "Invalid character in header content [Authorization]" from Node and every
# InfluxDB write fails, with nothing obviously wrong in the file.
for var in INFLUXDB_URL INFLUXDB_ORG INFLUXDB_BUCKET INFLUXDB_TOKEN; do
    if [[ -n "${!var:-}" ]]; then
        printf -v "$var" '%s' "${!var//$'\r'/}"
        export "${var?}"
    fi
done

profile="${1:-${PROXY_HOST_PROFILE:-$(hostname -s)}}"

# ── Host profiles ────────────────────────────────────────────────────────────
# POWER_PROVIDER  power module passed to --power-provider
# GPU_IDLE        watts to treat as baseline; anything above it during a
#                 request is charged to inference (--gpu-idle)
# DEFAULT_CTX     context fallback used only until /props reports the real n_ctx
case "$profile" in
    llmserver|llm-ubuntu)
        POWER_PROVIDER="./power-nvidia-smi.js"
        GPU_IDLE=11
        DEFAULT_CTX=65535
        ;;
    devbox)
        POWER_PROVIDER="./power-nvidia-smi.js"
        GPU_IDLE=15
        DEFAULT_CTX=65535
        ;;
    mac-m1)
        # macmon reports Apple GPU power only (see power-macos.js). Measured
        # idle on this M1 is ~0.002W against ~2.5W average under Metal
        # inference, so the baseline to subtract is effectively zero — unlike
        # the discrete-GPU boxes, which idle at 11-15W.
        POWER_PROVIDER="./power-macos.js"
        GPU_IDLE=0
        DEFAULT_CTX=8192
        ;;
    *)
        case "$(uname -s)" in
            Darwin)
                echo "proxy.sh: unknown profile '$profile'; using macOS defaults" >&2
                POWER_PROVIDER="./power-macos.js"
                GPU_IDLE=0
                DEFAULT_CTX=8192
                ;;
            *)
                echo "proxy.sh: unknown profile '$profile'; using NVIDIA/Linux defaults" >&2
                POWER_PROVIDER="./power-nvidia-smi.js"
                GPU_IDLE=11
                DEFAULT_CTX=65535
                ;;
        esac
        ;;
esac

echo "proxy.sh: profile=$profile provider=$POWER_PROVIDER gpu-idle=${GPU_IDLE}W default-ctx=$DEFAULT_CTX" >&2

exec node ./proxy.js \
    --proxy-host 127.0.0.1 \
    --proxy-port 8081 \
    --backend-port 8082 \
    --buffer-thinking \
    --dump-messages \
    --message-size 10000 \
    --default-ctx "$DEFAULT_CTX" \
    --log-mode influxdb \
    --backend llamacpp \
    --power \
    --power-provider "$POWER_PROVIDER" \
    --gpu-idle "$GPU_IDLE" \
    --power-interval 250 \
    --debug-labels \
    --dump-request \
    --model-config ./proxy-models.json \
    --cron-parse-patch
