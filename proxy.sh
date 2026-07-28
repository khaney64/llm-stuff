#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f "$SCRIPT_DIR/env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/env.sh"
fi

exec node ./proxy.js \
    --proxy-host 127.0.0.1 \
    --proxy-port 8081 \
    --backend-port 8082 \
    --buffer-thinking \
    --dump-messages \
    --message-size 10000 \
    --default-ctx 65535 \
    --log-mode influxdb \
    --backend llamacpp \
    --power \
    --gpu-idle 11 \
    --power-interval 250 \
    --debug-labels \
    --dump-request \
    --model-config ./proxy-models.json \
    --cron-parse-patch
