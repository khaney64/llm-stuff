#!/usr/bin/env bash
# macOS (Apple Silicon) llama.cpp model catalog and launcher.
#
# This is the mac-m1 counterpart to llmserver's host-local $HOME/llama/server.sh
# and devbox's server.ps1. It is committed to the repo rather than kept
# host-local so the M5 Ultra can be brought up from a known-good starting point
# instead of a blank file; nothing in it is secret.
#
# llama-swap owns the process lifetime and passes only --model/--port/--host.
# Everything model-specific (path, context, batch, alias, pooling, flags) lives
# here, so changing a model's settings here changes its next launch.
#
# Usage: server.sh --model ID [--port N] [--host ADDR] [--list] [--dry-run]
#
# macOS notes:
#   - Written for the stock bash 3.2 (no associative arrays).
#   - -ngl 999 offloads every layer to Metal; on unified memory this is a
#     bookkeeping choice, not a copy, but it still counts against the
#     iogpu.wired_limit_mb ceiling (0 = system default, ~75% of RAM).
#   - Contexts here are deliberately small: this 8GB M1 has ~2-2.5GB of real
#     headroom at idle. Raise them on a machine that has the memory.

set -euo pipefail

LLAMA_HOME="${LLAMA_HOME:-$HOME/llama}"
LLAMA_BIN="${LLAMA_BIN:-$LLAMA_HOME/llama.cpp/build/bin/llama-server}"
MODEL_DIR="${MODEL_DIR:-$LLAMA_HOME/models}"

MODEL_NAMES="qwen25-coder-1.5b nomic-embed"

model=""
port="8082"
host="127.0.0.1"
dry_run=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)   model="${2:-}"; shift 2 ;;
        --port)    port="${2:-}";  shift 2 ;;
        --host)    host="${2:-}";  shift 2 ;;
        --dry-run) dry_run=1;      shift ;;
        --list)    echo "$MODEL_NAMES" | tr ' ' '\n'; exit 0 ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "server.sh: unknown argument '$1'" >&2; exit 2 ;;
    esac
done

if [[ -z "$model" ]]; then
    echo "server.sh: --model is required (one of: $MODEL_NAMES)" >&2
    exit 2
fi

# ── Per-model settings ───────────────────────────────────────────────────────
# M_FILE  gguf filename under $MODEL_DIR
# M_ALIAS name llama.cpp serves under; must match useModelName in the
#         llama-swap config, or llama-swap and the harness disagree on the ID
# M_ARGS  everything else
case "$model" in
    qwen25-coder-1.5b)
        M_FILE="qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
        M_ALIAS="qwen25-coder-1.5b"
        # 8192 ctx ~= 230MB of KV on this model; with the 1.1GB of weights and
        # compute buffers that lands near 1.6GB, inside this box's headroom.
        M_ARGS="-c 8192 -b 2048 -ub 512 -ngl 999 --flash-attn on --jinja --cache-reuse 256 --parallel 1 --no-mmap"
        ;;
    nomic-embed)
        M_FILE="nomic-embed-text-v1.5.f16.gguf"
        M_ALIAS="nomic-embed"
        # Non-causal embedding model: llama.cpp requires the physical batch to
        # cover the whole context, so -ub must equal -c. Mean pooling is what
        # nomic-embed-text-v1.5 was trained with.
        M_ARGS="--embedding --pooling mean -c 2048 -b 2048 -ub 2048 -ngl 999 --parallel 1 --no-mmap"
        ;;
    *)
        echo "server.sh: unknown model '$model' (known: $MODEL_NAMES)" >&2
        exit 2
        ;;
esac

model_path="$MODEL_DIR/$M_FILE"

if [[ ! -x "$LLAMA_BIN" ]]; then
    echo "server.sh: llama-server not found or not executable at $LLAMA_BIN" >&2
    echo "server.sh: build it first — see macos-setup.md" >&2
    exit 1
fi

if [[ ! -f "$model_path" ]]; then
    echo "server.sh: model file not found: $model_path" >&2
    exit 1
fi

# shellcheck disable=SC2206  # M_ARGS is a deliberate word-split argument list
cmd=("$LLAMA_BIN" -m "$model_path" -a "$M_ALIAS" --host "$host" --port "$port" $M_ARGS)

if [[ $dry_run -eq 1 ]]; then
    printf '%q ' "${cmd[@]}"; echo
    exit 0
fi

echo "server.sh: starting $model ($M_ALIAS) on $host:$port" >&2
exec "${cmd[@]}"
