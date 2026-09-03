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
#   - Models are served from $MODEL_DIR by a bare relative name that must equal
#     the llama-swap model id — see the note above the case block for why.
#   - Written for the stock bash 3.2 (no associative arrays), like server.sh.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "server-mlx.sh: macOS only. Linux/Windows use their own launchers." >&2
    exit 2
fi

MLX_HOME="${MLX_HOME:-$HOME/mlx}"
MLX_PY="${MLX_PY:-$MLX_HOME/venv/bin/python}"
MODEL_DIR="${MODEL_DIR:-$MLX_HOME/models}"

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
# M_NAME  directory under $MODEL_DIR holding the MLX weights. It doubles as the
#         name passed to --model, and must equal the llama-swap model id.
# M_ARGS  everything else
#
# Why the names have to match: mlx-lm resolves the *request's* model field, not
# just the one it was started with. ModelProvider._model_map holds exactly one
# entry ("default_model" -> the --model argument), so any other name falls
# through to a Hugging Face lookup — llama-swap sending `qwen25-coder-1.5b-mlx`
# made it try to download a repo by that name and 404. Serving from $MODEL_DIR
# with a bare relative name makes the request, the load key and the response
# agree, so nothing reloads and nothing is fetched. mlx-lm also echoes the
# request's model string straight back, and proxy.js takes the InfluxDB `model`
# tag from that, so this is what keeps the tag readable instead of a filesystem
# path or "default_model".
case "$model" in
    qwen25-coder-1.5b-mlx)
        # 4-bit MLX build of the same weights server.sh serves as
        # qwen2.5-coder-1.5b-instruct-q4_k_m.gguf, so the two are comparable.
        #
        # Unlike a GGUF this is a directory, not a file: config.json, the
        # tokenizer set, and model.safetensors must all be present or mlx-lm
        # cannot load it.
        M_NAME="qwen25-coder-1.5b-mlx"
        # Prompt cache is what makes MLX's cached-token reporting comparable to
        # llama.cpp's --cache-reuse; without it there is nothing to report.
        M_ARGS="--prompt-cache-size 32768"
        ;;
    *)
        echo "server-mlx.sh: unknown model '$model' (known: $MODEL_NAMES)" >&2
        exit 2 ;;
esac

if [[ ! -f "$MODEL_DIR/$M_NAME/config.json" ]]; then
    echo "server-mlx.sh: no MLX model at $MODEL_DIR/$M_NAME" >&2
    echo "  It must be a directory (config.json + tokenizer + model.safetensors)," >&2
    echo "  named for the llama-swap model id. A symlink to the upstream name is fine:" >&2
    echo "    ln -s Qwen2.5-Coder-1.5B-Instruct-4bit $MODEL_DIR/$M_NAME" >&2
    exit 1
fi

# Relative name resolved from $MODEL_DIR, so --model stays a bare id.
cd "$MODEL_DIR"
cmd="$MLX_PY -m mlx_lm server --model $M_NAME --host $host --port $port $M_ARGS"

if [[ "$dry_run" -eq 1 ]]; then
    echo "(cwd $MODEL_DIR) $cmd"
    exit 0
fi

echo "server-mlx.sh: starting $model from $MODEL_DIR/$M_NAME on $host:$port" >&2
exec $cmd
