"""
tests/test_control_server.py
────────────────────────────
Comprehensive test suite for the BellForge control-server architecture.

Coverage areas:
  1. Service unit tests  — DeviceRole, ControlServerService CRUD, can_edit_layout rules
  2. UDP discovery       — mock socket I/O for server probe / response cycle
  3. Server promotion    — promote_to_server persists state correctly
  4. Satellite joining   — join_as_satellite persists state correctly
  5. Permission model    — authenticated user can edit layout, satellite cannot, wrong user cannot
  6. REST API            — all 6 control endpoints via FastAPI TestClient
  7. End-to-end scenario — first device becomes server, second joins satellite, auth propagates,
                           layout editing unlocks on server and stays locked on satellite

Run with:
    pytest tests/test_control_server.py -v
"""

import json
import os
import socket
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ── Helpers ────────────────────────────────────────────────────────────────────

def _write_state(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def _read_state(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _make_service(tmp_path: Path):
    """Return a fresh ControlServerService backed by tmp_path."""
    from backend.services.control_server import ControlServerService, _StateStore
    state_path = tmp_path / "config" / "control_server.json"
    store = _StateStore(state_path)
    # Broadcaster is not started in tests — pass a no-op broadcaster
    broadcaster = MagicMock()
    broadcaster.start = MagicMock()
    svc = ControlServerService.__new__(ControlServerService)
    svc._store = store
    svc._broadcaster = broadcaster
    svc._state_lock = threading.Lock()
    svc._project_root = str(tmp_path)
    return svc


# ── 1. Service unit tests ──────────────────────────────────────────────────────

class TestDeviceRole:
    def test_role_enum_values(self):
        from backend.services.control_server import DeviceRole
        assert DeviceRole.UNCONFIGURED.value == "unconfigured"
        assert DeviceRole.SERVER.value == "server"
        assert DeviceRole.SATELLITE.value == "satellite"


class TestStateStore:
    def test_load_default_when_no_file(self, tmp_path):
        from backend.services.control_server import _StateStore, DeviceRole
        store = _StateStore(tmp_path / "config" / "control_server.json")
        state = store.read()
        assert state.role == DeviceRole.UNCONFIGURED

    def test_save_and_load_roundtrip(self, tmp_path):
        from backend.services.control_server import _StateStore, ControlServerState, DeviceRole
        store = _StateStore(tmp_path / "config" / "control_server.json")
        state = store.read()
        state.role = DeviceRole.SERVER
        state.device_name = "TestDevice"
        state.server_user_id = "user-abc"
        store.write(state)

        loaded = store.read()
        assert loaded.role == DeviceRole.SERVER
        assert loaded.device_name == "TestDevice"
        assert loaded.server_user_id == "user-abc"

    def test_state_file_location(self, tmp_path):
        from backend.services.control_server import _StateStore
        store = _StateStore(tmp_path / "config" / "control_server.json")
        state = store.read()
        store.write(state)
        state_file = tmp_path / "config" / "control_server.json"
        assert state_file.exists()


class TestControlServerServiceBasic:
    def test_get_status_default(self, tmp_path):
        svc = _make_service(tmp_path)
        status = svc.get_status()
        assert status["role"] == "unconfigured"

    def test_promote_to_server(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.promote_to_server("user-1", "MyDevice")
        assert result["role"] == "server"
        assert result["device_name"] == "MyDevice"

    def test_promote_persists(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.promote_to_server("user-1", "MyDevice")
        status = svc.get_status()
        assert status["role"] == "server"
        assert status["device_name"] == "MyDevice"

    def test_promote_exposes_server_identity_metadata(self, tmp_path):
        svc = _make_service(tmp_path)
        status = svc.promote_to_server("user-owner", "BellForge Server")
        assert status["role"] == "server"
        assert status["authenticated_user"] == "user-owner"
        assert status["server_user_id"] == "user-owner"
        assert isinstance(status.get("server_uuid"), str)
        assert status.get("server_uuid")

    def test_promote_starts_broadcasting_presence(self, tmp_path):
        svc = _make_service(tmp_path)
        svc._start_broadcaster = MagicMock()
        svc.promote_to_server("user-owner", "BellForge Server")
        svc._start_broadcaster.assert_called_once()

    def test_join_as_satellite(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.join_as_satellite(
            server_address="192.168.1.10:8000",
            server_device_id="dev-server",
            server_device_name="ServerDevice",
            server_user_id="user-owner",
        )
        assert result["role"] == "satellite"

    def test_join_as_satellite_persists(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.join_as_satellite("192.168.1.10:8000", "dev-s", "ServerDevice", "user-owner")
        status = svc.get_status()
        assert status["role"] == "satellite"

    def test_reset_role(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.promote_to_server("user-1", "MyDevice")
        svc.reset_role()
        status = svc.get_status()
        assert status["role"] == "unconfigured"


# ── 2. UDP discovery ───────────────────────────────────────────────────────────

class TestUdpDiscovery:
    """Mock the socket layer to test discovery logic without real network I/O."""

    def test_discover_returns_empty_on_timeout(self, tmp_path):
        from backend.services.control_server import discover_servers_on_lan

        with patch("backend.services.control_server.socket.socket") as mock_sock_cls:
            mock_sock = MagicMock()
            mock_sock_cls.return_value.__enter__ = lambda *a: mock_sock
            mock_sock_cls.return_value.__exit__ = MagicMock(return_value=False)
            # recvfrom always raises timeout
            mock_sock.recvfrom.side_effect = socket.timeout()

            servers = discover_servers_on_lan(timeout=0.1)
            assert isinstance(servers, list)
            assert len(servers) == 0

    def test_discover_parses_valid_response(self, tmp_path):
        from backend.services.control_server import discover_servers_on_lan

        response_payload = b"BF-HERE-1|dev-id-123|ServerName"

        call_count = {"n": 0}

        def fake_recvfrom(bufsize):
            if call_count["n"] == 0:
                call_count["n"] += 1
                return (response_payload, ("192.168.1.50", 47862))
            raise socket.timeout()

        with patch("backend.services.control_server.socket.socket") as mock_sock_cls:
            mock_sock = MagicMock()
            mock_sock_cls.return_value.__enter__ = lambda *a: mock_sock
            mock_sock_cls.return_value.__exit__ = MagicMock(return_value=False)
            mock_sock.recvfrom.side_effect = fake_recvfrom

            servers = discover_servers_on_lan(timeout=0.5)
            assert len(servers) == 1
            assert servers[0]["device_id"] == "dev-id-123"
            assert servers[0]["device_name"] == "ServerName"
            assert servers[0]["address"] == "192.168.1.50"

    def test_discover_ignores_malformed_packets(self):
        from backend.services.control_server import discover_servers_on_lan

        responses = [
            (b"GARBAGE-PACKET", ("192.168.1.51", 47862)),
            (b"BF-HERE-1|only-two", ("192.168.1.52", 47862)),  # too few parts
        ]
        call_index = {"n": 0}

        def fake_recvfrom(bufsize):
            if call_index["n"] < len(responses):
                r = responses[call_index["n"]]
                call_index["n"] += 1
                return r
            raise socket.timeout()

        with patch("backend.services.control_server.socket.socket") as mock_sock_cls:
            mock_sock = MagicMock()
            mock_sock_cls.return_value.__enter__ = lambda *a: mock_sock
            mock_sock_cls.return_value.__exit__ = MagicMock(return_value=False)
            mock_sock.recvfrom.side_effect = fake_recvfrom

            servers = discover_servers_on_lan(timeout=0.5)
            assert len(servers) == 0

    def test_service_discover_delegates_to_function(self, tmp_path):
        svc = _make_service(tmp_path)
        with patch("backend.services.control_server.discover_servers_on_lan") as mock_fn:
            mock_fn.return_value = [{"address": "10.0.0.1", "device_id": "x", "device_name": "Y"}]
            result = svc.discover(timeout=0.1)
            assert result == mock_fn.return_value
            mock_fn.assert_called_once()


# ── 3. Permission model ────────────────────────────────────────────────────────

class TestCanEditLayout:
    def test_unconfigured_always_permits(self, tmp_path):
        svc = _make_service(tmp_path)
        # Default state is UNCONFIGURED — any user_id allowed
        assert svc.can_edit_layout("user-any") is True
        assert svc.can_edit_layout("") is True

    def test_server_owner_can_edit(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.promote_to_server("user-owner", "MyDevice")
        assert svc.can_edit_layout("user-owner") is True

    def test_server_non_owner_cannot_edit(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.promote_to_server("user-owner", "MyDevice")
        assert svc.can_edit_layout("user-other") is False

    def test_server_empty_user_cannot_edit(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.promote_to_server("user-owner", "MyDevice")
        assert svc.can_edit_layout("") is False

    def test_satellite_never_permits(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.join_as_satellite("192.168.1.10:8000", "dev-s", "Server", "user-owner")
        assert svc.can_edit_layout("user-owner") is False
        assert svc.can_edit_layout("user-any") is False
        assert svc.can_edit_layout("") is False


# ── 4. REST API ────────────────────────────────────────────────────────────────

@pytest.fixture()
def app_client(tmp_path):
    """
    Stand up a TestClient with the full FastAPI app but override the
    control server singleton to use tmp_path for isolation.
    """
    import importlib
    import backend.services.control_server as cs_mod
    import backend.routes.control_server_api as api_mod
    from backend.services.unified_auth import get_auth_service

    auth_store_backup = os.environ.get("BELLFORGE_AUTH_STORE_PATH")
    os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(tmp_path / "auth_registry.json")
    get_auth_service(force_reload=True)

    # Patch the singleton so each test gets a clean service
    svc = _make_service(tmp_path)
    with patch.object(cs_mod, "get_control_server_service", return_value=svc):
        with patch.object(api_mod, "get_control_server_service", return_value=svc):
            from backend.main import app
            with TestClient(app) as client:
                yield client, svc
    if auth_store_backup is None:
        os.environ.pop("BELLFORGE_AUTH_STORE_PATH", None)
    else:
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = auth_store_backup
    get_auth_service(force_reload=True)


@pytest.fixture()
def user_token():
    """Return a minimal valid JWT for a test user."""
    import os
    import jwt as pyjwt

    secret = os.environ.get("BELLFORGE_JWT_SECRET", "dev-only-change-me")
    issuer = os.environ.get("BELLFORGE_JWT_ISSUER", "bellforge-server")
    now = int(time.time())
    payload = {
        "sub": "test-user-1",
        "user_id": "test-user-1",
        "aud": "bellforge",
        "iss": issuer,
        "iat": now,
        "exp": now + 3600,
        "jti": str(uuid.uuid4()),
        "typ": "user_access",
        "role": "user",
        "permissions": ["layout:edit"],
        "org_ids": [],
        "classroom_ids": [],
    }
    return pyjwt.encode(payload, secret, algorithm="HS256")


class TestControlStatusEndpoint:
    def test_get_status_ok(self, app_client):
        client, svc = app_client
        resp = client.get("/api/control/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["role"] == "unconfigured"


class TestControlDiscoverEndpoint:
    def test_discover_returns_list(self, app_client):
        client, svc = app_client
        with patch.object(svc, "discover", return_value=[]):
            resp = client.get("/api/control/discover")
            assert resp.status_code == 200
            assert resp.json()["count"] == 0
            assert isinstance(resp.json()["servers"], list)


class TestControlPromoteEndpoint:
    def test_promote_requires_auth(self, app_client):
        client, svc = app_client
        resp = client.post("/api/control/promote", json={"device_name": "TestDevice"})
        assert resp.status_code == 401

    def test_promote_with_valid_token(self, app_client, user_token):
        client, svc = app_client
        resp = client.post(
            "/api/control/promote",
            json={"device_name": "TestDevice"},
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["role"] == "server"

    def test_promote_returns_server_metadata(self, app_client, user_token):
        client, svc = app_client
        resp = client.post(
            "/api/control/promote",
            json={"device_name": "TestDevice"},
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["role"] == "server"
        assert payload["authenticated_user"] == "test-user-1"
        assert payload["server_user_id"] == "test-user-1"
        assert isinstance(payload.get("server_uuid"), str)
        assert payload.get("server_uuid")

    def test_promote_missing_device_name(self, app_client, user_token):
        client, svc = app_client
        resp = client.post(
            "/api/control/promote",
            json={},
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 422


class TestControlJoinEndpoint:
    def test_join_no_auth_required(self, app_client):
        client, svc = app_client
        resp = client.post(
            "/api/control/join",
            json={
                "server_address": "192.168.1.10:8000",
                "server_device_id": "dev-s",
                "server_device_name": "ServerDevice",
                "server_user_id": "user-owner",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["role"] == "satellite"

    def test_join_missing_server_address(self, app_client):
        client, svc = app_client
        resp = client.post(
            "/api/control/join",
            json={"server_user_id": "user-owner"},
        )
        assert resp.status_code == 422


class TestControlResetEndpoint:
    def test_reset_requires_auth(self, app_client):
        client, svc = app_client
        resp = client.post("/api/control/reset")
        assert resp.status_code == 401

    def test_reset_with_valid_token(self, app_client, user_token):
        client, svc = app_client
        # First promote so there is something to reset
        client.post(
            "/api/control/promote",
            json={"device_name": "TestDevice"},
            headers={"Authorization": f"Bearer {user_token}"},
        )
        resp = client.post(
            "/api/control/reset",
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["role"] == "unconfigured"


class TestLayoutEditPermissionEndpoint:
    def test_permission_requires_auth(self, app_client):
        client, svc = app_client
        resp = client.get("/api/control/permissions/layout-edit")
        assert resp.status_code == 401

    def test_unconfigured_denies_when_no_authenticated_users_exist(self, app_client, user_token):
        client, svc = app_client
        resp = client.get(
            "/api/control/permissions/layout-edit",
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["permitted"] is False
        assert resp.json()["role"] == "unconfigured"

    def test_server_owner_permitted(self, app_client, user_token):
        client, svc = app_client
        register = client.post(
            "/api/auth/local/register",
            json={
                "email": "owner@test.example",
                "password": "owner-password-123",
                "name": "Owner",
                "client_type": "web",
            },
        )
        assert register.status_code == 200
        owner_token = register.json()["access_token"]
        client.post(
            "/api/control/promote",
            json={"device_name": "TestDevice"},
            headers={"Authorization": f"Bearer {owner_token}"},
        )
        resp = client.get(
            "/api/control/permissions/layout-edit",
            headers={"Authorization": f"Bearer {owner_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["permitted"] is True

    def test_satellite_not_permitted(self, app_client, user_token):
        client, svc = app_client
        svc.join_as_satellite("192.168.1.10:8000", "dev-s", "Server", "user-owner")
        resp = client.get(
            "/api/control/permissions/layout-edit",
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["permitted"] is False
        assert resp.json()["role"] == "satellite"


# ── 5. End-to-end scenario ─────────────────────────────────────────────────────

class TestEndToEnd:
    """
    Simulates:
      - Device A: authenticates → promotes to server → layout edit permitted
      - Device B: authenticates → joins Device A as satellite → layout edit denied
      - Device A after reset: unconfigured → layout edit permitted again
    """

    def test_full_server_satellite_flow(self, tmp_path, user_token):
        import os
        import jwt as pyjwt

        # Build a second user token for a different user (non-owner)
        secret = os.environ.get("BELLFORGE_JWT_SECRET", "dev-only-change-me")
        issuer = os.environ.get("BELLFORGE_JWT_ISSUER", "bellforge-server")
        now = int(time.time())
        owner_payload = {
            "sub": "test-user-1",
            "user_id": "test-user-1",
            "iss": issuer,
            "iat": now,
            "exp": now + 3600,
            "token_type": "user_access",
        }
        other_payload = {**owner_payload, "sub": "test-user-2", "user_id": "test-user-2"}
        owner_token = pyjwt.encode(owner_payload, secret, algorithm="HS256")
        other_token = pyjwt.encode(other_payload, secret, algorithm="HS256")

        # ── Device A (server) ──
        tmp_a = tmp_path / "device_a"
        tmp_a.mkdir()
        svc_a = _make_service(tmp_a)

        # Before promotion: unconfigured → any user permitted
        assert svc_a.can_edit_layout("test-user-1") is True

        # Promote Device A to server with owner = test-user-1
        svc_a.promote_to_server("test-user-1", "Device-A")
        assert svc_a.get_status()["role"] == "server"

        # Only the owner can edit
        assert svc_a.can_edit_layout("test-user-1") is True
        assert svc_a.can_edit_layout("test-user-2") is False

        # ── Device B (satellite) ──
        tmp_b = tmp_path / "device_b"
        tmp_b.mkdir()
        svc_b = _make_service(tmp_b)

        server_status = svc_a.get_status()
        svc_b.join_as_satellite(
            server_address="192.168.1.10:8000",
            server_device_id=server_status.get("device_id", ""),
            server_device_name=server_status.get("device_name", ""),
            server_user_id=server_status.get("server_user_id", "test-user-1"),
        )
        assert svc_b.get_status()["role"] == "satellite"

        # Satellite can never edit — not even the owner
        assert svc_b.can_edit_layout("test-user-1") is False
        assert svc_b.can_edit_layout("test-user-2") is False

        # ── Device A reset → unconfigured again ──
        svc_a.reset_role()
        assert svc_a.get_status()["role"] == "unconfigured"
        # Unconfigured always permits
        assert svc_a.can_edit_layout("test-user-1") is True
        assert svc_a.can_edit_layout("test-user-2") is True

    def test_server_discovery_and_join_via_service(self, tmp_path):
        """
        Simulate Device A broadcasting; Device B discovers and joins.
        Uses mock UDP to avoid real network dependency.
        """
        from backend.services.control_server import discover_servers_on_lan

        tmp_a = tmp_path / "device_a"
        tmp_a.mkdir()
        svc_a = _make_service(tmp_a)
        svc_a.promote_to_server("user-owner", "Server-A")

        # Mock discovery returning Device A's info
        discovered_servers = [
            {"address": "192.168.1.100", "device_id": "dev-a", "device_name": "Server-A"}
        ]

        tmp_b = tmp_path / "device_b"
        tmp_b.mkdir()
        svc_b = _make_service(tmp_b)

        with patch.object(svc_b, "discover", return_value=discovered_servers):
            results = svc_b.discover(timeout=0.1)
            assert len(results) == 1
            srv = results[0]
            svc_b.join_as_satellite(
                server_address=srv["address"],
                server_device_id=srv["device_id"],
                server_device_name=srv["device_name"],
                server_user_id="user-owner",
            )

        assert svc_b.get_status()["role"] == "satellite"
        assert svc_b.can_edit_layout("user-owner") is False
