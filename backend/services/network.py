from __future__ import annotations

import asyncio
import ipaddress
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


def _network_lock_state_path(project_root: Path) -> Path:
    return project_root / "config" / "network_lock_state.json"


def _read_network_lock_state(project_root: Path) -> dict[str, Any]:
    path = _network_lock_state_path(project_root)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _write_network_lock_state(project_root: Path, payload: dict[str, Any]) -> None:
    path = _network_lock_state_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _run_cmd(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def _run_cmd_root(command: list[str]) -> subprocess.CompletedProcess[str]:
    if not sys.platform.startswith("linux"):
        return _run_cmd(command)

    direct = _run_cmd(command)
    if direct.returncode == 0:
        return direct

    return _run_cmd(["sudo", "-n", *command])


def _usable_ipv4(value: str | None) -> str | None:
    if not value:
        return None
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        return None
    if addr.version != 4 or addr.is_loopback:
        return None
    return value


def _local_ip() -> str | None:
    for endpoint in (("8.8.8.8", 80), ("1.1.1.1", 53)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(endpoint)
                ip = _usable_ipv4(sock.getsockname()[0])
                if ip:
                    return ip
        except OSError:
            pass

    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = _usable_ipv4(item[4][0])
            if ip:
                return ip
    except OSError:
        pass

    if sys.platform.startswith("linux"):
        try:
            result = _run_cmd(["hostname", "-I"])
            if result.returncode == 0:
                for token in result.stdout.split():
                    ip = _usable_ipv4(token.strip())
                    if ip:
                        return ip
        except Exception:
            pass

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


def _linux_network_profile() -> dict[str, Any] | None:
    result = _run_cmd(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"])
    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        parts = line.split(":", 3)
        if len(parts) != 4:
            continue
        device, conn_type, state, connection = parts
        if state != "connected" or not connection:
            continue
        if conn_type not in {"wifi", "ethernet"}:
            continue

        conn_id = connection
        if conn_type == "wifi":
            ssid_result = _run_cmd(["nmcli", "-t", "-f", "ACTIVE,SSID", "dev", "wifi"])
            ssid = None
            if ssid_result.returncode == 0:
                for row in ssid_result.stdout.splitlines():
                    if row.startswith("yes:"):
                        ssid = row.split(":", 1)[1] or None
                        break
            fingerprint = f"wifi:{ssid or conn_id}"
        else:
            fingerprint = f"ethernet:{conn_id}"

        addr_result = _run_cmd(["nmcli", "-g", "IP4.ADDRESS", "device", "show", device])
        addresses = [x.strip() for x in addr_result.stdout.splitlines() if x.strip()] if addr_result.returncode == 0 else []
        current_addr = addresses[0] if addresses else None

        gw_result = _run_cmd(["nmcli", "-g", "IP4.GATEWAY", "device", "show", device])
        gateway = None
        if gw_result.returncode == 0:
            for token in gw_result.stdout.splitlines():
                if token.strip():
                    gateway = token.strip()
                    break

        dns_result = _run_cmd(["nmcli", "-g", "IP4.DNS", "device", "show", device])
        dns_servers = [x.strip() for x in dns_result.stdout.splitlines() if x.strip()] if dns_result.returncode == 0 else []

        return {
            "device": device,
            "type": conn_type,
            "connection": conn_id,
            "fingerprint": fingerprint,
            "ipv4_cidr": current_addr,
            "gateway": gateway,
            "dns_servers": dns_servers,
        }

    return None


def _unlock_profile_ipv4(connection_name: str) -> None:
    _run_cmd_root([
        "nmcli",
        "connection",
        "modify",
        connection_name,
        "ipv4.method",
        "auto",
        "-ipv4.addresses",
        "",
        "-ipv4.gateway",
        "",
        "-ipv4.dns",
        "",
    ])


def ensure_ip_locked_for_current_network(project_root: Path) -> dict[str, Any]:
    if not sys.platform.startswith("linux"):
        return {"supported": False, "applied": False, "reason": "non-linux"}

    profile = _linux_network_profile()
    if not profile:
        return {"supported": True, "applied": False, "reason": "no-connected-profile"}

    current_ipv4_cidr = profile.get("ipv4_cidr")
    if not current_ipv4_cidr:
        return {"supported": True, "applied": False, "reason": "no-ipv4"}

    lock_state = _read_network_lock_state(project_root)
    previous_fingerprint = str(lock_state.get("fingerprint", ""))
    previous_connection = str(lock_state.get("connection", ""))
    changed_network = previous_fingerprint and previous_fingerprint != profile["fingerprint"]

    if changed_network and previous_connection and previous_connection != profile["connection"]:
        _unlock_profile_ipv4(previous_connection)

    args = [
        "nmcli",
        "connection",
        "modify",
        profile["connection"],
        "ipv4.method",
        "manual",
        "ipv4.addresses",
        current_ipv4_cidr,
    ]

    gateway = str(profile.get("gateway") or "").strip()
    if gateway:
        args.extend(["ipv4.gateway", gateway])
    else:
        args.extend(["-ipv4.gateway", ""])

    dns_servers = profile.get("dns_servers") or []
    if dns_servers:
        args.extend(["ipv4.dns", ",".join(dns_servers)])

    result = _run_cmd_root(args)
    applied = result.returncode == 0

    if applied:
        _write_network_lock_state(project_root, {
            "timestamp": _utc_now(),
            "fingerprint": profile["fingerprint"],
            "connection": profile["connection"],
            "ipv4_cidr": current_ipv4_cidr,
            "gateway": gateway,
            "dns_servers": dns_servers,
        })

    return {
        "supported": True,
        "applied": applied,
        "changed_network": bool(changed_network),
        "fingerprint": profile["fingerprint"],
        "connection": profile["connection"],
        "ipv4_cidr": current_ipv4_cidr,
        "error": None if applied else (result.stderr.strip() or result.stdout.strip() or "nmcli modify failed"),
    }


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

    ip_lock_status = ensure_ip_locked_for_current_network(project_root)

    return {
        "timestamp": _utc_now(),
        "ssid": ssid,
        "signal_strength": signal_strength,
        "ip_address": _local_ip(),
        "ethernet_available": ethernet_available,
        "connection_type": "ethernet" if ethernet_available and not ssid else "wifi",
        "ip_lock": ip_lock_status,
    }


async def update_network_settings(project_root: Path, request: NetworkUpdateRequest) -> dict[str, Any]:
    applied = False
    restart_requested = False
    message = "No changes requested."

    if sys.platform.startswith("linux"):
        if request.use_ethernet:
            eth_result = _run_cmd_root(["nmcli", "connection", "up", "Wired connection 1"])
            applied = eth_result.returncode == 0
            restart_requested = applied
            message = "Switched to Ethernet." if applied else (eth_result.stderr.strip() or "Failed to switch to Ethernet.")
        elif request.ssid:
            cmd = ["nmcli", "device", "wifi", "connect", request.ssid]
            if request.password:
                cmd.extend(["password", request.password])
            wifi_result = _run_cmd_root(cmd)
            applied = wifi_result.returncode == 0
            restart_requested = applied
            message = "Wi-Fi updated." if applied else (wifi_result.stderr.strip() or "Failed to update Wi-Fi.")

        if restart_requested:
            _run_cmd_root(["nmcli", "networking", "off"])
            await asyncio.sleep(0.2)
            _run_cmd_root(["nmcli", "networking", "on"])
            await asyncio.sleep(0.6)

        ip_lock_status = ensure_ip_locked_for_current_network(project_root)

    else:
        message = "Network update simulated on non-Linux platform."
        applied = bool(request.ssid or request.use_ethernet)
        ip_lock_status = {"supported": False, "applied": False, "reason": "non-linux"}

    return {
        "timestamp": _utc_now(),
        "applied": applied,
        "restart_requested": restart_requested,
        "message": message,
        "ip_lock": ip_lock_status,
    }
