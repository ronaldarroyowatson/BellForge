from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from backend.services.unified_auth import AuthError, get_auth_service


class UnifiedAuthUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store_path = Path(self.temp_dir.name) / "auth_registry.json"
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(self.store_path)
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_JWT_SECRET"] = "unit-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "unused-in-stub"
        os.environ["BELLFORGE_GOOGLE_JWKS_URL"] = "https://example.invalid/jwks"
        get_auth_service(force_reload=True)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def _login_user(self, provider: str = "google", subject: str = "u1", email: str = "u1@example.com") -> dict[str, str]:
        service = get_auth_service(force_reload=True)
        payload = service.login(provider, f"stub:{provider}:{subject}:{email}", "web")
        return {
            "access": payload["access_token"],
            "refresh": payload["refresh_token"],
            "user_id": payload["user"]["id"],
        }

    def test_provider_stub_parsing_validates_provider_and_subject(self) -> None:
        service = get_auth_service(force_reload=True)
        with self.assertRaises(AuthError):
            service.login("google", "stub:microsoft:user-1:test@example.com", "web")

        with self.assertRaises(AuthError):
            service.login("google", "stub:google::test@example.com", "web")

        payload = service.login("google", "stub:google:user-1:test@example.com", "web")
        self.assertEqual(payload["user"]["provider"], "google")
        self.assertEqual(payload["user"]["email"], "test@example.com")

    def test_token_verification_rejects_revoked_access_token(self) -> None:
        service = get_auth_service(force_reload=True)
        login_payload = service.login("google", "stub:google:user-2:test2@example.com", "web")
        access = login_payload["access_token"]
        refresh = login_payload["refresh_token"]

        service.logout(access, refresh)

        with self.assertRaises(AuthError):
            service.verify_bellforge_token(access)

    def test_device_registration_inherits_permissions_from_owner(self) -> None:
        service = get_auth_service(force_reload=True)
        tokens = self._login_user(provider="google", subject="user-3", email="u3@example.com")
        principal = service.verify_bellforge_token(tokens["access"]) 

        registration = service.register_device(
            principal,
            device_name="Pi Hallway",
            device_fingerprint="FP-PI-HALLWAY-001",
            org_id="org-a",
            classroom_id="room-101",
            permissions=None,
        )

        device = registration["device"]
        self.assertEqual(device["owner_user_id"], tokens["user_id"])
        self.assertIn("device:register", device["permissions"])
        self.assertIn("device:transfer", device["permissions"])

    def test_pairing_code_and_qr_are_single_use(self) -> None:
        service = get_auth_service(force_reload=True)
        user_tokens = self._login_user(provider="google", subject="user-4", email="u4@example.com")
        principal = service.verify_bellforge_token(user_tokens["access"])

        pairing = service.create_pairing_session(
            device_name="Pi Cafeteria",
            device_fingerprint="FP-CAFETERIA-001",
            network_id="net-campus",
        )

        claim = service.claim_pairing_code(principal, pairing["pairing_code"], "org-a", "cafeteria")
        self.assertEqual(claim["status"], "claimed")

        with self.assertRaises(AuthError):
            service.claim_pairing_code(principal, pairing["pairing_code"], "org-a", "cafeteria")

        with self.assertRaises(AuthError):
            service.claim_pairing_qr(principal, pairing["pairing_token"], "org-a", "cafeteria")

    def test_automode_discovery_and_approval_linking(self) -> None:
        service = get_auth_service(force_reload=True)
        user_tokens = self._login_user(provider="google", subject="user-5", email="u5@example.com")
        principal = service.verify_bellforge_token(user_tokens["access"])

        service.automode_activate(principal, controller_device_id="controller-1", network_id="classroom-net")
        report = service.automode_discovery_report(
            discovered_device_name="Pi Side Wall",
            discovered_fingerprint="FP-SIDE-WALL-001",
            network_id="classroom-net",
            source="heartbeat",
            pending_pairing_token=None,
            already_authenticated=False,
        )
        self.assertTrue(report["queued"])

        pending = service.automode_pending(principal, network_id="classroom-net")
        self.assertEqual(len(pending), 1)

        decision = service.automode_decide(
            principal,
            pending_id=report["pending_id"],
            approve=True,
            org_id="org-a",
            classroom_id="room-102",
        )
        self.assertEqual(decision["status"], "approved")
        self.assertIn("device_token", decision)

    def test_pairing_claim_conflict_rejected_for_existing_fingerprint(self) -> None:
        service = get_auth_service(force_reload=True)
        user_tokens = self._login_user(provider="google", subject="user-7", email="u7@example.com")
        principal = service.verify_bellforge_token(user_tokens["access"])

        service.register_device(
            principal,
            device_name="Pi Existing",
            device_fingerprint="FP-CONFLICT-PAIRING-001",
            org_id="org-a",
            classroom_id="room-105",
            permissions=None,
        )

        pairing = service.create_pairing_session(
            device_name="Pi Duplicate",
            device_fingerprint="FP-CONFLICT-PAIRING-001",
            network_id="net-campus",
        )

        with self.assertRaises(AuthError) as conflict:
            service.claim_pairing_code(principal, pairing["pairing_code"], "org-a", "room-105")
        self.assertEqual(conflict.exception.code, "device_claim_conflict")

    def test_unauthorized_device_heartbeat_is_rejected(self) -> None:
        service = get_auth_service(force_reload=True)
        user_tokens = self._login_user(provider="google", subject="user-6", email="u6@example.com")
        principal = service.verify_bellforge_token(user_tokens["access"])
        registration = service.register_device(
            principal,
            device_name="Pi Gym",
            device_fingerprint="FP-GYM-001",
            org_id="org-a",
            classroom_id="gym",
            permissions=None,
        )

        _ = registration
        with self.assertRaises(AuthError):
            service.heartbeat(
                principal,
                status="online",
                ip_address="192.168.10.5",
                network_id="net-1",
            )


if __name__ == "__main__":
    unittest.main()
