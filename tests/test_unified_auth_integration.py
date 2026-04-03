from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.unified_auth import get_auth_service


class UnifiedAuthIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
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

    def _login(self, provider: str, subject: str) -> dict:
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

    def test_full_login_flow_for_each_supported_provider(self) -> None:
        for provider in ["google", "microsoft", "apple", "github"]:
            payload = self._login(provider, f"{provider}-user")
            self.assertIn("access_token", payload)
            self.assertIn("refresh_token", payload)
            self.assertEqual(payload["user"]["provider"], provider)

    def test_refresh_verify_and_logout_lifecycle(self) -> None:
        login = self._login("google", "refresh-user")
        access = login["access_token"]
        refresh = login["refresh_token"]

        verify = self.client.post("/api/auth/verify", json={}, headers={"Authorization": f"Bearer {access}"})
        self.assertEqual(verify.status_code, 200)
        self.assertEqual(verify.json()["role"], "user")

        refreshed = self.client.post("/api/auth/refresh", json={"refresh_token": refresh})
        self.assertEqual(refreshed.status_code, 200)

        logout = self.client.post(
            "/api/auth/logout",
            json={"refresh_token": refreshed.json()["refresh_token"]},
            headers={"Authorization": f"Bearer {refreshed.json()['access_token']}"},
        )
        self.assertEqual(logout.status_code, 200)

        verify_revoked = self.client.post(
            "/api/auth/verify",
            json={"token": refreshed.json()["access_token"]},
        )
        self.assertEqual(verify_revoked.status_code, 401)

    def test_device_register_list_and_heartbeat(self) -> None:
        login = self._login("google", "device-owner")
        headers = {"Authorization": f"Bearer {login['access_token']}"}

        registration = self.client.post(
            "/api/devices/register",
            headers=headers,
            json={
                "device_name": "Pi Lobby",
                "device_fingerprint": "FP-LOBBY-002",
                "org_id": "org-z",
                "classroom_id": "lobby",
            },
        )
        self.assertEqual(registration.status_code, 200)
        reg_payload = registration.json()

        listed = self.client.get("/api/devices/list", headers=headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()["devices"]), 1)

        hb = self.client.post(
            "/api/devices/heartbeat",
            headers={"Authorization": f"Bearer {reg_payload['device_token']}"},
            json={"status": "online", "ip_address": "192.168.1.9", "network_id": "campus-a"},
        )
        self.assertEqual(hb.status_code, 200)
        self.assertEqual(hb.json()["device_id"], reg_payload["device"]["id"])

    def test_pairing_code_and_qr_endpoints(self) -> None:
        login = self._login("google", "pairing-owner")
        headers = {"Authorization": f"Bearer {login['access_token']}"}

        init_response = self.client.post(
            "/api/devices/pairing/init",
            json={
                "device_name": "Pi Office",
                "device_fingerprint": "FP-OFFICE-003",
                "network_id": "net-office",
            },
        )
        self.assertEqual(init_response.status_code, 200)
        init_payload = init_response.json()

        claim_response = self.client.post(
            "/api/devices/pairing/claim-code",
            headers=headers,
            json={
                "pairing_code": init_payload["pairing_code"],
                "org_id": "org-z",
                "classroom_id": "office",
            },
        )
        self.assertEqual(claim_response.status_code, 200)

        status_response = self.client.post(
            "/api/devices/pairing/status",
            json={
                "pairing_token": init_payload["pairing_token"],
                "device_fingerprint": "FP-OFFICE-003",
            },
        )
        self.assertEqual(status_response.status_code, 200)
        self.assertTrue(status_response.json()["paired"])

    def test_pairing_qr_svg_endpoint_renders_image(self) -> None:
        init_response = self.client.post(
            "/api/devices/pairing/init",
            json={
                "device_name": "Pi QR",
                "device_fingerprint": "FP-QR-101",
                "network_id": "net-qr",
            },
        )
        self.assertEqual(init_response.status_code, 200)
        token = init_response.json()["pairing_token"]

        qr = self.client.get("/api/devices/pairing/qr-svg", params={"pairing_token": token})
        self.assertEqual(qr.status_code, 200)
        self.assertIn("image/svg+xml", qr.headers.get("content-type", ""))
        self.assertIn("<svg", qr.text)

    def test_automode_discovery_and_approval_endpoints(self) -> None:
        login = self._login("google", "automode-user")
        headers = {"Authorization": f"Bearer {login['access_token']}"}

        activated = self.client.post(
            "/api/automode/activate",
            headers=headers,
            json={"controller_device_id": "controller-9", "network_id": "net-lab"},
        )
        self.assertEqual(activated.status_code, 200)

        report = self.client.post(
            "/api/automode/discovery/report",
            json={
                "discovered_device_name": "Pi Lab Side",
                "discovered_fingerprint": "FP-LAB-SIDE-009",
                "network_id": "net-lab",
                "already_authenticated": False,
            },
        )
        self.assertEqual(report.status_code, 200)
        pending_id = report.json()["pending_id"]

        pending = self.client.get("/api/automode/pending", headers=headers)
        self.assertEqual(pending.status_code, 200)
        self.assertGreaterEqual(len(pending.json()["pending"]), 1)

        approved = self.client.post(
            "/api/automode/decide",
            headers=headers,
            json={"pending_id": pending_id, "approve": True, "org_id": "org-z", "classroom_id": "lab"},
        )
        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.json()["status"], "approved")

    def test_automode_discovery_skips_already_linked_fingerprint(self) -> None:
        login = self._login("google", "automode-owner")
        headers = {"Authorization": f"Bearer {login['access_token']}"}

        registered = self.client.post(
            "/api/devices/register",
            headers=headers,
            json={
                "device_name": "Pi Existing",
                "device_fingerprint": "FP-EXISTING-101",
                "org_id": "org-z",
                "classroom_id": "existing",
            },
        )
        self.assertEqual(registered.status_code, 200)

        report = self.client.post(
            "/api/automode/discovery/report",
            json={
                "discovered_device_name": "Pi Existing Duplicate",
                "discovered_fingerprint": "FP-EXISTING-101",
                "network_id": "net-lab",
                "already_authenticated": False,
            },
        )
        self.assertEqual(report.status_code, 200)
        self.assertFalse(report.json()["queued"])
        self.assertEqual(report.json()["reason"], "already-linked")


if __name__ == "__main__":
    unittest.main()
