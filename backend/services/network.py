from __future__ import annotations

import asyncio
import json
import socket
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class NetworkUpdateRequest:
    ssid: str | None = None
    password: str | None = None
    use_ethernet: bool = False


def _run_cmd(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def _local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def _nmcli_value(field: str) -> str | None:
    result = _run_cmd(["nmcli", "-t", "-f", field, "dev", "wifi"])
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if line.strip():
            return line.strip().split(":")[-1]
    return None


def _read_local_settings(config_dir: Path) -> dict[str, Any]:
    settings_path = config_dir / "settings.json"
    if not settings_path.is_file():
        return {}
    try:
        return json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


async def get_network_info(project_root: Path) -> dict[str, Any]:
    config_dir = project_root / "config"
    settings = _read_local_settings(config_dir)

    ssid: str | None = None
    signal_strength: int | None = None
    ethernet_available = False

    if sys.platform.startswith("linux"):
        active_result = _run_cmd(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"])
        if active_result.returncode == 0:
            for line in active_result.stdout.splitlines():
                parts = line.split(":")
                if len(parts) >= 3 and parts[0] == "yes":
                    ssid = parts[1] or None
                    try:
                        signal_strength = int(parts[2])
                    except ValueError:
                        signal_strength = None
                    break

        eth_result = _run_cmd(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"])
        if eth_result.returncode == 0:
            ethernet_available = any(
                line.split(":")[1:2] == ["ethernet"] for line in eth_result.stdout.splitlines() if ":" in line
            )

    if ssid is None:
        ssid = str(settings.get("wifi_ssid", "")) or None

    if signal_strength is None:
        configured_signal = settings.get("wifi_signal_strength")
        signal_strength = int(configured_signal) if isinstance(configured_signal, int) else None

    return {
        "timestamp": _utc_now(),
        "ssid": ssid,
        "signal_strength": signal_strength,
        "ip_address": _local_ip(),
        "ethernet_available": ethernet_available,
        "connection_type": "ethernet" if ethernet_available and not ssid else "wifi",
    }


async def update_network_settings(project_root: Path, request: NetworkUpdateRequest) -> dict[str, Any]:
    applied = False
    restart_requested = False
    message = "No changes requested."

    if sys.platform.startswith("linux"):
        if request.use_ethernet:
            eth_result = _run_cmd(["nmcli", "connection", "up", "Wired connection 1"])
            applied = eth_result.returncode == 0
            restart_requested = applied
            message = "Switched to Ethernet." if applied else (eth_result.stderr.strip() or "Failed to switch to Ethernet.")
        elif request.ssid:
            cmd = ["nmcli", "device", "wifi", "connect", request.ssid]
            if request.password:
                cmd.extend(["password", request.password])
            wifi_result = _run_cmd(cmd)
            applied = wifi_result.returncode == 0
            restart_requested = applied
            message = "Wi-Fi updated." if applied else (wifi_result.stderr.strip() or "Failed to update Wi-Fi.")

        if restart_requested:
            _run_cmd(["nmcli", "networking", "off"])
            await asyncio.sleep(0.2)
            _run_cmd(["nmcli", "networking", "on"])
    else:
        message = "Network update simulated on non-Linux platform."
        applied = bool(request.ssid or request.use_ethernet)

    return {
        "timestamp": _utc_now(),
        "applied": applied,
        "restart_requested": restart_requested,
        "message": message,
    }
