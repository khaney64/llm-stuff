#!/usr/bin/env bash
# macOS (Apple Silicon) MLX model catalog and launcher.
#
# Sibling of server.sh, which does the same job for llama.cpp. Same contract:
# llama-swap owns the process lifetime and passes only --model/--port/--host,
# and everything model-specific lives here.
#
# Exists so MLX and llama.cpp can be compared on the same box without editing
# config back and forth — each backend gets its own llama-swap model entry,
# both bound to the same port, and llama-swap swaps between them on demand.
# See m1-discovery-plan.md section 4.
#
# Usage: server-mlx.sh --model ID [--port N] [--host ADDR] [--list] [--dry-run]
#
# MLX notes:
#   - MLX does NOT read GGUF. mlx_lm/gguf.py is export-only (convert_to_gguf,
#     reachable from `mlx_lm.fuse --export-gguf`); there is no load path. Models
#     are safetensors + config.json + tokenizer, so each one is a separate
#     download from the llama.cpp GGUF of the same weights.
#   - MODEL ids below are Hugging Face repo ids. mlx-lm resolves and caches them
#     under ~/.cache/huggingface; a local directory path works too.
#   - Written for the stock bash 3.2 (no associative arrays), like server.sh.

set -euo pipefail

MLX_HOME="${MLX_HOME:-$HOME/mlx}"
MLX_PY="${MLX_PY:-$MLX_HOME/venv/bin/python}"

MODEL_NAMES="qwen25-coder-1.5b-mlx"

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
            sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "server-mlx.sh: unknown argument '$1'" >&2; exit 2 ;;
    esac
done

if [[ -z "$model" ]]; then
    echo "server-mlx.sh: --model is required (one of: $MODEL_NAMES)" >&2
    exit 2
fi

if [[ ! -x "$MLX_PY" ]]; then
    echo "server-mlx.sh: no venv python at $MLX_PY — create it with:" >&2
    echo "  /opt/homebrew/bin/python3 -m venv $MLX_HOME/venv && $MLX_HOME/venv/bin/pip install mlx-lm" >&2
    exit 1
fi

# ── Per-model settings ───────────────────────────────────────────────────────
# M_REPO  Hugging Face repo id (or local path) of the MLX-format weights
# M_ARGS  everything else
case "$model" in
    qwen25-coder-1.5b-mlx)
        # 4-bit MLX build of the same weights server.sh serves as
        # qwen2.5-coder-1.5b-instruct-q4_k_m.gguf, so the two are comparable.
        M_REPO="mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit"
        # Prompt cache is what makes MLX's cached-token reporting comparable to
        # llama.cpp's --cache-reuse; without it there is nothing to report.
        M_ARGS="--prompt-cache-size 32768"
        ;;
    *)
        echo "server-mlx.sh: unknown model '$model' (known: $MODEL_NAMES)" >&2
        exit 2 ;;
esac

cmd="$MLX_PY -m mlx_lm server --model $M_REPO --host $host --port $port $M_ARGS"

if [[ "$dry_run" -eq 1 ]]; then
    echo "$cmd"
    exit 0
fi

echo "server-mlx.sh: starting $model ($M_REPO) on $host:$port" >&2
exec $cmd
