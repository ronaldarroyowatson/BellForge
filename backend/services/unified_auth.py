from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import os
import secrets
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

jwt = importlib.import_module("jwt")
InvalidTokenError = getattr(jwt, "InvalidTokenError")


SUPPORTED_PROVIDERS = {"google", "microsoft", "apple", "github"}
USER_DEFAULT_PERMISSIONS = ["device:register", "device:list", "device:transfer", "device:revoke"]
SUPPORTED_AUTH_MODES = {"cloud", "local", "hybrid"}


class AuthError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ProviderPrincipal:
    provider: str
    subject: str
    email: str | None
    name: str | None
    picture: str | None
    email_verified: bool


@dataclass(frozen=True)
class TokenPrincipal:
    token_type: str
    jti: str
    subject: str
    role: str
    user_id: str | None
    permissions: list[str]
    org_ids: list[str]
    classroom_ids: list[str]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(value: datetime | None = None) -> str:
    return (value or _utc_now()).isoformat()


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _require_exp_timestamp(payload: dict[str, Any]) -> int:
    exp_raw = payload.get("exp")
    if not isinstance(exp_raw, (int, float, str)):
        raise AuthError(401, "invalid_token", "Token expiration is missing.")
    try:
        return int(exp_raw)
    except (TypeError, ValueError) as exc:
        raise AuthError(401, "invalid_token", "Token expiration is invalid.") from exc


def _validate_local_password(password: str) -> None:
    if len(password) < 10:
        raise AuthError(400, "weak_password", "Password must be at least 10 characters long.")
    if len(password) > 256:
        raise AuthError(400, "weak_password", "Password must not exceed 256 characters.")


def _hash_local_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    chosen_salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), chosen_salt, 200_000)
    return chosen_salt.hex(), digest.hex()


def _verify_local_password(password: str, salt_hex: str, digest_hex: str) -> bool:
    salt = bytes.fromhex(salt_hex)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


class _SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[str, list[datetime]] = {}

    def check(self, key: str, max_attempts: int, window_seconds: int) -> bool:
        now = _utc_now()
        cutoff = now - timedelta(seconds=window_seconds)
        with self._lock:
            attempts = [t for t in self._hits.get(key, []) if t > cutoff]
            if len(attempts) >= max_attempts:
                self._hits[key] = attempts
                return False
            attempts.append(now)
            self._hits[key] = attempts
            return True


class _JsonAuthStore:
    def __init__(self, file_path: Path) -> None:
        self._path = file_path
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_if_missing()

    def _initialize_if_missing(self) -> None:
        if self._path.is_file():
            return
        self.write(
            {
                "users": {},
                "provider_index": {},
                "refresh_sessions": {},
                "revoked_jti": {},
                "devices": {},
                "pairing_sessions": {},
                "local_users": {},
                "local_email_index": {},
                "local_reset_tokens": {},
                "automode": {
                    "controllers": {},
                    "pending": {},
                    "history": [],
                },
            }
        )

    def read(self) -> dict[str, Any]:
        with self._lock:
            if not self._path.is_file():
                return {}
            try:
                return json.loads(self._path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise AuthError(500, "auth_store_corrupt", f"Auth store is invalid JSON: {exc}") from exc

    def write(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self._path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


class _ProviderVerifier:
    _ISSUERS = {
        "google": ["https://accounts.google.com", "accounts.google.com"],
        "microsoft": ["https://login.microsoftonline.com/common/v2.0"],
        "apple": ["https://appleid.apple.com"],
        "github": ["https://github.com/login/oauth"],
    }

    def __init__(self, allow_stub_tokens: bool) -> None:
        self._allow_stub = allow_stub_tokens

    def verify(self, provider: str, id_token: str) -> ProviderPrincipal:
        provider_norm = provider.strip().lower()
        if provider_norm not in SUPPORTED_PROVIDERS:
            raise AuthError(400, "unsupported_provider", f"Unsupported provider: {provider}")

        if self._allow_stub and id_token.startswith("stub-expired:"):
            raise AuthError(401, "invalid_id_token", "ID token has expired.")

        if self._allow_stub and id_token.startswith("stub:"):
            return self._verify_stub(provider_norm, id_token)

        return self._verify_oidc(provider_norm, id_token)

    def _verify_stub(self, provider: str, id_token: str) -> ProviderPrincipal:
        # Format: stub:<provider>:<subject>:<email>
        parts = id_token.split(":", 3)
        if len(parts) != 4:
            raise AuthError(401, "invalid_id_token", "Stub token format is invalid.")
        _, p, subject, email = parts
        if p != provider:
            raise AuthError(401, "invalid_id_token", "Stub token provider mismatch.")
        if not subject:
            raise AuthError(401, "invalid_id_token", "Stub token subject is missing.")
        return ProviderPrincipal(
            provider=provider,
            subject=subject,
            email=email or None,
            name=(email.split("@")[0] if "@" in email else subject),
            picture=None,
            email_verified=True,
        )

    def _verify_oidc(self, provider: str, id_token: str) -> ProviderPrincipal:
        audience = os.getenv(f"BELLFORGE_{provider.upper()}_CLIENT_ID", "").strip()
        jwks_url = os.getenv(f"BELLFORGE_{provider.upper()}_JWKS_URL", "").strip()
        if not audience:
            raise AuthError(500, "provider_not_configured", f"{provider} client id is not configured.")
        if not jwks_url:
            raise AuthError(500, "provider_not_configured", f"{provider} JWKS URL is not configured.")

        try:
            client = jwt.PyJWKClient(jwks_url)
            signing_key = client.get_signing_key_from_jwt(id_token)
            payload = jwt.decode(
                id_token,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                audience=audience,
                issuer=self._ISSUERS.get(provider),
                options={"require": ["exp", "iat", "sub"]},
            )
        except InvalidTokenError as exc:
            raise AuthError(401, "invalid_id_token", f"ID token failed verification: {exc}") from exc
        except Exception as exc:
            raise AuthError(401, "invalid_id_token", f"Unable to verify ID token: {exc}") from exc

        return ProviderPrincipal(
            provider=provider,
            subject=str(payload.get("sub") or ""),
            email=payload.get("email") if isinstance(payload.get("email"), str) else None,
            name=payload.get("name") if isinstance(payload.get("name"), str) else None,
            picture=payload.get("picture") if isinstance(payload.get("picture"), str) else None,
            email_verified=bool(payload.get("email_verified", False)),
        )


class UnifiedAuthService:
    def __init__(self, project_root: Path) -> None:
        store_path = os.getenv("BELLFORGE_AUTH_STORE_PATH", str(project_root / "config" / "auth_registry.json"))
        self._project_root = project_root
        self._store = _JsonAuthStore(Path(store_path))
        self._verifier = _ProviderVerifier(self._allow_stub_tokens())
        self._rate_limit = _SlidingWindowRateLimiter()
        self._jwt_secret = os.getenv("BELLFORGE_JWT_SECRET", "dev-only-change-me")
        self._jwt_issuer = os.getenv("BELLFORGE_JWT_ISSUER", "bellforge-server")
        self._access_ttl_seconds = int(os.getenv("BELLFORGE_ACCESS_TOKEN_TTL_SECONDS", "900"))
        self._refresh_ttl_seconds = int(os.getenv("BELLFORGE_REFRESH_TOKEN_TTL_SECONDS", str(60 * 60 * 24 * 30)))
        self._device_ttl_seconds = int(os.getenv("BELLFORGE_DEVICE_TOKEN_TTL_SECONDS", "3600"))
        self._pairing_ttl_seconds = int(os.getenv("BELLFORGE_PAIRING_TTL_SECONDS", "300"))
        self._qr_ttl_seconds = int(os.getenv("BELLFORGE_QR_TTL_SECONDS", "600"))

    @staticmethod
    def _allow_stub_tokens() -> bool:
        return os.getenv("BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS", "0") == "1"

    def _code_digest(self, code: str) -> str:
        return hmac.new(self._jwt_secret.encode("utf-8"), code.encode("utf-8"), hashlib.sha256).hexdigest()

    def _read(self) -> dict[str, Any]:
        payload = self._store.read()
        payload.setdefault("users", {})
        payload.setdefault("provider_index", {})
        payload.setdefault("refresh_sessions", {})
        payload.setdefault("revoked_jti", {})
        payload.setdefault("devices", {})
        payload.setdefault("pairing_sessions", {})
        payload.setdefault("local_users", {})
        payload.setdefault("local_email_index", {})
        payload.setdefault("local_reset_tokens", {})
        payload.setdefault("automode", {"controllers": {}, "pending": {}, "history": []})
        payload["automode"].setdefault("controllers", {})
        payload["automode"].setdefault("pending", {})
        payload["automode"].setdefault("history", [])
        return payload

    def _write(self, payload: dict[str, Any]) -> None:
        self._store.write(payload)

    def _cleanup(self, payload: dict[str, Any]) -> None:
        now = _utc_now()

        def not_expired(value: dict[str, Any], key: str) -> bool:
            exp_raw = value.get(key)
            if not isinstance(exp_raw, str):
                return False
            return _parse_utc(exp_raw) > now

        payload["revoked_jti"] = {
            k: v for k, v in payload["revoked_jti"].items() if isinstance(v, str) and _parse_utc(v) > now
        }
        payload["refresh_sessions"] = {
            k: v
            for k, v in payload["refresh_sessions"].items()
            if isinstance(v, dict) and not_expired(v, "expires_at") and not bool(v.get("revoked", False))
        }
        payload["pairing_sessions"] = {
            k: v
            for k, v in payload["pairing_sessions"].items()
            if isinstance(v, dict) and not_expired(v, "expires_at") and str(v.get("status", "pending")) in {"pending", "claimed"}
        }
        payload["local_reset_tokens"] = {
            k: v
            for k, v in payload["local_reset_tokens"].items()
            if isinstance(v, dict)
            and not_expired(v, "expires_at")
            and not bool(v.get("used", False))
        }

    def _auth_mode(self) -> str:
        mode = os.getenv("BELLFORGE_AUTH_MODE", "hybrid").strip().lower()
        if mode not in SUPPORTED_AUTH_MODES:
            raise AuthError(500, "invalid_auth_mode", f"Unsupported auth mode: {mode}")
        return mode

    def _assert_cloud_enabled(self) -> None:
        if self._auth_mode() == "local":
            raise AuthError(403, "cloud_auth_disabled", "Cloud auth is disabled in local-only mode.")

    def _assert_local_enabled(self) -> None:
        if self._auth_mode() == "cloud":
            raise AuthError(403, "local_auth_disabled", "Local auth is disabled in cloud-only mode.")

    def _serialize_user(self, user: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": user["id"],
            "email": user.get("email"),
            "name": user.get("name"),
            "provider": user.get("provider"),
            "org_ids": _as_list(user.get("org_ids")),
            "classroom_ids": _as_list(user.get("classroom_ids")),
            "permissions": _as_list(user.get("permissions")),
        }

    def _issue_user_token_pair(self, user: dict[str, Any], client_type: str, provider: str) -> dict[str, Any]:
        access_token = self._issue_token(
            subject=user["id"],
            role="user",
            token_type="user_access",
            ttl_seconds=self._access_ttl_seconds,
            user_id=user["id"],
            permissions=_as_list(user.get("permissions")),
            org_ids=_as_list(user.get("org_ids")),
            classroom_ids=_as_list(user.get("classroom_ids")),
            extras={"provider": provider, "client_type": client_type},
        )
        refresh_token = self._issue_token(
            subject=user["id"],
            role="user",
            token_type="user_refresh",
            ttl_seconds=self._refresh_ttl_seconds,
            user_id=user["id"],
            permissions=[],
            org_ids=[],
            classroom_ids=[],
            extras={"provider": provider, "client_type": client_type},
        )
        return {
            "token_type": "Bearer",
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": self._access_ttl_seconds,
            "refresh_expires_in": self._refresh_ttl_seconds,
        }

    def _issue_token(self, *, subject: str, role: str, token_type: str, ttl_seconds: int, user_id: str | None, permissions: list[str], org_ids: list[str], classroom_ids: list[str], extras: dict[str, Any] | None = None) -> str:
        now = _utc_now()
        jti = str(uuid.uuid4())
        payload: dict[str, Any] = {
            "iss": self._jwt_issuer,
            "sub": subject,
            "aud": "bellforge",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
            "jti": jti,
            "typ": token_type,
            "role": role,
            "user_id": user_id,
            "permissions": permissions,
            "org_ids": org_ids,
            "classroom_ids": classroom_ids,
        }
        if extras:
            payload.update(extras)
        return jwt.encode(payload, self._jwt_secret, algorithm="HS256")

    def _decode_token(self, token: str) -> dict[str, Any]:
        try:
            payload = jwt.decode(token, self._jwt_secret, algorithms=["HS256"], audience="bellforge", issuer=self._jwt_issuer)
        except InvalidTokenError as exc:
            raise AuthError(401, "invalid_token", f"Token verification failed: {exc}") from exc

        jti = payload.get("jti")
        if not isinstance(jti, str) or not jti:
            raise AuthError(401, "invalid_token", "Token jti is missing.")

        data = self._read()
        self._cleanup(data)
        revoked = data.get("revoked_jti", {})
        if jti in revoked:
            raise AuthError(401, "token_revoked", "Token has been revoked.")

        return payload

    def _principal_from_payload(self, payload: dict[str, Any]) -> TokenPrincipal:
        token_type = str(payload.get("typ") or "")
        jti = str(payload.get("jti") or "")
        subject = str(payload.get("sub") or "")
        role = str(payload.get("role") or "")
        user_id_raw = payload.get("user_id")
        user_id = str(user_id_raw) if isinstance(user_id_raw, str) else None
        return TokenPrincipal(
            token_type=token_type,
            jti=jti,
            subject=subject,
            role=role,
            user_id=user_id,
            permissions=_as_list(payload.get("permissions")),
            org_ids=_as_list(payload.get("org_ids")),
            classroom_ids=_as_list(payload.get("classroom_ids")),
        )

    def verify_bellforge_token(self, token: str, allowed_types: set[str] | None = None) -> TokenPrincipal:
        payload = self._decode_token(token)
        principal = self._principal_from_payload(payload)
        if allowed_types and principal.token_type not in allowed_types:
            raise AuthError(401, "invalid_token_type", "Token type is not permitted for this operation.")
        return principal

    def _ensure_user(self, payload: dict[str, Any], principal: ProviderPrincipal) -> dict[str, Any]:
        key = f"{principal.provider}:{principal.subject}"
        provider_index = payload["provider_index"]
        users = payload["users"]
        user_id = provider_index.get(key)

        if user_id and user_id in users:
            user = users[user_id]
            user["email"] = principal.email or user.get("email")
            user["name"] = principal.name or user.get("name")
            user["picture"] = principal.picture or user.get("picture")
            user["email_verified"] = principal.email_verified
            user["last_login_at"] = _utc_iso()
            return user

        user_id = str(uuid.uuid4())
        user = {
            "id": user_id,
            "provider": principal.provider,
            "provider_subject": principal.subject,
            "email": principal.email,
            "name": principal.name,
            "picture": principal.picture,
            "email_verified": principal.email_verified,
            "org_ids": [],
            "classroom_ids": [],
            "permissions": USER_DEFAULT_PERMISSIONS.copy(),
            "created_at": _utc_iso(),
            "last_login_at": _utc_iso(),
            "revoked": False,
        }
        users[user_id] = user
        provider_index[key] = user_id
        return user

    def login(self, provider: str, id_token: str, client_type: str) -> dict[str, Any]:
        self._assert_cloud_enabled()
        if not self._rate_limit.check(f"login:{provider.lower()}", max_attempts=25, window_seconds=60):
            raise AuthError(429, "rate_limited", "Too many login attempts. Please retry shortly.")

        principal = self._verifier.verify(provider, id_token)
        data = self._read()
        self._cleanup(data)
        user = self._ensure_user(data, principal)
        if bool(user.get("revoked", False)):
            raise AuthError(403, "user_revoked", "User account is revoked.")

        tokens = self._issue_user_token_pair(user, client_type, provider)
        refresh_token = tokens["refresh_token"]

        refresh_payload = jwt.decode(
            refresh_token,
            self._jwt_secret,
            algorithms=["HS256"],
            audience="bellforge",
            issuer=self._jwt_issuer,
        )
        refresh_jti = str(refresh_payload.get("jti"))
        data["refresh_sessions"][refresh_jti] = {
            "jti": refresh_jti,
            "user_id": user["id"],
            "created_at": _utc_iso(),
            "expires_at": _utc_iso(_utc_now() + timedelta(seconds=self._refresh_ttl_seconds)),
            "client_type": client_type,
            "revoked": False,
        }
        try:
            self._write(data)
        except OSError as exc:
            raise AuthError(503, "registry_unavailable", f"Device registry write failed: {exc}") from exc

        return {
            **tokens,
            "user": self._serialize_user(user),
        }

    def local_register(self, email: str, password: str, name: str | None, client_type: str) -> dict[str, Any]:
        self._assert_local_enabled()
        normalized = email.strip().lower()
        if "@" not in normalized:
            raise AuthError(400, "invalid_email", "A valid email address is required.")
        _validate_local_password(password)

        data = self._read()
        self._cleanup(data)
        if normalized in data["local_email_index"]:
            raise AuthError(409, "local_user_exists", "A local account already exists for this email.")

        user_id = str(uuid.uuid4())
        salt_hex, password_hash = _hash_local_password(password)
        user = {
            "id": user_id,
            "provider": "local",
            "provider_subject": f"local:{normalized}",
            "email": normalized,
            "name": name or normalized.split("@")[0],
            "picture": None,
            "email_verified": True,
            "org_ids": [],
            "classroom_ids": [],
            "permissions": USER_DEFAULT_PERMISSIONS.copy(),
            "created_at": _utc_iso(),
            "last_login_at": None,
            "revoked": False,
            "local_password_salt": salt_hex,
            "local_password_hash": password_hash,
            "failed_attempts": 0,
            "lockout_until": None,
        }
        data["users"][user_id] = user
        data["local_users"][user_id] = True
        data["local_email_index"][normalized] = user_id
        self._write(data)

        tokens = self._issue_user_token_pair(user, client_type, "local")
        refresh_payload = jwt.decode(
            tokens["refresh_token"],
            self._jwt_secret,
            algorithms=["HS256"],
            audience="bellforge",
            issuer=self._jwt_issuer,
        )
        refresh_jti = str(refresh_payload.get("jti"))
        data = self._read()
        data["refresh_sessions"][refresh_jti] = {
            "jti": refresh_jti,
            "user_id": user_id,
            "created_at": _utc_iso(),
            "expires_at": _utc_iso(_utc_now() + timedelta(seconds=self._refresh_ttl_seconds)),
            "client_type": client_type,
            "revoked": False,
        }
        self._write(data)
        return {**tokens, "user": self._serialize_user(user)}

    def local_login(self, email: str, password: str, client_type: str) -> dict[str, Any]:
        self._assert_local_enabled()
        normalized = email.strip().lower()
        data = self._read()
        self._cleanup(data)

        user_id = data["local_email_index"].get(normalized)
        if not isinstance(user_id, str):
            raise AuthError(401, "invalid_credentials", "Invalid email or password.")
        user = data["users"].get(user_id)
        if not isinstance(user, dict):
            raise AuthError(401, "invalid_credentials", "Invalid email or password.")

        lockout_raw = user.get("lockout_until")
        if isinstance(lockout_raw, str) and _parse_utc(lockout_raw) > _utc_now():
            raise AuthError(423, "account_locked", "Account is temporarily locked due to repeated failures.")

        salt_hex = str(user.get("local_password_salt") or "")
        digest_hex = str(user.get("local_password_hash") or "")
        if not salt_hex or not digest_hex or not _verify_local_password(password, salt_hex, digest_hex):
            attempts = int(user.get("failed_attempts", 0)) + 1
            user["failed_attempts"] = attempts
            if attempts >= 5:
                user["lockout_until"] = _utc_iso(_utc_now() + timedelta(minutes=15))
            self._write(data)
            raise AuthError(401, "invalid_credentials", "Invalid email or password.")

        user["failed_attempts"] = 0
        user["lockout_until"] = None
        user["last_login_at"] = _utc_iso()
        self._write(data)

        tokens = self._issue_user_token_pair(user, client_type, "local")
        refresh_payload = jwt.decode(
            tokens["refresh_token"],
            self._jwt_secret,
            algorithms=["HS256"],
            audience="bellforge",
            issuer=self._jwt_issuer,
        )
        refresh_jti = str(refresh_payload.get("jti"))
        data = self._read()
        data["refresh_sessions"][refresh_jti] = {
            "jti": refresh_jti,
            "user_id": user_id,
            "created_at": _utc_iso(),
            "expires_at": _utc_iso(_utc_now() + timedelta(seconds=self._refresh_ttl_seconds)),
            "client_type": client_type,
            "revoked": False,
        }
        self._write(data)
        return {**tokens, "user": self._serialize_user(user)}

    def local_password_reset_request(self, email: str) -> dict[str, Any]:
        self._assert_local_enabled()
        normalized = email.strip().lower()
        data = self._read()
        self._cleanup(data)

        user_id = data["local_email_index"].get(normalized)
        if not isinstance(user_id, str):
            return {"ok": True, "accepted": True}

        reset_token = secrets.token_urlsafe(32)
        digest = self._code_digest(reset_token)
        expires_at = _utc_now() + timedelta(minutes=15)
        data["local_reset_tokens"][digest] = {
            "digest": digest,
            "user_id": user_id,
            "created_at": _utc_iso(),
            "expires_at": _utc_iso(expires_at),
            "used": False,
        }
        self._write(data)

        expose_token = os.getenv("BELLFORGE_AUTH_EXPOSE_RESET_TOKEN", "0") == "1"
        return {
            "ok": True,
            "accepted": True,
            "reset_token": reset_token if expose_token else None,
            "expires_in": 900,
        }

    def local_password_reset_confirm(self, reset_token: str, new_password: str) -> dict[str, Any]:
        self._assert_local_enabled()
        _validate_local_password(new_password)

        digest = self._code_digest(reset_token)
        data = self._read()
        self._cleanup(data)
        entry = data["local_reset_tokens"].get(digest)
        if not isinstance(entry, dict):
            raise AuthError(401, "reset_token_invalid", "Password reset token is invalid.")
        if bool(entry.get("used", False)):
            raise AuthError(401, "reset_token_used", "Password reset token has already been used.")

        expiry = entry.get("expires_at")
        if not isinstance(expiry, str) or _parse_utc(expiry) <= _utc_now():
            raise AuthError(401, "reset_token_expired", "Password reset token has expired.")

        user_id = entry.get("user_id")
        user = data["users"].get(user_id)
        if not isinstance(user, dict):
            raise AuthError(404, "user_not_found", "User account for reset token was not found.")

        salt_hex, password_hash = _hash_local_password(new_password)
        user["local_password_salt"] = salt_hex
        user["local_password_hash"] = password_hash
        user["failed_attempts"] = 0
        user["lockout_until"] = None
        user["updated_at"] = _utc_iso()
        entry["used"] = True
        self._write(data)
        return {"ok": True, "password_updated": True}

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        payload = self._decode_token(refresh_token)
        if payload.get("typ") != "user_refresh":
            raise AuthError(401, "invalid_token_type", "A user refresh token is required.")

        refresh_jti = str(payload.get("jti"))
        user_id = str(payload.get("sub") or "")
        data = self._read()
        self._cleanup(data)
        session = data["refresh_sessions"].get(refresh_jti)
        if not isinstance(session, dict) or bool(session.get("revoked", False)):
            raise AuthError(401, "refresh_revoked", "Refresh token session is revoked or missing.")

        user = data["users"].get(user_id)
        if not isinstance(user, dict) or bool(user.get("revoked", False)):
            raise AuthError(403, "user_revoked", "User account is revoked.")

        data["refresh_sessions"][refresh_jti]["revoked"] = True
        data["revoked_jti"][refresh_jti] = data["refresh_sessions"][refresh_jti]["expires_at"]

        access_token = self._issue_token(
            subject=user_id,
            role="user",
            token_type="user_access",
            ttl_seconds=self._access_ttl_seconds,
            user_id=user_id,
            permissions=_as_list(user.get("permissions")),
            org_ids=_as_list(user.get("org_ids")),
            classroom_ids=_as_list(user.get("classroom_ids")),
            extras={"provider": user.get("provider"), "client_type": session.get("client_type")},
        )
        new_refresh = self._issue_token(
            subject=user_id,
            role="user",
            token_type="user_refresh",
            ttl_seconds=self._refresh_ttl_seconds,
            user_id=user_id,
            permissions=[],
            org_ids=[],
            classroom_ids=[],
            extras={"provider": user.get("provider"), "client_type": session.get("client_type")},
        )

        new_payload = jwt.decode(new_refresh, self._jwt_secret, algorithms=["HS256"], audience="bellforge", issuer=self._jwt_issuer)
        new_jti = str(new_payload.get("jti"))
        data["refresh_sessions"][new_jti] = {
            "jti": new_jti,
            "user_id": user_id,
            "created_at": _utc_iso(),
            "expires_at": _utc_iso(_utc_now() + timedelta(seconds=self._refresh_ttl_seconds)),
            "client_type": session.get("client_type"),
            "revoked": False,
        }

        self._write(data)
        return {
            "token_type": "Bearer",
            "access_token": access_token,
            "refresh_token": new_refresh,
            "expires_in": self._access_ttl_seconds,
            "refresh_expires_in": self._refresh_ttl_seconds,
        }

    def logout(self, access_token: str | None, refresh_token: str | None) -> dict[str, Any]:
        if not access_token and not refresh_token:
            raise AuthError(400, "missing_token", "An access token or refresh token is required.")

        data = self._read()
        self._cleanup(data)
        revoked = 0

        for token in [access_token, refresh_token]:
            if not token:
                continue
            payload = self._decode_token(token)
            jti = str(payload.get("jti"))
            exp = datetime.fromtimestamp(_require_exp_timestamp(payload), tz=timezone.utc)
            data["revoked_jti"][jti] = _utc_iso(exp)
            revoked += 1
            if payload.get("typ") == "user_refresh":
                session = data["refresh_sessions"].get(jti)
                if isinstance(session, dict):
                    session["revoked"] = True

        self._write(data)
        return {"ok": True, "revoked_tokens": revoked}

    def register_device(
        self,
        principal: TokenPrincipal,
        *,
        device_name: str,
        device_fingerprint: str,
        org_id: str | None,
        classroom_id: str | None,
        permissions: list[str] | None,
    ) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only user principals can register devices.")

        data = self._read()
        self._cleanup(data)
        user = data["users"].get(principal.user_id)
        if not isinstance(user, dict):
            raise AuthError(404, "user_not_found", "User does not exist.")

        for existing in data["devices"].values():
            if isinstance(existing, dict) and existing.get("fingerprint") == device_fingerprint and not bool(existing.get("revoked", False)):
                raise AuthError(409, "device_exists", "A device with this fingerprint is already registered.")

        user_perms = set(_as_list(user.get("permissions")))
        requested = set(permissions or [])
        inherited_permissions = sorted(requested if requested else user_perms)
        inherited_permissions = [perm for perm in inherited_permissions if perm in user_perms]

        device_id = str(uuid.uuid4())
        device = {
            "id": device_id,
            "name": device_name,
            "fingerprint": device_fingerprint,
            "owner_user_id": principal.user_id,
            "org_id": org_id,
            "classroom_id": classroom_id,
            "permissions": inherited_permissions,
            "revoked": False,
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "last_heartbeat_at": None,
            "status": "active",
            "auth_source": "manual-register",
            "transfer_history": [],
            "network_id": None,
            "linked_via": "register",
            "auto_update_channel": "stable",
        }
        data["devices"][device_id] = device

        token = self._issue_token(
            subject=device_id,
            role="device",
            token_type="device_access",
            ttl_seconds=self._device_ttl_seconds,
            user_id=principal.user_id,
            permissions=inherited_permissions,
            org_ids=[org_id] if org_id else _as_list(user.get("org_ids")),
            classroom_ids=[classroom_id] if classroom_id else _as_list(user.get("classroom_ids")),
            extras={"device_id": device_id},
        )
        try:
            self._write(data)
        except OSError as exc:
            raise AuthError(503, "registry_unavailable", f"Device registry write failed: {exc}") from exc

        return {"device": device, "device_token": token, "device_token_expires_in": self._device_ttl_seconds}

    def list_devices(self, principal: TokenPrincipal) -> list[dict[str, Any]]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only user principals can list devices.")

        data = self._read()
        self._cleanup(data)
        devices = []
        for value in data["devices"].values():
            if isinstance(value, dict) and value.get("owner_user_id") == principal.user_id:
                devices.append(value)
        return sorted(devices, key=lambda item: str(item.get("created_at", "")), reverse=True)

    def revoke_device(self, principal: TokenPrincipal, device_id: str, reason: str | None) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only user principals can revoke devices.")

        data = self._read()
        self._cleanup(data)
        device = data["devices"].get(device_id)
        if not isinstance(device, dict):
            raise AuthError(404, "device_not_found", "Device not found.")
        if device.get("owner_user_id") != principal.user_id:
            raise AuthError(403, "forbidden", "You do not own this device.")

        device["revoked"] = True
        device["status"] = "revoked"
        device["revoked_reason"] = reason or "revoked-by-owner"
        device["updated_at"] = _utc_iso()
        self._write(data)
        return {"ok": True, "device_id": device_id, "status": "revoked"}

    def transfer_device(self, principal: TokenPrincipal, device_id: str, target_user_id: str) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only user principals can transfer devices.")

        data = self._read()
        self._cleanup(data)
        device = data["devices"].get(device_id)
        if not isinstance(device, dict):
            raise AuthError(404, "device_not_found", "Device not found.")
        if device.get("owner_user_id") != principal.user_id:
            raise AuthError(403, "forbidden", "You do not own this device.")
        if target_user_id not in data["users"]:
            raise AuthError(404, "target_not_found", "Target user does not exist.")

        history = device.get("transfer_history")
        if not isinstance(history, list):
            history = []
        history.append(
            {
                "from_user_id": principal.user_id,
                "to_user_id": target_user_id,
                "timestamp": _utc_iso(),
            }
        )

        device["transfer_history"] = history
        device["owner_user_id"] = target_user_id
        device["linked_via"] = "transfer"
        device["updated_at"] = _utc_iso()
        self._write(data)
        return {"ok": True, "device_id": device_id, "owner_user_id": target_user_id}

    def heartbeat(self, principal: TokenPrincipal, *, status: str, ip_address: str | None, network_id: str | None) -> dict[str, Any]:
        if principal.role != "device":
            raise AuthError(403, "forbidden", "Only device principals can send heartbeat.")

        data = self._read()
        self._cleanup(data)
        device = data["devices"].get(principal.subject)
        if not isinstance(device, dict) or bool(device.get("revoked", False)):
            raise AuthError(401, "device_revoked", "Device is revoked or missing.")

        device["status"] = status
        device["last_heartbeat_at"] = _utc_iso()
        device["last_ip_address"] = ip_address
        if network_id:
            device["network_id"] = network_id
        device["updated_at"] = _utc_iso()
        self._write(data)

        return {
            "ok": True,
            "device_id": principal.subject,
            "owner_user_id": device.get("owner_user_id"),
            "permissions": _as_list(device.get("permissions")),
            "org_id": device.get("org_id"),
            "classroom_id": device.get("classroom_id"),
            "server_time": _utc_iso(),
        }

    def create_pairing_session(self, *, device_name: str, device_fingerprint: str, network_id: str | None) -> dict[str, Any]:
        if not self._rate_limit.check(f"pairing:init:{device_fingerprint}", max_attempts=8, window_seconds=60):
            raise AuthError(429, "rate_limited", "Too many pairing initialization attempts.")

        data = self._read()
        self._cleanup(data)
        session_id = str(uuid.uuid4())
        pairing_code = str(secrets.randbelow(10**8)).zfill(8)
        qr_nonce = secrets.token_urlsafe(20)
        now = _utc_now()
        expires_at = now + timedelta(seconds=self._pairing_ttl_seconds)
        qr_expires_at = now + timedelta(seconds=self._qr_ttl_seconds)

        qr_payload = self._issue_token(
            subject=session_id,
            role="pairing",
            token_type="pairing_qr",
            ttl_seconds=self._qr_ttl_seconds,
            user_id=None,
            permissions=[],
            org_ids=[],
            classroom_ids=[],
            extras={"nonce": qr_nonce},
        )

        data["pairing_sessions"][session_id] = {
            "id": session_id,
            "device_name": device_name,
            "fingerprint": device_fingerprint,
            "network_id": network_id,
            "pairing_code_digest": self._code_digest(pairing_code),
            "pairing_code_last4": pairing_code[-4:],
            "pairing_code_expires_at": _utc_iso(expires_at),
            "qr_nonce": qr_nonce,
            "qr_expires_at": _utc_iso(qr_expires_at),
            "status": "pending",
            "claimed_by_user_id": None,
            "claimed_at": None,
            "device_id": None,
            "created_at": _utc_iso(now),
            "expires_at": _utc_iso(max(expires_at, qr_expires_at)),
            "single_use": True,
        }
        self._write(data)

        return {
            "pairing_session_id": session_id,
            "pairing_code": pairing_code,
            "pairing_code_expires_in": self._pairing_ttl_seconds,
            "pairing_token": qr_payload,
            "pairing_token_expires_in": self._qr_ttl_seconds,
            "instructions": "Use code in BellForge web/extension app or scan QR payload.",
        }

    def _claim_pairing(self, data: dict[str, Any], session_id: str, user_id: str, org_id: str | None, classroom_id: str | None, linked_via: str) -> dict[str, Any]:
        session = data["pairing_sessions"].get(session_id)
        if not isinstance(session, dict):
            raise AuthError(404, "pairing_not_found", "Pairing session not found.")
        if str(session.get("status")) != "pending":
            raise AuthError(409, "pairing_already_used", "Pairing session has already been used.")

        user = data["users"].get(user_id)
        if not isinstance(user, dict):
            raise AuthError(404, "user_not_found", "User not found.")

        device_id = str(uuid.uuid4())
        permissions = _as_list(user.get("permissions"))
        device = {
            "id": device_id,
            "name": session.get("device_name") or "BellForge Device",
            "fingerprint": session.get("fingerprint"),
            "owner_user_id": user_id,
            "org_id": org_id,
            "classroom_id": classroom_id,
            "permissions": permissions,
            "revoked": False,
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "last_heartbeat_at": None,
            "status": "active",
            "auth_source": linked_via,
            "transfer_history": [],
            "network_id": session.get("network_id"),
            "linked_via": linked_via,
            "auto_update_channel": "stable",
        }
        data["devices"][device_id] = device

        session["status"] = "claimed"
        session["claimed_by_user_id"] = user_id
        session["claimed_at"] = _utc_iso()
        session["device_id"] = device_id

        return {
            "pairing_session_id": session_id,
            "device_id": device_id,
            "status": "claimed",
        }

    def claim_pairing_code(self, principal: TokenPrincipal, pairing_code: str, org_id: str | None, classroom_id: str | None) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can claim pairing codes.")
        if not self._rate_limit.check(f"pairing:code:{principal.user_id}", max_attempts=15, window_seconds=60):
            raise AuthError(429, "rate_limited", "Too many pairing code attempts.")

        digest = self._code_digest(pairing_code)
        data = self._read()
        self._cleanup(data)
        for session_id, session in data["pairing_sessions"].items():
            if not isinstance(session, dict):
                continue
            if str(session.get("status")) != "pending":
                continue
            if session.get("pairing_code_digest") != digest:
                continue
            expiry_raw = session.get("pairing_code_expires_at")
            if not isinstance(expiry_raw, str) or _parse_utc(expiry_raw) <= _utc_now():
                raise AuthError(401, "pairing_expired", "Pairing code has expired.")

            result = self._claim_pairing(data, session_id, principal.user_id, org_id, classroom_id, "pairing-code")
            self._write(data)
            return result

        raise AuthError(401, "pairing_invalid", "Pairing code is invalid.")

    def claim_pairing_qr(self, principal: TokenPrincipal, pairing_token: str, org_id: str | None, classroom_id: str | None) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can claim pairing QR payloads.")
        payload = self._decode_token(pairing_token)
        if payload.get("typ") != "pairing_qr":
            raise AuthError(401, "invalid_token_type", "Pairing QR token is required.")

        session_id = str(payload.get("sub") or "")
        nonce = str(payload.get("nonce") or "")
        data = self._read()
        self._cleanup(data)
        session = data["pairing_sessions"].get(session_id)
        if not isinstance(session, dict):
            raise AuthError(404, "pairing_not_found", "Pairing session not found.")
        if session.get("qr_nonce") != nonce:
            raise AuthError(401, "pairing_invalid", "QR nonce mismatch.")

        result = self._claim_pairing(data, session_id, principal.user_id, org_id, classroom_id, "pairing-qr")
        self._write(data)
        return result

    def pairing_status(self, pairing_token: str, device_fingerprint: str) -> dict[str, Any]:
        payload = self._decode_token(pairing_token)
        if payload.get("typ") != "pairing_qr":
            raise AuthError(401, "invalid_token_type", "Pairing token is required.")

        session_id = str(payload.get("sub") or "")
        nonce = str(payload.get("nonce") or "")
        data = self._read()
        self._cleanup(data)
        session = data["pairing_sessions"].get(session_id)
        if not isinstance(session, dict):
            raise AuthError(404, "pairing_not_found", "Pairing session not found.")
        if session.get("qr_nonce") != nonce:
            raise AuthError(401, "pairing_invalid", "Pairing token is invalid.")
        if session.get("fingerprint") != device_fingerprint:
            raise AuthError(403, "fingerprint_mismatch", "Pairing token does not match this device.")

        if session.get("status") != "claimed":
            return {
                "paired": False,
                "status": str(session.get("status")),
                "expires_at": session.get("expires_at"),
            }

        device_id = str(session.get("device_id"))
        device = data["devices"].get(device_id)
        if not isinstance(device, dict):
            raise AuthError(500, "device_missing", "Claimed device record is missing.")

        token = self._issue_token(
            subject=device_id,
            role="device",
            token_type="device_access",
            ttl_seconds=self._device_ttl_seconds,
            user_id=str(device.get("owner_user_id")),
            permissions=_as_list(device.get("permissions")),
            org_ids=[str(device.get("org_id"))] if isinstance(device.get("org_id"), str) else [],
            classroom_ids=[str(device.get("classroom_id"))] if isinstance(device.get("classroom_id"), str) else [],
            extras={"device_id": device_id},
        )

        session["status"] = "completed"
        session["expires_at"] = _utc_iso(_utc_now() + timedelta(seconds=5))
        self._write(data)

        return {
            "paired": True,
            "device_id": device_id,
            "owner_user_id": device.get("owner_user_id"),
            "permissions": _as_list(device.get("permissions")),
            "org_id": device.get("org_id"),
            "classroom_id": device.get("classroom_id"),
            "device_token": token,
            "device_token_expires_in": self._device_ttl_seconds,
        }

    def automode_activate(self, principal: TokenPrincipal, controller_device_id: str, network_id: str) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can activate AutoMode.")

        data = self._read()
        self._cleanup(data)
        data["automode"]["controllers"][controller_device_id] = {
            "controller_device_id": controller_device_id,
            "user_id": principal.user_id,
            "network_id": network_id,
            "activated_at": _utc_iso(),
            "status": "active",
        }
        self._write(data)
        return {"ok": True, "controller_device_id": controller_device_id, "status": "active"}

    def automode_discovery_report(
        self,
        *,
        discovered_device_name: str,
        discovered_fingerprint: str,
        network_id: str,
        source: str,
        pending_pairing_token: str | None,
        already_authenticated: bool,
    ) -> dict[str, Any]:
        data = self._read()
        self._cleanup(data)

        if already_authenticated:
            return {"ok": True, "queued": False, "reason": "already-authenticated"}

        pending_id = str(uuid.uuid4())
        data["automode"]["pending"][pending_id] = {
            "id": pending_id,
            "discovered_device_name": discovered_device_name,
            "discovered_fingerprint": discovered_fingerprint,
            "network_id": network_id,
            "source": source,
            "pending_pairing_token": pending_pairing_token,
            "status": "pending-approval",
            "created_at": _utc_iso(),
        }
        self._write(data)
        return {"ok": True, "queued": True, "pending_id": pending_id, "status": "pending-approval"}

    def automode_pending(self, principal: TokenPrincipal, network_id: str | None) -> list[dict[str, Any]]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can view AutoMode pending devices.")

        data = self._read()
        self._cleanup(data)
        controllers = data["automode"]["controllers"]
        user_networks = {
            str(item.get("network_id"))
            for item in controllers.values()
            if isinstance(item, dict) and item.get("user_id") == principal.user_id and item.get("status") == "active"
        }
        pending_items = []
        for item in data["automode"]["pending"].values():
            if not isinstance(item, dict):
                continue
            item_network = str(item.get("network_id") or "")
            if network_id and item_network != network_id:
                continue
            if user_networks and item_network not in user_networks:
                continue
            pending_items.append(item)
        return sorted(pending_items, key=lambda x: str(x.get("created_at", "")))

    def automode_decide(self, principal: TokenPrincipal, pending_id: str, approve: bool, org_id: str | None, classroom_id: str | None) -> dict[str, Any]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can approve AutoMode links.")

        data = self._read()
        self._cleanup(data)
        pending = data["automode"]["pending"].get(pending_id)
        if not isinstance(pending, dict):
            raise AuthError(404, "pending_not_found", "AutoMode pending item not found.")

        if not approve:
            pending["status"] = "denied"
            pending["decided_at"] = _utc_iso()
            pending["decided_by"] = principal.user_id
            data["automode"]["history"].append(dict(pending))
            del data["automode"]["pending"][pending_id]
            self._write(data)
            return {"ok": True, "pending_id": pending_id, "status": "denied"}

        user = data["users"].get(principal.user_id)
        if not isinstance(user, dict):
            raise AuthError(404, "user_not_found", "User not found.")

        device_id = str(uuid.uuid4())
        permissions = _as_list(user.get("permissions"))
        device = {
            "id": device_id,
            "name": pending.get("discovered_device_name") or "AutoMode Device",
            "fingerprint": pending.get("discovered_fingerprint"),
            "owner_user_id": principal.user_id,
            "org_id": org_id,
            "classroom_id": classroom_id,
            "permissions": permissions,
            "revoked": False,
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "last_heartbeat_at": None,
            "status": "active",
            "auth_source": "automode",
            "transfer_history": [],
            "network_id": pending.get("network_id"),
            "linked_via": "automode",
            "auto_update_channel": "stable",
        }
        data["devices"][device_id] = device

        pending["status"] = "approved"
        pending["device_id"] = device_id
        pending["decided_at"] = _utc_iso()
        pending["decided_by"] = principal.user_id
        data["automode"]["history"].append(dict(pending))
        del data["automode"]["pending"][pending_id]
        self._write(data)

        token = self._issue_token(
            subject=device_id,
            role="device",
            token_type="device_access",
            ttl_seconds=self._device_ttl_seconds,
            user_id=principal.user_id,
            permissions=permissions,
            org_ids=[org_id] if org_id else _as_list(user.get("org_ids")),
            classroom_ids=[classroom_id] if classroom_id else _as_list(user.get("classroom_ids")),
            extras={"device_id": device_id},
        )
        return {
            "ok": True,
            "pending_id": pending_id,
            "status": "approved",
            "device_id": device_id,
            "device_token": token,
            "device_token_expires_in": self._device_ttl_seconds,
        }

    def automode_history(self, principal: TokenPrincipal) -> list[dict[str, Any]]:
        if principal.role != "user" or principal.user_id is None:
            raise AuthError(403, "forbidden", "Only users can view AutoMode history.")

        data = self._read()
        self._cleanup(data)
        history = [item for item in data["automode"].get("history", []) if isinstance(item, dict)]
        return sorted(history, key=lambda x: str(x.get("decided_at") or x.get("created_at") or ""), reverse=True)

    def auth_verify(self, token: str) -> dict[str, Any]:
        payload = self._decode_token(token)
        principal = self._principal_from_payload(payload)
        return {
            "ok": True,
            "token_type": principal.token_type,
            "role": principal.role,
            "subject": principal.subject,
            "user_id": principal.user_id,
            "permissions": principal.permissions,
            "org_ids": principal.org_ids,
            "classroom_ids": principal.classroom_ids,
            "expires_at": datetime.fromtimestamp(_require_exp_timestamp(payload), tz=timezone.utc).isoformat(),
        }


_SERVICE: UnifiedAuthService | None = None


def get_auth_service(force_reload: bool = False) -> UnifiedAuthService:
    global _SERVICE
    if _SERVICE is None or force_reload:
        project_root = Path(__file__).resolve().parent.parent.parent
        _SERVICE = UnifiedAuthService(project_root)
    return _SERVICE
