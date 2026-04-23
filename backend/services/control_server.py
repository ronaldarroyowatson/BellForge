"""BellForge Control Server service.

Manages device role (server / satellite / unconfigured), LAN discovery via
UDP broadcast, server promotion, and layout-edit permission checks.

Architecture
------------
Every device starts UNCONFIGURED.

  UNCONFIGURED  --[promote]--> SERVER
  UNCONFIGURED  --[join]-----> SATELLITE
  SERVER        --[reset]----> UNCONFIGURED
  SATELLITE     --[reset]----> UNCONFIGURED

Only an authenticated user token is required to promote a device to server or
to check the layout-edit permission once the device has a known role.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DISCOVERY_PORT = int(os.getenv("BELLFORGE_DISCOVERY_PORT", "47862"))
_DISCOVERY_MAGIC = b"BF-DISCOVER-1"
_DISCOVERY_RESPONSE_MAGIC = b"BF-HERE-1"
_DISCOVERY_TIMEOUT_SECONDS = float(os.getenv("BELLFORGE_DISCOVERY_TIMEOUT", "3.0"))
_HEARTBEAT_INTERVAL_SECONDS = int(os.getenv("BELLFORGE_HEARTBEAT_INTERVAL", "15"))
_STATE_FILE_NAME = "control_server.json"


# ---------------------------------------------------------------------------
# Enums and data classes
# ---------------------------------------------------------------------------


class DeviceRole(str, Enum):
    UNCONFIGURED = "unconfigured"
    SERVER = "server"
    SATELLITE = "satellite"


@dataclass
class ServerInfo:
    address: str
    device_name: str
    server_device_id: str
    server_user_id: str
    discovered_at: str = field(default_factory=lambda: _utc_iso())


@dataclass
class ControlServerState:
    role: DeviceRole = DeviceRole.UNCONFIGURED
    device_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    device_name: str = "BellForge Device"
    server_user_id: str | None = None
    server_info: ServerInfo | None = None
    promoted_at: str | None = None
    updated_at: str = field(default_factory=lambda: _utc_iso())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json_safe(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


# ---------------------------------------------------------------------------
# Persistent state store
# ---------------------------------------------------------------------------


class _StateStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def read(self) -> ControlServerState:
        with self._lock:
            raw = _load_json_safe(self._path)
        if not raw:
            return ControlServerState()
        try:
            role = DeviceRole(raw.get("role", DeviceRole.UNCONFIGURED.value))
        except ValueError:
            role = DeviceRole.UNCONFIGURED

        server_info: ServerInfo | None = None
        raw_si = raw.get("server_info")
        if isinstance(raw_si, dict):
            try:
                server_info = ServerInfo(
                    address=str(raw_si.get("address", "")),
                    device_name=str(raw_si.get("device_name", "")),
                    server_device_id=str(raw_si.get("server_device_id", "")),
                    server_user_id=str(raw_si.get("server_user_id", "")),
                    discovered_at=str(raw_si.get("discovered_at", _utc_iso())),
                )
            except Exception:
                server_info = None

        return ControlServerState(
            role=role,
            device_id=str(raw.get("device_id") or str(uuid.uuid4())),
            device_name=str(raw.get("device_name") or "BellForge Device"),
            server_user_id=raw.get("server_user_id") if isinstance(raw.get("server_user_id"), str) else None,
            server_info=server_info,
            promoted_at=raw.get("promoted_at") if isinstance(raw.get("promoted_at"), str) else None,
            updated_at=str(raw.get("updated_at") or _utc_iso()),
        )

    def write(self, state: ControlServerState) -> None:
        state.updated_at = _utc_iso()
        payload: dict[str, Any] = {
            "role": state.role.value,
            "device_id": state.device_id,
            "device_name": state.device_name,
            "server_user_id": state.server_user_id,
            "server_info": asdict(state.server_info) if state.server_info else None,
            "promoted_at": state.promoted_at,
            "updated_at": state.updated_at,
        }
        with self._lock:
            _write_json(self._path, payload)


# ---------------------------------------------------------------------------
# UDP discovery
# ---------------------------------------------------------------------------


class _UdpBroadcaster:
    """Emits server-presence heartbeats on the LAN."""

    def __init__(self, device_id: str, device_name: str, port: int = _DISCOVERY_PORT) -> None:
        self._device_id = device_id
        self._device_name = device_name
        self._port = port
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="bf-discovery-broadcast")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def _run(self) -> None:
        payload = (
            _DISCOVERY_RESPONSE_MAGIC
            + b"|"
            + self._device_id.encode("utf-8")
            + b"|"
            + self._device_name.encode("utf-8", errors="replace")
        )
        while not self._stop_event.is_set():
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(("", self._port))
                    sock.settimeout(1.0)
                    while not self._stop_event.is_set():
                        try:
                            data, addr = sock.recvfrom(512)
                            if data.startswith(_DISCOVERY_MAGIC):
                                sock.sendto(payload, addr)
                        except socket.timeout:
                            pass
                        except OSError:
                            break
            except OSError:
                time.sleep(2)


def discover_servers_on_lan(
    timeout: float = _DISCOVERY_TIMEOUT_SECONDS,
    port: int = _DISCOVERY_PORT,
) -> list[dict[str, str]]:
    """Broadcast a discovery probe and collect responding servers.

    Returns a list of dicts: {address, device_id, device_name}.
    This function is blocking for up to *timeout* seconds.
    """
    found: list[dict[str, str]] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.settimeout(timeout)
            sock.bind(("", 0))
            sock.sendto(_DISCOVERY_MAGIC, ("<broadcast>", port))
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                sock.settimeout(remaining)
                try:
                    data, addr = sock.recvfrom(512)
                    if data.startswith(_DISCOVERY_RESPONSE_MAGIC):
                        parts = data.split(b"|", 2)
                        if len(parts) == 3:
                            device_id = parts[1].decode("utf-8", errors="replace")
                            device_name = parts[2].decode("utf-8", errors="replace")
                            found.append(
                                {
                                    "address": addr[0],
                                    "device_id": device_id,
                                    "device_name": device_name,
                                }
                            )
                except socket.timeout:
                    break
                except OSError:
                    break
    except OSError:
        pass
    return found


# ---------------------------------------------------------------------------
# Main service
# ---------------------------------------------------------------------------


class ControlServerService:
    """Manages this device's control-server role and LAN presence.

    Thread-safe. Singleton via :func:`get_control_server_service`.
    """

    def __init__(self, project_root: Path) -> None:
        state_path = Path(
            os.getenv(
                "BELLFORGE_CONTROL_SERVER_STATE_PATH",
                str(project_root / "config" / _STATE_FILE_NAME),
            )
        )
        self._store = _StateStore(state_path)
        self._broadcaster: _UdpBroadcaster | None = None
        self._state_lock = threading.Lock()

        # Auto-start broadcaster if the persisted role is SERVER.
        state = self._store.read()
        if state.role == DeviceRole.SERVER:
            self._start_broadcaster(state.device_id, state.device_name)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_status(self) -> dict[str, Any]:
        """Return the current role and any server/satellite metadata."""
        state = self._store.read()
        result: dict[str, Any] = {
            "role": state.role.value,
            "device_id": state.device_id,
            "device_name": state.device_name,
            "updated_at": state.updated_at,
        }
        if state.role == DeviceRole.SERVER:
            result["server_user_id"] = state.server_user_id
            result["promoted_at"] = state.promoted_at
        if state.role == DeviceRole.SATELLITE and state.server_info:
            result["server_address"] = state.server_info.address
            result["server_device_name"] = state.server_info.device_name
            result["server_device_id"] = state.server_info.server_device_id
            result["server_user_id"] = state.server_info.server_user_id
            result["server_discovered_at"] = state.server_info.discovered_at
        return result

    def promote_to_server(self, user_id: str, device_name: str) -> dict[str, Any]:
        """Promote this device to server role.

        Requires a validated ``user_id`` (obtained from a verified JWT token).
        Idempotent: if already SERVER for the same user, returns current state.
        """
        if not user_id:
            raise ValueError("user_id is required to promote a device to server.")
        if not device_name or not device_name.strip():
            raise ValueError("device_name is required.")

        with self._state_lock:
            state = self._store.read()
            if state.role == DeviceRole.SERVER and state.server_user_id == user_id:
                return self.get_status()

            state.role = DeviceRole.SERVER
            state.server_user_id = user_id
            state.device_name = device_name.strip()
            state.server_info = None
            state.promoted_at = _utc_iso()
            self._store.write(state)
            self._start_broadcaster(state.device_id, state.device_name)

        return self.get_status()

    def join_as_satellite(
        self,
        server_address: str,
        server_device_id: str,
        server_device_name: str,
        server_user_id: str,
    ) -> dict[str, Any]:
        """Configure this device as a satellite of the given server."""
        if not server_address:
            raise ValueError("server_address is required.")
        if not server_user_id:
            raise ValueError("server_user_id is required.")

        with self._state_lock:
            state = self._store.read()
            self._stop_broadcaster()
            state.role = DeviceRole.SATELLITE
            state.server_user_id = None
            state.server_info = ServerInfo(
                address=server_address,
                device_name=server_device_name,
                server_device_id=server_device_id,
                server_user_id=server_user_id,
            )
            state.promoted_at = None
            self._store.write(state)

        return self.get_status()

    def reset_role(self) -> dict[str, Any]:
        """Return this device to UNCONFIGURED state."""
        with self._state_lock:
            state = self._store.read()
            self._stop_broadcaster()
            state.role = DeviceRole.UNCONFIGURED
            state.server_user_id = None
            state.server_info = None
            state.promoted_at = None
            self._store.write(state)
        return self.get_status()

    def can_edit_layout(self, user_id: str) -> bool:
        """Return True if the given authenticated user may edit the layout.

        Rules:
        - UNCONFIGURED: permitted to maintain backwards compatibility during
          migration and first-boot scenarios.
        - SERVER: permitted only when the requesting user matches the server owner.
        - SATELLITE: never permitted locally — edits must go to the server.
        """
        state = self._store.read()
        if state.role == DeviceRole.UNCONFIGURED:
            return True
        if state.role == DeviceRole.SERVER:
            return state.server_user_id == user_id
        # SATELLITE
        return False

    def discover(self, timeout: float = _DISCOVERY_TIMEOUT_SECONDS) -> list[dict[str, str]]:
        """Probe the LAN for BellForge servers and return a list of results."""
        return discover_servers_on_lan(timeout=timeout)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _start_broadcaster(self, device_id: str, device_name: str) -> None:
        self._stop_broadcaster()
        self._broadcaster = _UdpBroadcaster(
            device_id=device_id,
            device_name=device_name,
            port=_DISCOVERY_PORT,
        )
        self._broadcaster.start()

    def _stop_broadcaster(self) -> None:
        if self._broadcaster:
            self._broadcaster.stop()
            self._broadcaster = None


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_service_instance: ControlServerService | None = None
_service_lock = threading.Lock()


def get_control_server_service(project_root: Path | None = None) -> ControlServerService:
    global _service_instance
    if _service_instance is None:
        with _service_lock:
            if _service_instance is None:
                if project_root is None:
                    project_root = Path(__file__).resolve().parent.parent.parent
                _service_instance = ControlServerService(project_root)
    return _service_instance
