from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.unified_auth import get_auth_service


class UnifiedAuthE2ETests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_JWT_SECRET"] = "e2e-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _login(self, subject: str, provider: str = "google") -> dict:
        response = self.client.post(
            "/api/auth/login",
            json={
                "provider": provider,
                "id_token": f"stub:{provider}:{subject}:{subject}@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_e2e_user_registers_device_and_authorization_enforced(self) -> None:
        owner = self._login("owner-user")
        owner_headers = {"Authorization": f"Bearer {owner['access_token']}"}

        register = self.client.post(
            "/api/devices/register",
            headers=owner_headers,
            json={
                "device_name": "Pi Entrance",
                "device_fingerprint": "FP-ENTRANCE-001",
                "org_id": "org-e2e",
                "classroom_id": "entrance",
            },
        )
        self.assertEqual(register.status_code, 200)
        registered = register.json()
        device_id = registered["device"]["id"]

        heartbeat_ok = self.client.post(
            "/api/devices/heartbeat",
            headers={"Authorization": f"Bearer {registered['device_token']}"},
            json={"status": "online", "ip_address": "10.10.1.5", "network_id": "net-e2e"},
        )
        self.assertEqual(heartbeat_ok.status_code, 200)

        unauthorized_heartbeat = self.client.post(
            "/api/devices/heartbeat",
            headers=owner_headers,
            json={"status": "online", "ip_address": "10.10.1.5", "network_id": "net-e2e"},
        )
        self.assertEqual(unauthorized_heartbeat.status_code, 403)

        revoke = self.client.post(
            "/api/devices/revoke",
            headers=owner_headers,
            json={"device_id": device_id, "reason": "retired"},
        )
        self.assertEqual(revoke.status_code, 200)

        heartbeat_after_revoke = self.client.post(
            "/api/devices/heartbeat",
            headers={"Authorization": f"Bearer {registered['device_token']}"},
            json={"status": "online", "ip_address": "10.10.1.5", "network_id": "net-e2e"},
        )
        self.assertEqual(heartbeat_after_revoke.status_code, 401)

    def test_e2e_transfer_and_claim_conflict(self) -> None:
        owner = self._login("owner-transfer")
        target = self._login("target-transfer")
        owner_headers = {"Authorization": f"Bearer {owner['access_token']}"}
        target_headers = {"Authorization": f"Bearer {target['access_token']}"}

        registration = self.client.post(
            "/api/devices/register",
            headers=owner_headers,
            json={
                "device_name": "Pi Library",
                "device_fingerprint": "FP-LIBRARY-002",
                "org_id": "org-e2e",
                "classroom_id": "library",
            },
        )
        self.assertEqual(registration.status_code, 200)
        device_id = registration.json()["device"]["id"]

        transfer = self.client.post(
            "/api/devices/transfer",
            headers=owner_headers,
            json={"device_id": device_id, "target_user_id": target["user"]["id"]},
        )
        self.assertEqual(transfer.status_code, 200)

        revoke_by_old_owner = self.client.post(
            "/api/devices/revoke",
            headers=owner_headers,
            json={"device_id": device_id, "reason": "should-fail"},
        )
        self.assertEqual(revoke_by_old_owner.status_code, 403)

        revoke_by_new_owner = self.client.post(
            "/api/devices/revoke",
            headers=target_headers,
            json={"device_id": device_id, "reason": "new-owner-revoke"},
        )
        self.assertEqual(revoke_by_new_owner.status_code, 200)

    def test_security_regression_invalid_tokens_never_pass(self) -> None:
        login = self._login("regression-user")
        valid = self.client.post(
            "/api/auth/verify",
            json={"token": login["access_token"]},
        )
        self.assertEqual(valid.status_code, 200)

        tampered = login["access_token"] + "tamper"
        invalid = self.client.post("/api/auth/verify", json={"token": tampered})
        self.assertEqual(invalid.status_code, 401)

        missing_auth = self.client.post(
            "/api/devices/register",
            json={
                "device_name": "NoAuthDevice",
                "device_fingerprint": "FP-NOAUTH-001",
                "org_id": "org-e2e",
                "classroom_id": "none",
            },
        )
        self.assertEqual(missing_auth.status_code, 401)

    def test_e2e_local_only_mode_and_password_reset(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "local"
        os.environ["BELLFORGE_AUTH_EXPOSE_RESET_TOKEN"] = "1"
        get_auth_service(force_reload=True)

        cloud_attempt = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:blocked-user:blocked-user@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(cloud_attempt.status_code, 403)

        register = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "e2e-local@example.com",
                "password": "local-password-123",
                "name": "E2E Local",
                "client_type": "web",
            },
        )
        self.assertEqual(register.status_code, 200)

        wrong = self.client.post(
            "/api/auth/local/login",
            json={"email": "e2e-local@example.com", "password": "wrong-password-999", "client_type": "web"},
        )
        self.assertEqual(wrong.status_code, 401)

        reset_requested = self.client.post(
            "/api/auth/local/password-reset/request",
            json={"email": "e2e-local@example.com"},
        )
        self.assertEqual(reset_requested.status_code, 200)
        token = reset_requested.json()["reset_token"]

        reset_confirm = self.client.post(
            "/api/auth/local/password-reset/confirm",
            json={"reset_token": token, "new_password": "new-local-password-456"},
        )
        self.assertEqual(reset_confirm.status_code, 200)

        login = self.client.post(
            "/api/auth/local/login",
            json={"email": "e2e-local@example.com", "password": "new-local-password-456", "client_type": "web"},
        )
        self.assertEqual(login.status_code, 200)


if __name__ == "__main__":
    unittest.main()
