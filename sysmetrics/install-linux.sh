#!/bin/bash
# Install sysmetrics as a systemd service on Ubuntu/Debian.
# Run as root: sudo bash install-linux.sh
set -e

INSTALL_DIR=/opt/sysmetrics
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing sysmetrics to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/sysmetrics.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/sysmetrics.service" /etc/systemd/system/

echo "==> Creating Python virtual environment"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$SCRIPT_DIR/config.yaml" "$INSTALL_DIR/"
    echo ""
    echo "  --> Edit $INSTALL_DIR/config.yaml before starting:"
    echo "      - Set mqtt.host to your broker address"
    echo "      - Set enable_llm: true if this is llmserver"
    echo ""
fi

systemctl daemon-reload
systemctl enable sysmetrics

echo "==> Done. Commands:"
echo "    systemctl start sysmetrics"
echo "    systemctl status sysmetrics"
echo "    journalctl -u sysmetrics -f"
