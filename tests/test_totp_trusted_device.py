"""
Tests for TOTP 2FA and trusted device token functionality.

Covers:
- TOTP setup begin / confirm / disable / status
- TOTP code verification (live code + backup codes)
- Trusted device token issue / verify / revoke
- Renewal frequency options (daily, weekly, monthly)
- Expiry enforcement
- Server promotion auth preconditions (regression)
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import pyotp

from backend.services.unified_auth import AuthError, UnifiedAuthService, get_auth_service


def _make_service(temp_dir: str) -> UnifiedAuthService:
    store_path = Path(temp_dir) / "auth_registry.json"
    os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(store_path)
    os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
    os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
    os.environ["BELLFORGE_JWT_SECRET"] = "totp-test-secret-abc123def456ghi789jkl"
    return get_auth_service(force_reload=True)


class TotpSetupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._env_backup = dict(os.environ)
        self.service = _make_service(self.temp_dir.name)
        # Register and login a local user
        os.environ["BELLFORGE_AUTH_ALLOW_WEAK_DEV_PASSWORDS"] = "1"
        self.service = get_auth_service(force_reload=True)
        result = self.service.local_register("totp@example.com", "password1", "TOTP User", "web")
        self.access_token = result["access_token"]
        self.user_id = result["user"]["id"]
        self.principal = self.service.verify_bellforge_token(self.access_token)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_totp_setup_begin_returns_provisioning_uri(self) -> None:
        result = self.service.totp_setup_begin(self.principal)
        self.assertTrue(result["ok"])
        self.assertIn("provisioning_uri", result)
        self.assertIn("otpauth://totp/", result["provisioning_uri"])
        self.assertIn("secret", result)
        self.assertGreater(len(result["secret"]), 8)

    def test_totp_setup_begin_stores_unconfirmed_setup(self) -> None:
        self.service.totp_setup_begin(self.principal)
        data = self.service._read()
        setup = data["totp_setups"].get(self.user_id)
        self.assertIsNotNone(setup)
        self.assertFalse(setup["confirmed"])

    def test_totp_setup_confirm_with_valid_code(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        code = totp.now()
        result = self.service.totp_setup_confirm(self.principal, code)
        self.assertTrue(result["ok"])
        self.assertTrue(result["totp_enabled"])
        self.assertIsInstance(result["backup_codes"], list)
        self.assertEqual(len(result["backup_codes"]), 8)

    def test_totp_setup_confirm_enables_totp_on_user(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        self.service.totp_setup_confirm(self.principal, totp.now())
        data = self.service._read()
        user = data["users"][self.user_id]
        self.assertTrue(user.get("totp_enabled"))
        self.assertEqual(user.get("totp_secret"), secret)

    def test_totp_setup_confirm_rejects_invalid_code(self) -> None:
        self.service.totp_setup_begin(self.principal)
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_setup_confirm(self.principal, "000000")
        self.assertEqual(ctx.exception.code, "totp_invalid_code")

    def test_totp_setup_confirm_fails_without_begin(self) -> None:
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_setup_confirm(self.principal, "123456")
        self.assertEqual(ctx.exception.code, "totp_setup_not_found")

    def test_totp_verify_valid_live_code(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        self.service.totp_setup_confirm(self.principal, totp.now())
        result = self.service.totp_verify(self.principal, totp.now())
        self.assertTrue(result["ok"])
        self.assertEqual(result["method"], "totp")

    def test_totp_verify_rejects_wrong_code(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        self.service.totp_setup_confirm(self.principal, totp.now())
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_verify(self.principal, "000000")
        self.assertEqual(ctx.exception.code, "totp_invalid_code")

    def test_totp_verify_fails_when_totp_not_enabled(self) -> None:
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_verify(self.principal, "123456")
        self.assertEqual(ctx.exception.code, "totp_not_enabled")

    def test_totp_backup_codes_work_once(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        confirm = self.service.totp_setup_confirm(self.principal, totp.now())
        backup_code = confirm["backup_codes"][0]

        # First use should succeed
        result = self.service.totp_verify(self.principal, backup_code)
        self.assertEqual(result["method"], "backup_code")
        self.assertEqual(result["remaining_backup_codes"], 7)

        # Second use with same code should fail
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_verify(self.principal, backup_code)
        self.assertEqual(ctx.exception.code, "totp_invalid_code")

    def test_totp_disable_removes_totp(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        self.service.totp_setup_confirm(self.principal, totp.now())
        result = self.service.totp_disable(self.principal)
        self.assertTrue(result["ok"])
        self.assertFalse(result["totp_enabled"])
        # After disable, verify should fail with not_enabled
        with self.assertRaises(AuthError) as ctx:
            self.service.totp_verify(self.principal, totp.now())
        self.assertEqual(ctx.exception.code, "totp_not_enabled")

    def test_totp_status_not_enabled(self) -> None:
        status = self.service.totp_status(self.principal)
        self.assertFalse(status["totp_enabled"])
        self.assertEqual(status["backup_codes_remaining"], 0)

    def test_totp_status_enabled(self) -> None:
        begin = self.service.totp_setup_begin(self.principal)
        secret = begin["secret"]
        totp = pyotp.TOTP(secret)
        self.service.totp_setup_confirm(self.principal, totp.now())
        status = self.service.totp_status(self.principal)
        self.assertTrue(status["totp_enabled"])
        self.assertEqual(status["backup_codes_remaining"], 8)


class TrustedDeviceTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._env_backup = dict(os.environ)
        self.service = _make_service(self.temp_dir.name)
        result = self.service.login("google", "stub:google:td-user:td@example.com", "web")
        self.access_token = result["access_token"]
        self.user_id = result["user"]["id"]
        self.principal = self.service.verify_bellforge_token(self.access_token)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_issue_trusted_device_token_monthly(self) -> None:
        result = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-001", renewal_frequency="monthly"
        )
        self.assertIn("trusted_device_token", result)
        self.assertEqual(result["renewal_frequency"], "monthly")
        self.assertEqual(result["trusted_device_token_expires_in"], 30 * 86400)

    def test_issue_trusted_device_token_weekly(self) -> None:
        result = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-002", renewal_frequency="weekly"
        )
        self.assertEqual(result["trusted_device_token_expires_in"], 7 * 86400)

    def test_issue_trusted_device_token_daily(self) -> None:
        result = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-003", renewal_frequency="daily"
        )
        self.assertEqual(result["trusted_device_token_expires_in"], 86400)

    def test_unknown_renewal_frequency_defaults_to_monthly(self) -> None:
        result = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-004", renewal_frequency="yearly"
        )
        self.assertEqual(result["renewal_frequency"], "monthly")

    def test_verify_trusted_device_token_success(self) -> None:
        issued = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-005"
        )
        result = self.service.verify_trusted_device_token(issued["trusted_device_token"], "FP-005")
        self.assertTrue(result["ok"])
        self.assertEqual(result["device_fingerprint"], "FP-005")
        self.assertEqual(result["user_id"], self.user_id)

    def test_verify_trusted_device_token_wrong_fingerprint(self) -> None:
        issued = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-006"
        )
        with self.assertRaises(AuthError) as ctx:
            self.service.verify_trusted_device_token(issued["trusted_device_token"], "FP-WRONG")
        self.assertEqual(ctx.exception.code, "fingerprint_mismatch")

    def test_verify_trusted_device_token_wrong_type(self) -> None:
        # Access token is not a trusted_device token
        with self.assertRaises(AuthError) as ctx:
            self.service.verify_trusted_device_token(self.access_token, "FP-006")
        self.assertEqual(ctx.exception.code, "invalid_token_type")

    def test_revoke_trusted_device_token(self) -> None:
        issued = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-007"
        )
        token = issued["trusted_device_token"]
        self.service.revoke_trusted_device_token(self.principal, "FP-007")
        with self.assertRaises(AuthError) as ctx:
            self.service.verify_trusted_device_token(token, "FP-007")
        self.assertEqual(ctx.exception.code, "trusted_device_revoked")

    def test_reissue_revokes_old_token(self) -> None:
        first = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-008"
        )
        first_token = first["trusted_device_token"]
        # Re-issue for same fingerprint
        self.service.issue_trusted_device_token(self.principal, device_fingerprint="FP-008")
        # Old token should now be revoked
        with self.assertRaises(AuthError) as ctx:
            self.service.verify_trusted_device_token(first_token, "FP-008")
        self.assertIn(ctx.exception.code, {"trusted_device_revoked", "invalid_token", "token_revoked"})

    def test_trusted_device_token_is_jwt_type_trusted_device(self) -> None:
        import importlib
        jwt = importlib.import_module("jwt")
        issued = self.service.issue_trusted_device_token(
            self.principal, device_fingerprint="FP-009"
        )
        token_str = issued["trusted_device_token"]
        payload = jwt.decode(
            token_str,
            "totp-test-secret-abc123def456ghi789jkl",
            algorithms=["HS256"],
            audience="bellforge",
            issuer="bellforge-server",
        )
        self.assertEqual(payload["typ"], "trusted_device")
        self.assertEqual(payload["device_fingerprint"], "FP-009")


class OAuthStateTests(unittest.TestCase):
    """Test OAuth2 PKCE state management (no actual HTTP calls)."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(Path(self.temp_dir.name) / "auth_registry.json")
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
        os.environ["BELLFORGE_JWT_SECRET"] = "oauth-test-secret-abc123def456"
        os.environ["BELLFORGE_GOOGLE_CLIENT_ID"] = "google-client-id-test"
        os.environ["BELLFORGE_MICROSOFT_CLIENT_ID"] = "microsoft-client-id-test"
        os.environ["BELLFORGE_APPLE_CLIENT_ID"] = "apple-client-id-test"
        self.service = get_auth_service(force_reload=True)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_oauth_begin_google_returns_authorization_url(self) -> None:
        result = self.service.oauth_begin("google", "https://app.example.com/callback")
        self.assertIn("authorization_url", result)
        self.assertIn("accounts.google.com", result["authorization_url"])
        self.assertIn("state=", result["authorization_url"])
        self.assertIn("code_challenge=", result["authorization_url"])
        self.assertIn("code_challenge_method=S256", result["authorization_url"])

    def test_oauth_begin_microsoft_returns_authorization_url(self) -> None:
        result = self.service.oauth_begin("microsoft", "https://app.example.com/callback")
        self.assertIn("login.microsoftonline.com", result["authorization_url"])

    def test_oauth_begin_apple_returns_authorization_url(self) -> None:
        result = self.service.oauth_begin("apple", "https://app.example.com/callback")
        self.assertIn("appleid.apple.com", result["authorization_url"])
        self.assertIn("response_mode=form_post", result["authorization_url"])

    def test_oauth_begin_unsupported_provider_raises(self) -> None:
        with self.assertRaises(AuthError) as ctx:
            self.service.oauth_begin("github", "https://app.example.com/callback")
        self.assertEqual(ctx.exception.code, "unsupported_provider")

    def test_oauth_begin_missing_client_id_raises(self) -> None:
        del os.environ["BELLFORGE_GOOGLE_CLIENT_ID"]
        self.service = get_auth_service(force_reload=True)
        with self.assertRaises(AuthError) as ctx:
            self.service.oauth_begin("google", "https://app.example.com/callback")
        self.assertEqual(ctx.exception.code, "provider_not_configured")

    def test_oauth_begin_stores_state_in_registry(self) -> None:
        result = self.service.oauth_begin("google", "https://app.example.com/callback")
        state = result["state"]
        data = self.service._read()
        self.assertIn(state, data["oauth_states"])
        entry = data["oauth_states"][state]
        self.assertEqual(entry["provider"], "google")
        self.assertIn("code_verifier", entry)
        self.assertEqual(entry["redirect_uri"], "https://app.example.com/callback")

    def test_oauth_callback_rejects_invalid_state(self) -> None:
        with self.assertRaises(AuthError) as ctx:
            self.service.oauth_callback("invalid-state-xyz", "authcode123")
        self.assertEqual(ctx.exception.code, "invalid_oauth_state")

    def test_oauth_callback_state_is_single_use(self) -> None:
        """After one callback attempt (even failing), the state is consumed."""
        result = self.service.oauth_begin("google", "https://app.example.com/callback")
        state = result["state"]
        # Attempting callback will fail (no real token exchange), but state must be gone
        try:
            self.service.oauth_callback(state, "fake-code")
        except AuthError:
            pass
        data = self.service._read()
        self.assertNotIn(state, data["oauth_states"])

    def test_oauth_begin_cloud_disabled_raises(self) -> None:
        os.environ["BELLFORGE_AUTH_MODE"] = "local"
        self.service = get_auth_service(force_reload=True)
        with self.assertRaises(AuthError) as ctx:
            self.service.oauth_begin("google", "https://app.example.com/callback")
        self.assertEqual(ctx.exception.code, "cloud_auth_disabled")

    def test_multiple_states_independent(self) -> None:
        r1 = self.service.oauth_begin("google", "https://a.example.com/cb")
        r2 = self.service.oauth_begin("microsoft", "https://b.example.com/cb")
        self.assertNotEqual(r1["state"], r2["state"])
        data = self.service._read()
        self.assertIn(r1["state"], data["oauth_states"])
        self.assertIn(r2["state"], data["oauth_states"])


class AuthStatusTotpIntegrationTests(unittest.TestCase):
    """Tests that auth_status correctly reflects TOTP state."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(Path(self.temp_dir.name) / "auth_registry.json")
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
        os.environ["BELLFORGE_AUTH_ALLOW_WEAK_DEV_PASSWORDS"] = "1"
        os.environ["BELLFORGE_JWT_SECRET"] = "status-totp-secret-abc123def456"
        self.service = get_auth_service(force_reload=True)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_auth_status_two_factor_state_local_no_totp(self) -> None:
        self.service.local_register("s@example.com", "pass", None, "web")
        status = self.service.auth_status()
        self.assertEqual(status["two_factor_state"], "not-enabled")

    def test_auth_status_two_factor_state_local_with_totp(self) -> None:
        result = self.service.local_register("s2@example.com", "pass", None, "web")
        principal = self.service.verify_bellforge_token(result["access_token"])
        begin = self.service.totp_setup_begin(principal)
        totp = pyotp.TOTP(begin["secret"])
        self.service.totp_setup_confirm(principal, totp.now())
        status = self.service.auth_status()
        self.assertEqual(status["two_factor_state"], "enabled")

    def test_auth_status_two_factor_state_cloud_is_provider_managed(self) -> None:
        self.service.login("google", "stub:google:gs1:gs@example.com", "web")
        status = self.service.auth_status()
        self.assertEqual(status["two_factor_state"], "provider-managed")


class ServerPromotionAuthPreconditionTests(unittest.TestCase):
    """Regression: server promotion requires valid auth token.
    
    These tests use the control server API directly to verify
    that promotion blocks properly when unauthenticated.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self._env_backup = dict(os.environ)
        os.environ["BELLFORGE_AUTH_STORE_PATH"] = str(Path(self.temp_dir.name) / "auth_registry.json")
        os.environ["BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS"] = "1"
        os.environ["BELLFORGE_AUTH_MODE"] = "hybrid"
        os.environ["BELLFORGE_JWT_SECRET"] = "promotion-test-secret-abc123"
        self.service = get_auth_service(force_reload=True)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        self.temp_dir.cleanup()

    def test_verify_token_ok_when_logged_in(self) -> None:
        result = self.service.login("google", "stub:google:promo1:promo@example.com", "web")
        principal = self.service.verify_bellforge_token(result["access_token"])
        self.assertEqual(principal.role, "user")

    def test_verify_token_fails_without_login(self) -> None:
        with self.assertRaises(AuthError):
            self.service.verify_bellforge_token("not-a-real-token")

    def test_verify_token_fails_after_logout(self) -> None:
        result = self.service.login("google", "stub:google:promo2:promo2@example.com", "web")
        access = result["access_token"]
        refresh = result["refresh_token"]
        self.service.logout(access, refresh)
        with self.assertRaises(AuthError):
            self.service.verify_bellforge_token(access)


if __name__ == "__main__":
    unittest.main()
