from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.unified_auth import get_auth_service


class UnifiedAuthLocalIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_AUTH_EXPOSE_RESET_TOKEN"] = "1"
        os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
        os.environ["BELLFORGE_JWT_SECRET"] = "local-int-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_full_local_login_flow_and_device_access(self) -> None:
        register = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "local-user@example.com",
                "password": "local-password-123",
                "name": "Local User",
                "client_type": "web",
            },
        )
        self.assertEqual(register.status_code, 200)

        login = self.client.post(
            "/api/auth/local/login",
            json={
                "email": "local-user@example.com",
                "password": "local-password-123",
                "client_type": "web",
            },
        )
        self.assertEqual(login.status_code, 200)
        access = login.json()["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        registration = self.client.post(
            "/api/devices/register",
            headers=headers,
            json={
                "device_name": "Pi Local",
                "device_fingerprint": "FP-LOCAL-001",
                "org_id": "org-local",
                "classroom_id": "room-local",
            },
        )
        self.assertEqual(registration.status_code, 200)
        device_token = registration.json()["device_token"]

        heartbeat = self.client.post(
            "/api/devices/heartbeat",
            headers={"Authorization": f"Bearer {device_token}"},
            json={"status": "online", "ip_address": "127.0.0.9", "network_id": "local-net"},
        )
        self.assertEqual(heartbeat.status_code, 200)

    def test_refresh_replay_attack_is_blocked(self) -> None:
        login = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:replay-user:replay-user@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(login.status_code, 200)
        refresh_token = login.json()["refresh_token"]

        first = self.client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
        self.assertEqual(first.status_code, 200)

        replay = self.client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
        self.assertEqual(replay.status_code, 401)

    def test_forgot_password_flow_request_to_confirm(self) -> None:
        _ = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "forgot@example.com",
                "password": "forgot-old-password-123",
                "name": "Forgot",
                "client_type": "web",
            },
        )

        requested = self.client.post(
            "/api/auth/local/password-reset/request",
            json={"email": "forgot@example.com"},
        )
        self.assertEqual(requested.status_code, 200)
        token = requested.json()["reset_token"]
        self.assertTrue(token)

        confirmed = self.client.post(
            "/api/auth/local/password-reset/confirm",
            json={
                "reset_token": token,
                "new_password": "forgot-new-password-456",
            },
        )
        self.assertEqual(confirmed.status_code, 200)

        relogin = self.client.post(
            "/api/auth/local/login",
            json={
                "email": "forgot@example.com",
                "password": "forgot-new-password-456",
                "client_type": "web",
            },
        )
        self.assertEqual(relogin.status_code, 200)

    def test_local_only_mode_does_not_attempt_cloud_validation(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "local"
        get_auth_service(force_reload=True)

        blocked = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:blocked:blocked@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.json()["detail"]["error"], "cloud_auth_disabled")

    def test_missing_cloud_env_fails_when_stub_disabled(self) -> None:
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "0"
        os.environ.pop("BELLFORGE_MICROSOFT_CLIENT_ID", None)
        os.environ.pop("BELLFORGE_MICROSOFT_JWKS_URL", None)
        get_auth_service(force_reload=True)

        response = self.client.post(
            "/api/auth/login",
            json={
                "provider": "microsoft",
                "id_token": "header.payload.signature",
                "client_type": "web",
            },
        )
        self.assertEqual(response.status_code, 500)

    def test_expired_and_malformed_provider_tokens_are_rejected(self) -> None:
        expired = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub-expired:google:expired-user:expired@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(expired.status_code, 401)

        malformed = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:missingparts",
                "client_type": "web",
            },
        )
        self.assertEqual(malformed.status_code, 401)

    def test_server_restart_mid_flow_keeps_refresh_valid(self) -> None:
        login = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:restart-user:restart@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(login.status_code, 200)
        refresh_token = login.json()["refresh_token"]

        get_auth_service(force_reload=True)

        refreshed = self.client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
        self.assertEqual(refreshed.status_code, 200)

    def test_switching_between_cloud_and_local_modes(self) -> None:
        local = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "switch@example.com",
                "password": "switch-password-123",
                "name": "Switch User",
                "client_type": "web",
            },
        )
        self.assertEqual(local.status_code, 200)

        cloud = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:switch-cloud:switch-cloud@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(cloud.status_code, 200)

        os.environ["BELLFORGE_AUTH_MODE"] = "cloud"
        get_auth_service(force_reload=True)

        local_blocked = self.client.post(
            "/api/auth/local/login",
            json={
                "email": "switch@example.com",
                "password": "switch-password-123",
                "client_type": "web",
            },
        )
        self.assertEqual(local_blocked.status_code, 403)

    def test_local_password_length_limits_and_device_registration_write_failure(self) -> None:
        too_short = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "short@example.com",
                "password": "short",
                "name": "Short",
                "client_type": "web",
            },
        )
        self.assertEqual(too_short.status_code, 422)

        too_long = self.client.post(
            "/api/auth/local/register",
            json={
                "email": "long@example.com",
                "password": "x" * 257,
                "name": "Long",
                "client_type": "web",
            },
        )
        self.assertEqual(too_long.status_code, 422)

        login = self.client.post(
            "/api/auth/login",
            json={
                "provider": "google",
                "id_token": "stub:google:netfail-user:netfail-user@example.com",
                "client_type": "web",
            },
        )
        self.assertEqual(login.status_code, 200)
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        service = get_auth_service(force_reload=False)
        with patch.object(service, "_write", side_effect=OSError("simulated registry outage")):
            registration = self.client.post(
                "/api/devices/register",
                headers=headers,
                json={
                    "device_name": "Pi NetFail",
                    "device_fingerprint": "FP-NET-FAIL-009",
                    "org_id": "org-fail",
                    "classroom_id": "room-fail",
                },
            )
        self.assertEqual(registration.status_code, 503)


if __name__ == "__main__":
    unittest.main()
