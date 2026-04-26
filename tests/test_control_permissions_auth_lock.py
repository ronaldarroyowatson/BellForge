from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.unified_auth import get_auth_service
from backend.services.control_server import get_control_server_service


class ControlPermissionsAuthLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self.control_path = Path(self.temp_dir.name) / "control_server.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_CONTROL_SERVER_STATE_PATH"] = str(self.control_path)
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_JWT_SECRET"] = "integration-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)
        get_control_server_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _register_local(self, nonce: str) -> dict:
        response = self.client.post(
            "/api/auth/local/register",
            json={
                "email": f"owner-{nonce}@example.com",
                "password": f"owner-password-{nonce}-xyz",
                "name": f"Owner {nonce}",
                "client_type": "web",
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_layout_edit_permission_requires_authenticated_user(self) -> None:
        status = self.client.get("/api/auth/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["authentication_succeeded"])

        reg = self._register_local("perm")
        headers = {"Authorization": f"Bearer {reg['access_token']}"}

        permitted = self.client.get("/api/control/permissions/layout-edit", headers=headers)
        self.assertEqual(permitted.status_code, 200)
        self.assertTrue(permitted.json()["permitted"])
        self.assertEqual(permitted.json()["role"], "unconfigured")

    def test_satellite_role_stays_locked_even_when_authenticated(self) -> None:
        reg = self._register_local("satellite")
        headers = {"Authorization": f"Bearer {reg['access_token']}"}

        join = self.client.post(
            "/api/control/join",
            json={
                "server_address": "192.168.2.180:8000",
                "server_device_id": "srv-1",
                "server_device_name": "BellForge Server",
                "server_user_id": "owner-1",
            },
        )
        self.assertEqual(join.status_code, 200)

        permitted = self.client.get("/api/control/permissions/layout-edit", headers=headers)
        self.assertEqual(permitted.status_code, 200)
        self.assertFalse(permitted.json()["permitted"])
        self.assertEqual(permitted.json()["role"], "satellite")


if __name__ == "__main__":
    unittest.main()
