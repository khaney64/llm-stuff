#!/usr/bin/env python3
"""Cross-platform system metrics collector. Publishes to MQTT in InfluxDB line protocol."""

import os
import sys
import time
import socket
import logging
import argparse

try:
    import psutil
except ImportError:
    sys.exit("psutil not installed. Run: pip install psutil")

try:
    import paho.mqtt.client as mqtt
    MQTT_AVAILABLE = True
except ImportError:
    MQTT_AVAILABLE = False

try:
    import yaml
except ImportError:
    sys.exit("pyyaml not installed. Run: pip install pyyaml")

try:
    import pynvml
except ImportError:
    pynvml = None

NVML_AVAILABLE = False
NVML_RETRY_SECONDS = 60
_nvml_last_try = None

IS_WINDOWS = sys.platform == "win32"

LOG = logging.getLogger("sysmetrics")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# ---------------------------------------------------------------------------
# Line protocol helpers
# ---------------------------------------------------------------------------

def _lp_val(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return f"{v}i"
    if isinstance(v, str):
        return f'"{v}"'
    return str(round(float(v), 4))


def _lp_tag(v) -> str:
    return str(v).replace(",", r"\,").replace("=", r"\=").replace(" ", r"\ ")


def lp(measurement: str, fields: dict, tags: dict = None) -> str:
    """Build an InfluxDB line protocol string (no timestamp — broker assigns wall time)."""
    tag_str = ""
    if tags:
        tag_str = "," + ",".join(f"{k}={_lp_tag(v)}" for k, v in sorted(tags.items()))
    field_str = ",".join(f"{k}={_lp_val(v)}" for k, v in fields.items())
    return f"{measurement}{tag_str} {field_str}"


# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------

def collect_cpu(host: str, prev_ctx: int | None):
    lines = []
    tags = {"host": host}
    overall = psutil.cpu_percent(interval=None)
    per_core = psutil.cpu_percent(interval=None, percpu=True)

    fields = {"usage_pct": overall}
    for i, pct in enumerate(per_core):
        fields[f"core_{i}_pct"] = pct

    freq = psutil.cpu_freq()
    if freq:
        fields["freq_mhz"] = freq.current

    stats = psutil.cpu_stats()
    if prev_ctx is not None:
        fields["ctx_switches"] = stats.ctx_switches - prev_ctx

    try:
        if not IS_WINDOWS:
            temps = psutil.sensors_temperatures()
            for name in ("coretemp", "k10temp", "cpu_thermal", "acpitz"):
                if name in temps:
                    entries = temps[name]
                    pkg = next((e for e in entries if "package" in e.label.lower()), entries[0])
                    fields["temp_c"] = pkg.current
                    break
        else:
            try:
                import urllib.request, json as _json
                with urllib.request.urlopen("http://localhost:8085/data.json", timeout=2) as r:
                    data = _json.loads(r.read())
                def _find_cpu_temp(node):
                    if node.get("Text", "").lower() in ("cpu package", "core (tctl/tdie)"):
                        val = node.get("Value", "")
                        if "°" in val:
                            return float(val.split("°")[0].strip())
                    for child in node.get("Children", []):
                        result = _find_cpu_temp(child)
                        if result is not None:
                            return result
                    return None
                temp = _find_cpu_temp(data)
                if temp is not None:
                    fields["temp_c"] = temp
            except Exception:
                pass
    except Exception:
        pass

    lines.append((f"metrics/{host}/cpu", lp("cpu", fields, tags)))
    return lines, stats.ctx_switches


def _nvml_str(v) -> str:
    # Older nvidia-ml-py releases return bytes rather than str.
    return v.decode() if isinstance(v, bytes) else v


def _nvml_ready() -> bool:
    # Started at boot, the collector can run before the NVIDIA driver is ready,
    # so a failed init is retried rather than disabling GPU metrics for good.
    global NVML_AVAILABLE, _nvml_last_try
    if NVML_AVAILABLE or pynvml is None:
        return NVML_AVAILABLE
    now = time.monotonic()
    if _nvml_last_try is not None and now - _nvml_last_try < NVML_RETRY_SECONDS:
        return False
    first_try = _nvml_last_try is None
    _nvml_last_try = now
    try:
        pynvml.nvmlInit()
        NVML_AVAILABLE = True
        if not first_try:
            LOG.info("NVML initialised after retry")
    except Exception as e:
        if first_try:
            LOG.warning("NVML init failed, retrying every %ds: %s", NVML_RETRY_SECONDS, e)
    return NVML_AVAILABLE


def collect_gpu(host: str):
    if not _nvml_ready():
        return []
    lines = []
    try:
        count = pynvml.nvmlDeviceGetCount()
        for idx in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(idx)
            # The index follows slot order and shifts when cards are added or
            # moved; the UUID stays with the physical card.
            tags = {
                "host": host,
                "gpu": str(idx),
                "gpu_uuid": _nvml_str(pynvml.nvmlDeviceGetUUID(handle)),
                "gpu_name": _nvml_str(pynvml.nvmlDeviceGetName(handle)),
            }
            fields = {}

            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            fields["gpu_util_pct"] = util.gpu

            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            fields["vram_used_mb"] = mem.used // (1024 * 1024)
            fields["vram_total_mb"] = mem.total // (1024 * 1024)

            try:
                fields["power_w"] = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except pynvml.NVMLError:
                pass

            try:
                fields["temp_c"] = pynvml.nvmlDeviceGetTemperature(
                    handle, pynvml.NVML_TEMPERATURE_GPU
                )
            except pynvml.NVMLError:
                pass

            try:
                fields["sm_clock_mhz"] = pynvml.nvmlDeviceGetClockInfo(
                    handle, pynvml.NVML_CLOCK_SM
                )
                fields["mem_clock_mhz"] = pynvml.nvmlDeviceGetClockInfo(
                    handle, pynvml.NVML_CLOCK_MEM
                )
            except pynvml.NVMLError:
                pass

            try:
                fields["fan_pct"] = pynvml.nvmlDeviceGetFanSpeed(handle)
            except pynvml.NVMLError:
                pass

            try:
                pcie_tx = pynvml.nvmlDeviceGetPcieThroughput(
                    handle, pynvml.NVML_PCIE_UTIL_TX_BYTES
                )
                pcie_rx = pynvml.nvmlDeviceGetPcieThroughput(
                    handle, pynvml.NVML_PCIE_UTIL_RX_BYTES
                )
                fields["pcie_tx_kb"] = pcie_tx
                fields["pcie_rx_kb"] = pcie_rx
            except pynvml.NVMLError:
                pass

            if fields:
                lines.append((f"metrics/{host}/gpu/{idx}", lp("gpu", fields, tags)))
    except Exception as e:
        LOG.warning("GPU collection error: %s", e)
    return lines


def collect_memory(host: str):
    GB = 1024 ** 3
    tags = {"host": host}
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    fields = {
        "used_gb": vm.used / GB,
        "avail_gb": vm.available / GB,
        "total_gb": vm.total / GB,
        "pct": vm.percent,
        "swap_used_gb": sw.used / GB,
        "swap_total_gb": sw.total / GB,
    }
    return [(f"metrics/{host}/memory", lp("memory", fields, tags))]


def collect_disk(host: str, prev_io: dict | None):
    lines = []
    GB = 1024 ** 3
    MB = 1024 ** 2

    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except PermissionError:
            continue
        dev = part.device.replace(":", "").replace("\\", "").replace("/", "_").strip("_")
        tags = {"host": host, "device": dev, "mountpoint": part.mountpoint.replace("\\", "/")}
        fields = {
            "used_gb": usage.used / GB,
            "free_gb": usage.free / GB,
            "total_gb": usage.total / GB,
            "pct": usage.percent,
        }
        lines.append((f"metrics/{host}/disk/{dev}", lp("disk", fields, tags)))

    try:
        current_io = psutil.disk_io_counters(perdisk=True)
        if prev_io and current_io:
            for dev, cur in current_io.items():
                if dev in prev_io:
                    prev = prev_io[dev]
                    tags = {"host": host, "device": dev}
                    fields = {
                        "read_mbs": (cur.read_bytes - prev.read_bytes) / MB,
                        "write_mbs": (cur.write_bytes - prev.write_bytes) / MB,
                        "read_iops": cur.read_count - prev.read_count,
                        "write_iops": cur.write_count - prev.write_count,
                    }
                    lines.append(
                        (f"metrics/{host}/disk/{dev}/io", lp("disk_io", fields, tags))
                    )
        return lines, current_io
    except Exception:
        return lines, None


def collect_network(host: str, prev_net: dict | None):
    lines = []
    MB = 1024 ** 2

    try:
        current_net = psutil.net_io_counters(pernic=True)
        if prev_net and current_net:
            for iface, cur in current_net.items():
                if iface in prev_net:
                    prev = prev_net[iface]
                    tags = {"host": host, "iface": iface}
                    fields = {
                        "sent_mbs": (cur.bytes_sent - prev.bytes_sent) / MB,
                        "recv_mbs": (cur.bytes_recv - prev.bytes_recv) / MB,
                        "sent_pkts": cur.packets_sent - prev.packets_sent,
                        "recv_pkts": cur.packets_recv - prev.packets_recv,
                        "drops_in": cur.dropin - prev.dropin,
                        "drops_out": cur.dropout - prev.dropout,
                    }
                    lines.append(
                        (f"metrics/{host}/network/{iface}", lp("network", fields, tags))
                    )
        return lines, current_net
    except Exception:
        return lines, None


def collect_system(host: str):
    boot_time = int(psutil.boot_time())
    tags = {"host": host, "boot_time": str(boot_time)}
    fields = {
        "uptime_s": int(time.time() - boot_time),
        "proc_count": len(psutil.pids()),
    }
    return [(f"metrics/{host}/system", lp("system", fields, tags))]


def collect_llm(host: str, ollama_url: str):
    """Collect Ollama model state and LLM process CPU/memory."""
    lines = []

    try:
        import urllib.request, json as _json
        with urllib.request.urlopen(f"{ollama_url}/api/ps", timeout=3) as resp:
            data = _json.loads(resp.read())
        MB = 1024 ** 2
        for m in data.get("models", []):
            model_tag = m.get("name", "unknown").replace(":", "_").replace("/", "_")
            tags = {"host": host, "model": model_tag}
            fields = {"vram_mb": m.get("size_vram", 0) // MB}
            lines.append((f"metrics/{host}/llm", lp("llm_model", fields, tags)))
    except Exception as e:
        LOG.debug("Ollama /api/ps skipped: %s", e)

    llm_proc_names = {"ollama", "llama-server", "llama.cpp", "llama_server"}
    for proc in psutil.process_iter(["name", "pid", "cpu_percent", "memory_info"]):
        try:
            name = proc.info["name"] or ""
            if any(p in name.lower() for p in llm_proc_names):
                tags = {"host": host, "proc": name}
                fields = {
                    "cpu_pct": proc.info["cpu_percent"],
                    "rss_mb": proc.info["memory_info"].rss // (1024 ** 2),
                }
                lines.append((f"metrics/{host}/llm", lp("llm_proc", fields, tags)))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    return lines


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "mqtt": {
        "host": "localhost",
        "port": 1883,
        "username": None,
        "password": None,
    },
    "hostname": None,
    "intervals": {
        "cpu": 10,
        "gpu": 5,
        "memory": 10,
        "disk": 30,
        "network": 10,
        "system": 60,
        "llm": 15,
    },
    "enable_llm": False,
    "ollama_url": "http://localhost:11434",
}


def _deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


# ---------------------------------------------------------------------------
# MQTT helpers
# ---------------------------------------------------------------------------

def _mqtt_connect(client, host: str, port: int) -> None:
    """Connect to MQTT broker, retrying with exponential backoff until success."""
    delay = 2
    attempt = 0
    while True:
        attempt += 1
        try:
            client.connect(host, port)
            LOG.info("Connected to MQTT %s:%s", host, port)
            return
        except Exception as e:
            LOG.warning("MQTT connect attempt %d failed (%s), retrying in %ds", attempt, e, delay)
            time.sleep(delay)
            delay = min(delay * 2, 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="System metrics collector")
    parser.add_argument("--config", default="config.yaml", help="Config file path")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print metrics to stdout, do not publish to MQTT"
    )
    parser.add_argument("--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    cfg = dict(DEFAULT_CONFIG)
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.config) \
        if not os.path.isabs(args.config) else args.config
    if os.path.exists(config_path):
        with open(config_path) as f:
            user_cfg = yaml.safe_load(f) or {}
        cfg = _deep_merge(cfg, user_cfg)
    else:
        LOG.warning("Config file %s not found, using defaults", config_path)

    host = cfg.get("hostname") or socket.gethostname()
    intervals = cfg["intervals"]

    client = None
    if not args.dry_run:
        if not MQTT_AVAILABLE:
            sys.exit("paho-mqtt not installed. Run: pip install paho-mqtt")
        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:
            client = mqtt.Client()  # paho-mqtt < 2.0
        mqtt_cfg = cfg["mqtt"]
        if mqtt_cfg.get("username"):
            client.username_pw_set(mqtt_cfg["username"], mqtt_cfg.get("password"))
        _mqtt_connect(client, mqtt_cfg["host"], mqtt_cfg["port"])
        client.loop_start()

    def publish(topic: str, payload: str):
        if args.dry_run:
            print(f"[{topic}] {payload}", flush=True)
        else:
            client.publish(topic, payload, qos=0)

    # Warm up psutil CPU percent — first call always returns 0.0
    psutil.cpu_percent(interval=1)
    psutil.cpu_percent(interval=None, percpu=True)

    last_run = {section: 0.0 for section in intervals}
    prev_ctx = None
    prev_io = None
    prev_net = None

    LOG.info("Collecting metrics for host=%s (dry_run=%s)", host, args.dry_run)

    try:
        while True:
            now = time.time()

            if now - last_run["cpu"] >= intervals["cpu"]:
                try:
                    lines, prev_ctx = collect_cpu(host, prev_ctx)
                    for topic, payload in lines:
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("CPU: %s", e)
                last_run["cpu"] = now

            if now - last_run["gpu"] >= intervals["gpu"]:
                try:
                    for topic, payload in collect_gpu(host):
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("GPU: %s", e)
                last_run["gpu"] = now

            if now - last_run["memory"] >= intervals["memory"]:
                try:
                    for topic, payload in collect_memory(host):
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("Memory: %s", e)
                last_run["memory"] = now

            if now - last_run["disk"] >= intervals["disk"]:
                try:
                    lines, prev_io = collect_disk(host, prev_io)
                    for topic, payload in lines:
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("Disk: %s", e)
                last_run["disk"] = now

            if now - last_run["network"] >= intervals["network"]:
                try:
                    lines, prev_net = collect_network(host, prev_net)
                    for topic, payload in lines:
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("Network: %s", e)
                last_run["network"] = now

            if now - last_run["system"] >= intervals["system"]:
                try:
                    for topic, payload in collect_system(host):
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("System: %s", e)
                last_run["system"] = now

            if cfg.get("enable_llm") and now - last_run["llm"] >= intervals["llm"]:
                try:
                    for topic, payload in collect_llm(host, cfg["ollama_url"]):
                        publish(topic, payload)
                except Exception as e:
                    LOG.error("LLM: %s", e)
                last_run["llm"] = now

            time.sleep(1)

    except KeyboardInterrupt:
        LOG.info("Shutting down")
    finally:
        if client:
            client.loop_stop()
            client.disconnect()
        if NVML_AVAILABLE:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass


if __name__ == "__main__":
    main()
