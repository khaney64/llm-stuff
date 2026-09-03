#!/usr/bin/env bash
# Installs (or removes) the LaunchDaemon variants of the inference stack.
#
# Usage:  sudo ./install-daemons.sh [--uninstall]
#
# This is the headless trial described in macos-headless-trial.md. It does NOT
# touch the LaunchAgents in ~/Library/LaunchAgents — run the disable step in
# that document first, or both copies will fight over ports 8080/8081/8082.
#
# Deliberately does not bootstrap the daemons: the whole point is to prove they
# come up on their own after a reboot with nobody logged in.

set -euo pipefail

DAEMON_DIR="/Library/LaunchDaemons"
SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LABELS=(com.khaney.llama-proxy com.khaney.llama-swap com.khaney.llama-logrotate)

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    echo "install-daemons.sh: Apple Silicon macOS only." >&2
    exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "install-daemons.sh: must run as root (use sudo)." >&2
    exit 1
fi

# Under sudo, $HOME and $USER are root's. The daemons must reference the owning
# user's home and run as that user, so resolve both from SUDO_USER.
TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
    echo "install-daemons.sh: run via sudo from your normal account, not as root." >&2
    exit 1
fi
TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')"
[[ -d "$TARGET_HOME" ]] || { echo "install-daemons.sh: no home for $TARGET_USER" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
    for label in "${LABELS[@]}"; do
        launchctl bootout "system/$label" 2>/dev/null || true
        rm -f "$DAEMON_DIR/$label.plist"
        echo "removed $DAEMON_DIR/$label.plist"
    done
    echo
    echo "Daemons removed. Re-enable the agents with:"
    echo "  launchctl enable gui/$(id -u "$TARGET_USER")/com.khaney.llama-proxy"
    echo "  launchctl enable gui/$(id -u "$TARGET_USER")/com.khaney.llama-swap"
    echo "  $TARGET_HOME/llm-stuff/llama-swap/macos/manage.sh start"
    exit 0
fi

[[ -d "$TARGET_HOME/llm-stuff" ]] || {
    echo "install-daemons.sh: $TARGET_HOME/llm-stuff not found." >&2; exit 1; }

for label in "${LABELS[@]}"; do
    src="$SRC_DIR/$label.plist"
    dst="$DAEMON_DIR/$label.plist"
    [[ -f "$src" ]] || { echo "install-daemons.sh: missing $src" >&2; exit 1; }

    sed -e "s|__HOME__|$TARGET_HOME|g" -e "s|__USER__|$TARGET_USER|g" "$src" > "$dst"

    # launchd refuses to load a system-domain plist that is writable by anyone
    # but root, and does so with an unhelpful error.
    chown root:wheel "$dst"
    chmod 644 "$dst"
    plutil -lint "$dst" >/dev/null

    echo "installed $dst  (runs as $TARGET_USER)"
done

echo
echo "Not loaded on purpose. Reboot WITHOUT logging in, then verify over SSH:"
echo "  launchctl print system/com.khaney.llama-proxy | grep -E 'state|pid'"
echo "  $TARGET_HOME/llm-stuff/llama-swap/macos/manage.sh status   # agents: expect 'not loaded'"
echo
echo "To load them now without rebooting (weaker test — a session already exists):"
for label in "${LABELS[@]}"; do
    echo "  launchctl bootstrap system $DAEMON_DIR/$label.plist"
done
