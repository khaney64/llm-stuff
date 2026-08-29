#!/usr/bin/env bash
# Starts llama-swap once proxy.js is answering.
#
# launchd has no equivalent of systemd's `Requires=`/`After=`, so the ordering
# that llama-proxy.service gives llama-swap.service on llmserver has to be done
# here instead. llama-swap's checkEndpoint (/health) is proxied through
# proxy.js on 8081, so starting llama-swap first makes every model load fail
# its health check until the proxy happens to come up.
#
# This is the macOS counterpart to llama-swap/windows/start-swap.ps1.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

SWAP_BIN="${SWAP_BIN:-$HOME/llama-swap/llama-swap}"
CONFIG="${SWAP_CONFIG:-$REPO_DIR/llama-swap/configs/mac-m1.yaml}"
LISTEN="${SWAP_LISTEN:-0.0.0.0:8080}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:8081/health}"
WAIT_SECONDS="${PROXY_WAIT_SECONDS:-60}"

if [[ ! -x "$SWAP_BIN" ]]; then
    echo "start-swap.sh: llama-swap not found at $SWAP_BIN — run llama-swap/macos/install.sh" >&2
    exit 1
fi

# The proxy answers /health only once a model is loaded behind it, so a 200 is
# not required here — we just need the port to be accepting connections.
echo "start-swap.sh: waiting up to ${WAIT_SECONDS}s for proxy.js on 8081" >&2
for (( i = 0; i < WAIT_SECONDS * 2; i++ )); do
    if nc -z 127.0.0.1 8081 2>/dev/null; then
        echo "start-swap.sh: proxy.js is listening" >&2
        break
    fi
    sleep 0.5
done

if ! nc -z 127.0.0.1 8081 2>/dev/null; then
    echo "start-swap.sh: proxy.js never came up on 8081; starting llama-swap anyway" >&2
fi

echo "start-swap.sh: starting llama-swap ($CONFIG) on $LISTEN" >&2
exec "$SWAP_BIN" --config "$CONFIG" --listen "$LISTEN"
