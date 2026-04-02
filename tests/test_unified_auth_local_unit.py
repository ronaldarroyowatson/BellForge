from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.services.unified_auth import AuthError, get_auth_service


class UnifiedAuthLocalUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_AUTH_EXPOSE_RESET_TOKEN"] = "1"
        os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
        os.environ["BELLFORGE_JWT_SECRET"] = "local-unit-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _load_store(self) -> dict:
        return json.loads(self.store_path.read_text(encoding="utf-8"))

    def test_local_password_hashing_and_login(self) -> None:
        service = get_auth_service(force_reload=True)
        registered = service.local_register("teacher@example.com", "very-secure-password", "Teacher", "web")
        self.assertEqual(registered["user"]["provider"], "local")

        store = self._load_store()
        user_id = registered["user"]["id"]
        user = store["users"][user_id]
        self.assertNotEqual(user["local_password_hash"], "very-secure-password")

        logged_in = service.local_login("teacher@example.com", "very-secure-password", "web")
        self.assertIn("access_token", logged_in)

    def test_local_login_wrong_password_then_lockout(self) -> None:
        service = get_auth_service(force_reload=True)
        service.local_register("lockout@example.com", "strong-password-123", "Lockout", "web")

        for _ in range(5):
            with self.assertRaises(AuthError):
                service.local_login("lockout@example.com", "wrong-password", "web")

        with self.assertRaises(AuthError) as locked:
            service.local_login("lockout@example.com", "strong-password-123", "web")
        self.assertEqual(locked.exception.code, "account_locked")

    def test_password_reset_token_generation_reuse_and_expiration(self) -> None:
        service = get_auth_service(force_reload=True)
        service.local_register("reset@example.com", "strong-password-123", "Reset", "web")

        reset = service.local_password_reset_request("reset@example.com")
        token = reset["reset_token"]
        self.assertIsInstance(token, str)

        changed = service.local_password_reset_confirm(token, "new-strong-password-456")
        self.assertTrue(changed["password_updated"])

        with self.assertRaises(AuthError):
            service.local_password_reset_confirm(token, "another-new-password-789")

        reset2 = service.local_password_reset_request("reset@example.com")
        token2 = reset2["reset_token"]
        digest2 = service._code_digest(token2)  # noqa: SLF001 - explicit edge-case test

        data = service._read()  # noqa: SLF001 - explicit edge-case test
        data["local_reset_tokens"][digest2]["expires_at"] = "2000-01-01T00:00:00+00:00"
        service._write(data)  # noqa: SLF001 - explicit edge-case test

        with self.assertRaises(AuthError):
            service.local_password_reset_confirm(token2, "fresh-password-123456")

    def test_local_only_mode_disables_cloud_auth(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "local"
        service = get_auth_service(force_reload=True)

        with self.assertRaises(AuthError) as exc:
            service.login("google", "stub:google:u1:u1@example.com", "web")
        self.assertEqual(exc.exception.code, "cloud_auth_disabled")

    def test_device_registration_conflict_and_registry_failure(self) -> None:
        service = get_auth_service(force_reload=True)
        cloud = service.login("google", "stub:google:owner:owner@example.com", "web")
        principal = service.verify_bellforge_token(cloud["access_token"])

        service.register_device(
            principal,
            device_name="Pi A",
            device_fingerprint="FP-CONFLICT-001",
            org_id="org-a",
            classroom_id="room-a",
            permissions=None,
        )

        with self.assertRaises(AuthError):
            service.register_device(
                principal,
                device_name="Pi B",
                device_fingerprint="FP-CONFLICT-001",
                org_id="org-a",
                classroom_id="room-a",
                permissions=None,
            )

        with patch.object(service, "_write", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(AuthError) as failure:
                service.register_device(
                    principal,
                    device_name="Pi C",
                    device_fingerprint="FP-NETFAIL-001",
                    org_id="org-a",
                    classroom_id="room-a",
                    permissions=None,
                )
            self.assertEqual(failure.exception.code, "registry_unavailable")


if __name__ == "__main__":
    unittest.main()
