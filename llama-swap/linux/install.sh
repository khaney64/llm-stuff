#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 /path/to/llama-swap_243_linux_amd64.tar.gz" >&2
    exit 2
fi

archive="$(readlink -f "$1")"
expected="1bb27ccbdaff0c4e42ef2356e2e7b5c693073dd57f9dcecf6c35ae6847f0b140"
actual="$(sha256sum "$archive" | awk '{print $1}')"

if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch. Expected $expected, got $actual." >&2
    exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
tar -xzf "$archive" -C "$staging"
binary="$(find "$staging" -type f -name llama-swap -print -quit)"
if [[ -z "$binary" ]]; then
    echo "llama-swap binary not found in $archive." >&2
    exit 1
fi

install -d "$HOME/llama-swap" "$HOME/.config/systemd/user"
install -m 0755 "$binary" "$HOME/llama-swap/llama-swap"
install -m 0644 "$HOME/llm-stuff/llama-swap/linux/llama-proxy.service" \
    "$HOME/.config/systemd/user/llama-proxy.service"
install -m 0644 "$HOME/llm-stuff/llama-swap/linux/llama-swap.service" \
    "$HOME/.config/systemd/user/llama-swap.service"

systemctl --user daemon-reload
"$HOME/llama-swap/llama-swap" --version
echo "Run: sudo loginctl enable-linger $USER"
echo "Then: systemctl --user enable --now llama-swap.service"
