from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.unified_auth import get_auth_service


class DevAdminLocalAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self.control_path = Path(self.temp_dir.name) / "control_server.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_CONTROL_SERVER_STATE_PATH"] = str(self.control_path)
        os.environ["BELLFORGE_AUTH_ALLOW_WEAK_DEV_PASSWORDS"] = "1"
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_JWT_SECRET"] = "integration-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_dev_admin_admin_create_delete_and_relock(self) -> None:
        register = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "admin@example.com",
                "password": "admin",
                "name": "admin",
                "client_type": "web",
            },
        )
        self.assertEqual(register.status_code, 200)
        access_token = register.json()["access_token"]
        headers = {"Authorization": f"Bearer {access_token}"}

        login = self.client.post(
            "/api/auth/local/login",
            json={
                "email": "admin@example.com",
                "password": "admin",
                "client_type": "web",
            },
        )
        self.assertEqual(login.status_code, 200)

        users = self.client.get("/api/auth/users", headers=headers)
        self.assertEqual(users.status_code, 200)
        self.assertEqual(users.json()["count"], 1)
        user_id = users.json()["users"][0]["id"]

        permitted_before = self.client.get("/api/control/permissions/layout-edit", headers=headers)
        self.assertEqual(permitted_before.status_code, 200)
        self.assertTrue(permitted_before.json()["permitted"])

        delete = self.client.post("/api/auth/users/delete", headers=headers, json={"user_id": user_id})
        self.assertEqual(delete.status_code, 200)
        self.assertEqual(delete.json()["remaining_active_users"], 0)
        self.assertTrue(delete.json()["edit_lock_active"])

        status = self.client.get("/api/auth/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["authentication_succeeded"])
        self.assertEqual(status.json()["active_user_count"], 0)


if __name__ == "__main__":
    unittest.main()
