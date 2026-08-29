#!/usr/bin/env bash
# Installs the pinned llama-swap binary and the two launchd agents on macOS.
# Counterpart to llama-swap/linux/install.sh.
#
# Usage: install.sh [/path/to/llama-swap_243_darwin_arm64.tar.gz]
#
# With no argument the archive is downloaded from the pinned release. Either
# way its SHA-256 is checked against the value published in the release's
# llama-swap_243_checksums.txt before anything is installed.

set -euo pipefail

VERSION="243"
ARCHIVE_NAME="llama-swap_${VERSION}_darwin_arm64.tar.gz"
URL="https://github.com/mostlygeek/llama-swap/releases/download/v${VERSION}/${ARCHIVE_NAME}"
EXPECTED="81280e39eab3ffe13afebc5c1c7347bebea5f36f88a44b2926284d6f27dd03ef"

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    echo "install.sh: this installer is for Apple Silicon macOS only." >&2
    exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

if [[ $# -ge 1 ]]; then
    archive="$1"
    [[ -f "$archive" ]] || { echo "install.sh: no such file: $archive" >&2; exit 1; }
else
    archive="$staging/$ARCHIVE_NAME"
    echo "install.sh: downloading $URL"
    curl -fsSL -o "$archive" "$URL"
fi

actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual" != "$EXPECTED" ]]; then
    echo "install.sh: checksum mismatch. Expected $EXPECTED, got $actual." >&2
    exit 1
fi

tar -xzf "$archive" -C "$staging"
binary="$(find "$staging" -type f -name llama-swap -print -quit)"
if [[ -z "$binary" ]]; then
    echo "install.sh: llama-swap binary not found in $archive." >&2
    exit 1
fi

install -d "$HOME/llama-swap" "$AGENT_DIR" "$REPO_DIR/llama-swap/logs"
install -m 0755 "$binary" "$HOME/llama-swap/llama-swap"

# Gatekeeper quarantines anything downloaded via curl; without this the first
# exec dies with "cannot be opened because the developer cannot be verified".
xattr -d com.apple.quarantine "$HOME/llama-swap/llama-swap" 2>/dev/null || true

# launchd does not expand ~ or $HOME inside plist values, so bake the real path
# in at install time rather than shipping a plist that only works for one user.
for label in llama-proxy llama-swap; do
    src="$REPO_DIR/llama-swap/macos/com.khaney.${label}.plist"
    dst="$AGENT_DIR/com.khaney.${label}.plist"
    sed "s|__HOME__|$HOME|g" "$src" > "$dst"
    chmod 0644 "$dst"
    plutil -lint "$dst" >/dev/null
done

"$HOME/llama-swap/llama-swap" --version

cat <<MSG

Installed:
  $HOME/llama-swap/llama-swap
  $AGENT_DIR/com.khaney.llama-proxy.plist
  $AGENT_DIR/com.khaney.llama-swap.plist

Next:
  1. Create $REPO_DIR/influxdb-env.sh with the INFLUXDB_* exports (gitignored).
  2. Start the stack:  $REPO_DIR/llama-swap/macos/manage.sh start
  3. For start-at-boot without an interactive login, enable automatic login
     (System Settings > Users & Groups > Automatic login). LaunchAgents only
     run inside a user session; this is the macOS analogue of
     \`loginctl enable-linger\` on llmserver.
MSG
