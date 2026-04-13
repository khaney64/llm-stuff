# Ubuntu Host Setup — LLM Proxy

Deployment runbook for running `proxy.js` on a new Ubuntu box (RTX 4070) alongside the existing Windows host.

## Portability summary

No proxy code changes are required. `power-nvidia-smi.js` invokes `nvidia-smi` by bare command name (via `execFile`), and `nvidia-smi`'s `--query-gpu=power.draw --format=csv,noheader,nounits` output is identical on Linux and Windows. `influxdb-client.js` is pure HTTP on Node built-ins, and `proxy.js` uses cross-platform Node APIs (`path`, `fs`, `os`). The InfluxDB `host` tag auto-detects via `os.hostname()`, so the Ubuntu hostname flows through to metrics automatically.

## Prerequisites

1. **NVIDIA driver** (provides `nvidia-smi`):
   ```bash
   sudo ubuntu-drivers install
   # or pick a specific version: sudo apt install nvidia-driver-550
   sudo reboot
   ```
   Verify with the exact command the proxy runs:
   ```bash
   nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits
   ```
   Must return a numeric watts value (e.g., `18.42`).

2. **Node.js** — match the version used on the Windows box. Check with `node -v` on Windows, then install the same major version on Ubuntu:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

3. **Distinct hostname** so the `host` tag differs from the Windows machine (otherwise they collide in InfluxDB):
   ```bash
   sudo hostnamectl set-hostname llm-ubuntu
   ```

## Copy the proxy

From the Windows box (or another machine with access), copy the `llm-stuff/` directory to the Ubuntu host:

```bash
rsync -av --exclude='*.log' --exclude='requests/' --exclude='*.png' \
  /c/development/ai/llm-stuff/ kevin@llm-ubuntu:/home/kevin/llm-stuff/
```

## Translate environment variables

On Ubuntu, create `/home/kevin/llm-stuff/.env.influxdb` from the existing `influxdb-env.ps1`. Use systemd `EnvironmentFile` format — `KEY=VALUE`, no `export`, no quotes:

```
INFLUXDB_URL=http://<your-influx-host>:8086
INFLUXDB_ORG=<your-org>
INFLUXDB_BUCKET=<your-bucket>
INFLUXDB_TOKEN=<your-token>
```

Lock it down:
```bash
chmod 600 /home/kevin/llm-stuff/.env.influxdb
```

## Create the systemd service

File: `/etc/systemd/system/llm-proxy.service`

```ini
[Unit]
Description=LLM Proxy (InfluxDB + nvidia-smi power logging)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kevin
WorkingDirectory=/home/kevin/llm-stuff
EnvironmentFile=/home/kevin/llm-stuff/.env.influxdb
ExecStart=/usr/bin/node proxy.js --power --log-mode influxdb
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llm-proxy
systemctl status llm-proxy
```

## Verification

1. **Pre-flight nvidia-smi:** `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits` returns a numeric watts value.
2. **Manual smoke test** (before letting systemd own the process):
   ```bash
   cd /home/kevin/llm-stuff
   node proxy.js --power --log-mode influxdb
   ```
   Issue a test request against the proxy's port, then confirm InfluxDB has new points tagged `host=llm-ubuntu`.
3. **Dashboard filter:** reimport `grafana-llm-dashboard.json` into Grafana. The `host` dropdown should populate with both hostnames; selecting each isolates that host's metrics.
4. **systemd:** `systemctl status llm-proxy` shows `active (running)`; `journalctl -u llm-proxy -f` streams clean startup logs. Kill the process and confirm `Restart=on-failure` brings it back.
5. **Cross-host sanity:** drive load on Windows and Ubuntu simultaneously. Both hosts appear in the `host` dropdown; `All` aggregates both.

## Troubleshooting

- **Live logs:** `journalctl -u llm-proxy -f`
- **Recent logs since last boot:** `journalctl -u llm-proxy -b`
- **`nvidia-smi: command not found`:** NVIDIA driver not installed or not on the service's PATH. Reinstall the driver, reboot, and re-test as the `kevin` user.
- **`401 Unauthorized` from InfluxDB:** wrong token or org in `.env.influxdb`. Confirm the file is loaded: `sudo systemctl show llm-proxy -p Environment`.
- **Port collision:** another service (or a leftover `node` process) already holds the proxy's listen port. `ss -ltnp | grep <port>` to find the culprit.
- **Hostname still matches Windows box:** `hostnamectl` to confirm; restart the service after changing so the new `os.hostname()` value is picked up.
