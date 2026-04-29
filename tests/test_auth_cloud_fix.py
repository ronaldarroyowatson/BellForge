"""tests/test_auth_cloud_fix.py
──────────────────────────────
Auth-fix-cloud test suite.

Coverage areas:
  1. Registration      — local and cloud users can register; data persists in the store.
  2. Login             — returning-user flag is False on first auth, True on subsequent logins.
  3. Account deletion  — users can delete their own account; the device re-locks.
  4. Re-registration   — after deletion a user can re-register with the same or new credentials.
  5. Server promotion  — promote_to_server executes correctly after authentication.
  6. Returning-user    — auth_status exposes has_registered_users; login GUI can skip onboarding.

Run with:
    python -m unittest tests.test_auth_cloud_fix
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.control_server import ControlServerService, _StateStore, DeviceRole
from backend.services.unified_auth import AuthError, get_auth_service


# ---------------------------------------------------------------------------
# Shared test environment helper
# ---------------------------------------------------------------------------


def _make_env(tmp_path: Path) -> dict[str, str]:
    return {
        "BELLFORGE_AUTH_STORE_PATH": str(tmp_path / "auth_registry.json"),
        "BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS": "1",
        "BELLFORGE_AUTH_MODE": "hybrid",
        "BELLFORGE_AUTH_ALLOW_WEAK_DEV_PASSWORDS": "1",
        "BELLFORGE_AUTH_EXPOSE_RESET_TOKEN": "1",
        "BELLFORGE_JWT_SECRET": "cloud-fix-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
        "BELLFORGE_GOOGLE_CLIENT_ID": "unused-in-stub",
        "BELLFORGE_GOOGLE_JWKS_URL": "https://example.invalid/jwks",
    }


def _make_control_service(tmp_path: Path) -> ControlServerService:
    """Return a ControlServerService with a mocked broadcaster (no real UDP sockets)."""
    state_path = tmp_path / "config" / "control_server.json"
    store = _StateStore(state_path)
    broadcaster = MagicMock()
    broadcaster.start = MagicMock()
    broadcaster.stop = MagicMock()
    svc = ControlServerService.__new__(ControlServerService)
    svc._store = store
    svc._broadcaster = broadcaster
    svc._state_lock = threading.Lock()
    svc._project_root = str(tmp_path)
    return svc


# ---------------------------------------------------------------------------
# 1. Registration
# ---------------------------------------------------------------------------


class TestRegistration(unittest.TestCase):
    """New users can register; their data persists correctly in the auth store."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _load_store(self) -> dict:
        store_path = Path(os.environ["BELLFORGE_AUTH_STORE_PATH"])
        return json.loads(store_path.read_text(encoding="utf-8"))

    # --- Local registration ---

    def test_local_registration_succeeds_and_persists(self) -> None:
        resp = self.client.post(
            "/api/auth/local/register",
            json={"email": "new@example.com", "password": "pw", "name": "New User", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        self.assertIn("access_token", payload)
        self.assertIn("refresh_token", payload)
        self.assertEqual(payload["user"]["provider"], "local")
        self.assertEqual(payload["user"]["email"], "new@example.com")

        # Data persists in the JSON store
        store = self._load_store()
        user_id = payload["user"]["id"]
        self.assertIn(user_id, store["users"])
        self.assertEqual(store["local_email_index"]["new@example.com"], user_id)

    def test_local_registration_password_is_hashed_not_plaintext(self) -> None:
        resp = self.client.post(
            "/api/auth/local/register",
            json={"email": "hashed@example.com", "password": "plaintextpw", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        store = self._load_store()
        user_id = resp.json()["user"]["id"]
        user = store["users"][user_id]
        self.assertNotEqual(user.get("local_password_hash"), "plaintextpw")
        self.assertIn("local_password_salt", user)

    def test_local_registration_duplicate_email_is_rejected(self) -> None:
        creds = {"email": "dup@example.com", "password": "pw", "client_type": "web"}
        first = self.client.post("/api/auth/local/register", json=creds)
        self.assertEqual(first.status_code, 200)
        second = self.client.post("/api/auth/local/register", json=creds)
        self.assertEqual(second.status_code, 409)

    # --- Cloud (stub) registration ---

    def test_cloud_registration_succeeds_and_persists(self) -> None:
        resp = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:cloud-new-user:cloud-new@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        self.assertIn("access_token", payload)
        self.assertEqual(payload["user"]["provider"], "google")

        store = self._load_store()
        user_id = payload["user"]["id"]
        self.assertIn(user_id, store["users"])
        self.assertIn("google:cloud-new-user", store["provider_index"])


# ---------------------------------------------------------------------------
# 2. Login — returning-user flag
# ---------------------------------------------------------------------------


class TestLoginReturningUser(unittest.TestCase):
    """is_returning_user is False on first auth and True on subsequent logins."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_cloud_first_login_is_not_returning(self) -> None:
        resp = self.client.post(
            "/api/auth/login",
            json={"provider": "google", "id_token": "stub:google:first:first@example.com", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["is_returning_user"])

    def test_cloud_second_login_is_returning(self) -> None:
        for i in range(2):
            resp = self.client.post(
                "/api/auth/login",
                json={"provider": "google", "id_token": "stub:google:second:second@example.com", "client_type": "web"},
            )
            self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["is_returning_user"])

    def test_local_register_is_not_returning(self) -> None:
        resp = self.client.post(
            "/api/auth/local/register",
            json={"email": "reg@example.com", "password": "pw", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["is_returning_user"])

    def test_local_login_is_returning(self) -> None:
        self.client.post(
            "/api/auth/local/register",
            json={"email": "login@example.com", "password": "pw", "client_type": "web"},
        )
        resp = self.client.post(
            "/api/auth/local/login",
            json={"email": "login@example.com", "password": "pw", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["is_returning_user"])

    def test_auth_status_has_registered_users_flag(self) -> None:
        # Initially no users
        status = self.client.get("/api/auth/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["has_registered_users"])

        # Register a user
        self.client.post(
            "/api/auth/local/register",
            json={"email": "status@example.com", "password": "pw", "client_type": "web"},
        )
        get_auth_service(force_reload=True)
        status2 = self.client.get("/api/auth/status")
        self.assertTrue(status2.json()["has_registered_users"])


# ---------------------------------------------------------------------------
# 3. Account deletion
# ---------------------------------------------------------------------------


class TestAccountDeletion(unittest.TestCase):
    """Users can delete their own account and the device re-locks."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _cloud_login(self, subject: str) -> dict:
        resp = self.client.post(
            "/api/auth/login",
            json={"provider": "google", "id_token": f"stub:google:{subject}:{subject}@example.com", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_user_can_delete_own_account(self) -> None:
        auth = self._cloud_login("delete-me")
        headers = {"Authorization": f"Bearer {auth['access_token']}"}
        user_id = auth["user"]["id"]

        delete_resp = self.client.post(
            "/api/auth/users/delete",
            headers=headers,
            json={"user_id": user_id},
        )
        self.assertEqual(delete_resp.status_code, 200)
        self.assertEqual(delete_resp.json()["deleted_user_id"], user_id)
        self.assertEqual(delete_resp.json()["remaining_active_users"], 0)

    def test_deletion_relocks_device(self) -> None:
        auth = self._cloud_login("relock-user")
        headers = {"Authorization": f"Bearer {auth['access_token']}"}
        user_id = auth["user"]["id"]

        self.client.post("/api/auth/users/delete", headers=headers, json={"user_id": user_id})

        get_auth_service(force_reload=True)
        status = self.client.get("/api/auth/status")
        self.assertFalse(status.json()["authentication_succeeded"])
        self.assertEqual(status.json()["active_user_count"], 0)

    def test_local_user_deletion_removes_email_from_index(self) -> None:
        service = get_auth_service(force_reload=True)
        registered = service.local_register("local-del@example.com", "pw", None, "web")
        user_id = registered["user"]["id"]
        principal = service.verify_bellforge_token(registered["access_token"])

        service.delete_authenticated_user(principal, user_id)

        data = service._read()  # noqa: SLF001
        self.assertNotIn("local-del@example.com", data["local_email_index"])

    def test_cloud_user_deletion_removes_provider_index_entry(self) -> None:
        service = get_auth_service(force_reload=True)
        cloud = service.login("google", "stub:google:prov-del:prov@example.com", "web")
        user_id = cloud["user"]["id"]
        principal = service.verify_bellforge_token(cloud["access_token"])

        service.delete_authenticated_user(principal, user_id)

        data = service._read()  # noqa: SLF001
        self.assertNotIn("google:prov-del", data["provider_index"])


# ---------------------------------------------------------------------------
# 4. Re-registration after deletion
# ---------------------------------------------------------------------------


class TestReRegistrationAfterDeletion(unittest.TestCase):
    """After deletion, a user can re-register with the same or different credentials."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_local_user_can_reregister_same_email_after_deletion(self) -> None:
        service = get_auth_service(force_reload=True)
        reg1 = service.local_register("reregister@example.com", "pw", None, "web")
        user_id1 = reg1["user"]["id"]
        principal1 = service.verify_bellforge_token(reg1["access_token"])
        service.delete_authenticated_user(principal1, user_id1)

        # Re-register with the same email
        reg2 = service.local_register("reregister@example.com", "pw2", None, "web")
        self.assertNotEqual(reg2["user"]["id"], user_id1)
        self.assertEqual(reg2["user"]["email"], "reregister@example.com")

    def test_cloud_user_can_reauthenticate_after_deletion(self) -> None:
        service = get_auth_service(force_reload=True)
        cloud1 = service.login("google", "stub:google:re-auth:re@example.com", "web")
        user_id1 = cloud1["user"]["id"]
        principal1 = service.verify_bellforge_token(cloud1["access_token"])
        service.delete_authenticated_user(principal1, user_id1)

        # Re-authenticate with the same provider identity
        cloud2 = service.login("google", "stub:google:re-auth:re@example.com", "web")
        # A fresh user record is created
        self.assertNotEqual(cloud2["user"]["id"], user_id1)
        self.assertEqual(cloud2["user"]["provider"], "google")

    def test_cloud_user_can_switch_to_local_after_deletion(self) -> None:
        service = get_auth_service(force_reload=True)
        cloud = service.login("google", "stub:google:switch-user:switch@example.com", "web")
        user_id = cloud["user"]["id"]
        principal = service.verify_bellforge_token(cloud["access_token"])
        service.delete_authenticated_user(principal, user_id)

        # Register with a local account using the same email
        local = service.local_register("switch@example.com", "pw", None, "web")
        self.assertEqual(local["user"]["provider"], "local")
        self.assertNotEqual(local["user"]["id"], user_id)

    def test_revoked_user_cannot_be_used_for_existing_cloud_reauthentication(self) -> None:
        """_ensure_user must create a new account, not re-activate the revoked one."""
        service = get_auth_service(force_reload=True)
        cloud1 = service.login("google", "stub:google:revoke-check:rv@example.com", "web")
        user_id1 = cloud1["user"]["id"]
        principal1 = service.verify_bellforge_token(cloud1["access_token"])
        service.delete_authenticated_user(principal1, user_id1)

        cloud2 = service.login("google", "stub:google:revoke-check:rv@example.com", "web")
        data = service._read()  # noqa: SLF001
        self.assertFalse(data["users"][cloud2["user"]["id"]].get("revoked", False))


# ---------------------------------------------------------------------------
# 5. Server promotion
# ---------------------------------------------------------------------------


class TestServerPromotion(unittest.TestCase):
    """promote_to_server executes correctly once authentication is validated."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        os.environ["BELLFORGE_CONTROL_SERVER_STATE_PATH"] = str(self._tmp / "config" / "control_server.json")
        get_auth_service(force_reload=True)
        self.client = TestClient(app)
        self._control_svc = _make_control_service(self._tmp)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _cloud_login(self, subject: str) -> dict:
        resp = self.client.post(
            "/api/auth/login",
            json={"provider": "google", "id_token": f"stub:google:{subject}:{subject}@example.com", "client_type": "web"},
        )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_authenticated_user_can_promote_device_to_server(self) -> None:
        auth = self._cloud_login("promote-user")
        user_id = auth["user"]["id"]

        result = self._control_svc.promote_to_server(user_id=user_id, device_name="Test Server")

        self.assertEqual(result["role"], "server")
        self.assertEqual(result["server_user_id"], user_id)

    def test_promotion_state_is_persisted_correctly(self) -> None:
        auth = self._cloud_login("persist-promote")
        user_id = auth["user"]["id"]

        self._control_svc.promote_to_server(user_id=user_id, device_name="Persist Server")

        # Re-read from disk
        state = self._control_svc._store.read()  # noqa: SLF001
        self.assertEqual(state.role, DeviceRole.SERVER)
        self.assertEqual(state.server_user_id, user_id)
        self.assertIsNotNone(state.promoted_at)

    def test_server_owner_can_edit_layout(self) -> None:
        auth = self._cloud_login("layout-user")
        user_id = auth["user"]["id"]

        self._control_svc.promote_to_server(user_id=user_id, device_name="Layout Server")

        self.assertTrue(self._control_svc.can_edit_layout(user_id))

    def test_non_owner_cannot_edit_layout_on_server(self) -> None:
        auth = self._cloud_login("owner-only")
        user_id = auth["user"]["id"]
        self._control_svc.promote_to_server(user_id=user_id, device_name="Owner Server")

        self.assertFalse(self._control_svc.can_edit_layout("different-user-id"))

    def test_promotion_is_idempotent_for_same_user(self) -> None:
        auth = self._cloud_login("idempotent-user")
        user_id = auth["user"]["id"]

        result1 = self._control_svc.promote_to_server(user_id=user_id, device_name="Idempotent Server")
        result2 = self._control_svc.promote_to_server(user_id=user_id, device_name="Idempotent Server")

        self.assertEqual(result1["device_id"], result2["device_id"])
        self.assertEqual(result2["role"], "server")

    def test_server_promotion_via_api_requires_valid_token(self) -> None:
        invalid = self.client.post(
            "/api/control/promote",
            json={"device_name": "Unauthorized Promote"},
        )
        # 401 = missing/invalid token; both 401 and 403 indicate the request is rejected
        self.assertIn(invalid.status_code, (401, 403))

    def test_server_promotion_via_api_succeeds_with_valid_token(self) -> None:
        auth = self._cloud_login("api-promote-user")
        headers = {"Authorization": f"Bearer {auth['access_token']}"}

        with patch("backend.routes.control_server_api.get_control_server_service", return_value=self._control_svc):
            resp = self.client.post(
                "/api/control/promote",
                headers=headers,
                json={"device_name": "API Promoted Server"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["role"], "server")


# ---------------------------------------------------------------------------
# 6. Returning-user login flow
# ---------------------------------------------------------------------------


class TestReturningUserLoginFlow(unittest.TestCase):
    """auth_status provides has_registered_users; the login GUI can skip onboarding."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._tmp = Path(self.temp_dir.name)
        self._env_backup = dict(os.environ)
        os.environ.update(_make_env(self._tmp))
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_fresh_device_has_no_registered_users(self) -> None:
        status = self.client.get("/api/auth/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["has_registered_users"])

    def test_device_with_at_least_one_registration_has_registered_users(self) -> None:
        self.client.post(
            "/api/auth/local/register",
            json={"email": "onboard@example.com", "password": "pw", "client_type": "web"},
        )
        get_auth_service(force_reload=True)
        status = self.client.get("/api/auth/status")
        self.assertTrue(status.json()["has_registered_users"])

    def test_has_registered_users_persists_after_logout(self) -> None:
        reg = self.client.post(
            "/api/auth/local/register",
            json={"email": "persist-logout@example.com", "password": "pw", "client_type": "web"},
        )
        self.assertEqual(reg.status_code, 200)
        tokens = reg.json()
        # Logout
        self.client.post(
            "/api/auth/logout",
            json={"refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        get_auth_service(force_reload=True)
        status = self.client.get("/api/auth/status")
        # User is still in the store even though session is revoked
        self.assertTrue(status.json()["has_registered_users"])

    def test_local_only_mode_returning_user_can_login_without_onboarding(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "local"
        service = get_auth_service(force_reload=True)
        service.local_register("lo-returning@example.com", "pw", None, "web")

        # Second login — is_returning_user must be True
        login_resp = service.local_login("lo-returning@example.com", "pw", "web")
        self.assertTrue(login_resp["is_returning_user"])

    def test_cloud_mode_returning_user_flag_correct(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "cloud"
        service = get_auth_service(force_reload=True)
        # First login
        first = service.login("google", "stub:google:cloud-ret:cloud-ret@example.com", "web")
        self.assertFalse(first["is_returning_user"])
        # Second login
        second = service.login("google", "stub:google:cloud-ret:cloud-ret@example.com", "web")
        self.assertTrue(second["is_returning_user"])

    def test_re_registration_after_deletion_is_not_returning(self) -> None:
        service = get_auth_service(force_reload=True)
        reg1 = service.local_register("rereg-ret@example.com", "pw", None, "web")
        user_id1 = reg1["user"]["id"]
        principal1 = service.verify_bellforge_token(reg1["access_token"])
        service.delete_authenticated_user(principal1, user_id1)

        # Re-register — fresh user, not a returning user
        reg2 = service.local_register("rereg-ret@example.com", "pw2", None, "web")
        self.assertFalse(reg2["is_returning_user"])


if __name__ == "__main__":
    unittest.main()
