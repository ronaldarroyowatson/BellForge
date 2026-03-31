from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _hostname() -> str:
    return socket.gethostname()


def _local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


async def _external_ip() -> str | None:
    urls = (
        "https://api.ipify.org?format=json",
        "https://ifconfig.me/all.json",
    )
    timeout = httpx.Timeout(1.8)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for url in urls:
            try:
                response = await client.get(url)
                response.raise_for_status()
                data = response.json()
                if isinstance(data, dict):
                    ip = data.get("ip") or data.get("ip_addr")
                    if isinstance(ip, str) and ip:
                        return ip
            except Exception:
                continue
    return None


async def _ping_ms(host: str = "1.1.1.1", port: int = 53, attempts: int = 3) -> float | None:
    samples: list[float] = []
    for _ in range(attempts):
        start = time.perf_counter()
        try:
            connection = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(connection, timeout=1.0)
            writer.close()
            await writer.wait_closed()
            _ = reader
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            samples.append(elapsed_ms)
        except Exception:
            continue
    if not samples:
        return None
    return sum(samples) / len(samples)


async def _throughput_mbps() -> float | None:
    url = "https://speed.cloudflare.com/__down?bytes=262144"
    timeout = httpx.Timeout(3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            start = time.perf_counter()
            response = await client.get(url)
            response.raise_for_status()
            elapsed = max(time.perf_counter() - start, 0.001)
            byte_count = len(response.content)
            mbps = (byte_count * 8) / elapsed / 1_000_000
            return round(mbps, 2)
        except Exception:
            return None


async def _backend_reachable() -> bool:
    async with httpx.AsyncClient(timeout=1.0) as client:
        for url in ("http://127.0.0.1:8000/health", "http://localhost:8000/health"):
            try:
                response = await client.get(url)
                if response.status_code == 200:
                    return True
            except Exception:
                continue
    return False


def _service_running(service_name: str) -> bool:
    if sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                ["systemctl", "is-active", service_name],
                capture_output=True,
                text=True,
                check=False,
            )
            return result.stdout.strip() == "active"
        except Exception:
            return False

    if sys.platform.startswith("win"):
        try:
            result = subprocess.run(
                ["sc", "query", service_name],
                capture_output=True,
                text=True,
                check=False,
            )
            return "RUNNING" in result.stdout
        except Exception:
            return False

    return False


def _uptime_seconds() -> float | None:
    proc_uptime = Path("/proc/uptime")
    if proc_uptime.is_file():
        try:
            return float(proc_uptime.read_text(encoding="utf-8").split()[0])
        except Exception:
            return None

    if sys.platform.startswith("win"):
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime"],
                capture_output=True,
                text=True,
                check=False,
            )
            text = result.stdout.strip()
            if text:
                boot = datetime.fromisoformat(text.replace("Z", "+00:00"))
                return max((datetime.now(boot.tzinfo) - boot).total_seconds(), 0.0)
        except Exception:
            return None

    return None


def _cpu_temp_c() -> float | None:
    sensor_path = Path("/sys/class/thermal/thermal_zone0/temp")
    if sensor_path.is_file():
        try:
            return round(int(sensor_path.read_text(encoding="utf-8").strip()) / 1000.0, 1)
        except Exception:
            return None
    return None


def _cpu_load() -> float | None:
    try:
        get_loadavg = getattr(os, "getloadavg", None)
        if get_loadavg is None:
            return None
        loads = get_loadavg()
        return round(float(loads[0]), 2)
    except Exception:
        return None


def _memory_usage() -> dict[str, float | int | None]:
    if Path("/proc/meminfo").is_file():
        values: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, raw = line.split(":", 1)
            amount = raw.strip().split()[0]
            values[key] = int(amount)
        total_kb = values.get("MemTotal", 0)
        available_kb = values.get("MemAvailable", 0)
        used_kb = max(total_kb - available_kb, 0)
        pct = (used_kb / total_kb * 100.0) if total_kb else None
        return {
            "total_bytes": total_kb * 1024,
            "used_bytes": used_kb * 1024,
            "percent": round(pct, 2) if pct is not None else None,
        }

    return {"total_bytes": None, "used_bytes": None, "percent": None}


def _disk_usage() -> dict[str, float | int | None]:
    try:
        disk = shutil.disk_usage("/")
        pct = (disk.used / disk.total * 100.0) if disk.total else None
        return {
            "total_bytes": disk.total,
            "used_bytes": disk.used,
            "percent": round(pct, 2) if pct is not None else None,
        }
    except Exception:
        return {"total_bytes": None, "used_bytes": None, "percent": None}


async def _scan_for_bellforge_devices(local_ip: str | None) -> list[dict[str, str]]:
    if not local_ip:
        return []

    arp_ips: list[str] = []
    try:
        result = subprocess.run(["arp", "-a"], capture_output=True, text=True, check=False)
        for line in result.stdout.splitlines():
            parts = [segment for segment in line.split(" ") if segment]
            if parts and parts[0].count(".") == 3:
                candidate = parts[0]
                if candidate != local_ip:
                    arp_ips.append(candidate)
    except Exception:
        return []

    unique_ips = sorted(set(arp_ips))[:25]
    if not unique_ips:
        return []

    async def _probe(ip: str) -> dict[str, str] | None:
        async with httpx.AsyncClient(timeout=0.6) as client:
            try:
                response = await client.get(f"http://{ip}:8000/health")
                if response.status_code == 200:
                    return {"ip": ip, "status": "reachable"}
            except Exception:
                return None
        return None

    results = await asyncio.gather(*[_probe(ip) for ip in unique_ips])
    return [item for item in results if item is not None]


def _manifest_hash(config_dir: Path) -> str | None:
    manifest_path = config_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    digest = hashlib.sha256()
    digest.update(manifest_path.read_bytes())
    return digest.hexdigest()


async def collect_device_status(project_root: Path) -> dict[str, Any]:
    config_dir = project_root / "config"
    version_data = _read_json(config_dir / "version.json")

    local_ip = _local_ip()
    external_ip_task = _external_ip()
    ping_task = _ping_ms()
    throughput_task = _throughput_mbps()
    backend_task = _backend_reachable()
    neighbors_task = _scan_for_bellforge_devices(local_ip)

    external_ip, ping_ms, throughput_mbps, backend_ok, neighbors = await asyncio.gather(
        external_ip_task,
        ping_task,
        throughput_task,
        backend_task,
        neighbors_task,
    )

    connectivity = {
        "online": bool(ping_ms is not None or throughput_mbps is not None),
        "ping_ms": round(ping_ms, 2) if ping_ms is not None else None,
        "throughput_mbps": throughput_mbps,
    }

    return {
        "timestamp": _utc_now(),
        "hostname": _hostname(),
        "ip_address": {
            "local": local_ip,
            "external": external_ip,
        },
        "network_connectivity": connectivity,
        "backend_reachable": backend_ok,
        "autoupdater_running": _service_running("bellforge-updater.service"),
        "repair_service_running": _service_running("bellforge-repair.service"),
        "other_bellforge_devices": neighbors,
        "version": version_data.get("version"),
        "manifest_hash": _manifest_hash(config_dir),
        "uptime_seconds": _uptime_seconds(),
        "cpu_temperature_c": _cpu_temp_c(),
        "cpu_load_1m": _cpu_load(),
        "disk_usage": _disk_usage(),
        "memory_usage": _memory_usage(),
    }
