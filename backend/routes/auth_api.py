from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from backend.services.unified_auth import AuthError, TokenPrincipal, get_auth_service

router = APIRouter()
_auth_scheme = HTTPBearer(auto_error=False)


class ErrorResponse(BaseModel):
    error: str
    message: str


class LoginRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=32)
    id_token: str = Field(min_length=10, max_length=10000)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=10000)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=20, max_length=10000)


class VerifyRequest(BaseModel):
    token: str | None = Field(default=None, min_length=20, max_length=10000)


class LocalRegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=120)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class LocalLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=1, max_length=256)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class LocalPasswordResetRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)


class LocalPasswordResetConfirmRequest(BaseModel):
    reset_token: str = Field(min_length=20, max_length=512)
    new_password: str = Field(min_length=1, max_length=256)


class DeleteAuthenticatedUserRequest(BaseModel):
    user_id: str = Field(min_length=4, max_length=120)


def _error_payload(exc: AuthError) -> dict[str, str]:
    return {"error": exc.code, "message": exc.message}


def _extract_bearer(credentials: HTTPAuthorizationCredentials | None) -> str | None:
    if credentials is None:
        return None
    if credentials.scheme.lower() != "bearer":
        return None
    return credentials.credentials


def _require_principal(credentials: HTTPAuthorizationCredentials | None = Depends(_auth_scheme)) -> TokenPrincipal:
    token = _extract_bearer(credentials)
    if not token:
        raise AuthError(401, "missing_token", "Bearer token is required.")
    return get_auth_service().verify_bellforge_token(token)


def user_principal_dependency(credentials: HTTPAuthorizationCredentials | None = Depends(_auth_scheme)) -> TokenPrincipal:
    from fastapi import HTTPException

    try:
        principal = _require_principal(credentials)
        if principal.role != "user":
            raise AuthError(403, "forbidden", "User token required.")
        return principal
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


def device_principal_dependency(credentials: HTTPAuthorizationCredentials | None = Depends(_auth_scheme)) -> TokenPrincipal:
    from fastapi import HTTPException

    try:
        principal = _require_principal(credentials)
        if principal.role != "device":
            raise AuthError(403, "forbidden", "Device token required.")
        return principal
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/login")
async def auth_login(payload: LoginRequest) -> dict[str, Any]:
    try:
        return get_auth_service().login(payload.provider, payload.id_token, payload.client_type)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/refresh")
async def auth_refresh(payload: RefreshRequest) -> dict[str, Any]:
    try:
        return get_auth_service().refresh(payload.refresh_token)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/logout")
async def auth_logout(
    payload: LogoutRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(_auth_scheme),
) -> dict[str, Any]:
    try:
        access_token = _extract_bearer(credentials)
        return get_auth_service().logout(access_token, payload.refresh_token)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/verify")
async def auth_verify(
    payload: VerifyRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(_auth_scheme),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    try:
        token = payload.token
        if not token:
            token = _extract_bearer(credentials)
        if not token and authorization and authorization.lower().startswith("bearer "):
            token = authorization[7:]
        if not token:
            raise AuthError(400, "missing_token", "Token is required for verification.")
        return get_auth_service().auth_verify(token)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/local/register")
async def auth_local_register(payload: LocalRegisterRequest) -> dict[str, Any]:
    try:
        return get_auth_service().local_register(
            email=payload.email,
            password=payload.password,
            name=payload.name,
            client_type=payload.client_type,
        )
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/local/login")
async def auth_local_login(payload: LocalLoginRequest) -> dict[str, Any]:
    try:
        return get_auth_service().local_login(
            email=payload.email,
            password=payload.password,
            client_type=payload.client_type,
        )
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/local/password-reset/request")
async def auth_local_password_reset_request(payload: LocalPasswordResetRequest) -> dict[str, Any]:
    try:
        return get_auth_service().local_password_reset_request(payload.email)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/local/password-reset/confirm")
async def auth_local_password_reset_confirm(payload: LocalPasswordResetConfirmRequest) -> dict[str, Any]:
    try:
        return get_auth_service().local_password_reset_confirm(
            reset_token=payload.reset_token,
            new_password=payload.new_password,
        )
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.get("/auth/users")
async def auth_users(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        users = get_auth_service().list_authenticated_users()
        return {
            "users": users,
            "count": len(users),
        }
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/users/delete")
async def auth_users_delete(
    payload: DeleteAuthenticatedUserRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    try:
        return get_auth_service().delete_authenticated_user(principal, payload.user_id)
    except AuthError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


# ---------------------------------------------------------------------------
# TOTP / 2FA endpoints
# ---------------------------------------------------------------------------


class TotpConfirmRequest(BaseModel):
    code: str = Field(min_length=4, max_length=16)


class TotpVerifyRequest(BaseModel):
    code: str = Field(min_length=4, max_length=16)


@router.post("/auth/totp/setup/begin")
async def auth_totp_setup_begin(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().totp_setup_begin(principal)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/totp/setup/confirm")
async def auth_totp_setup_confirm(
    payload: TotpConfirmRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().totp_setup_confirm(principal, payload.code)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/totp/verify")
async def auth_totp_verify(
    payload: TotpVerifyRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().totp_verify(principal, payload.code)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/totp/disable")
async def auth_totp_disable(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().totp_disable(principal)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.get("/auth/totp/status")
async def auth_totp_status(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().totp_status(principal)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


# ---------------------------------------------------------------------------
# Trusted device token endpoints
# ---------------------------------------------------------------------------


class TrustedDeviceIssueRequest(BaseModel):
    device_fingerprint: str = Field(min_length=4, max_length=256)
    renewal_frequency: str = Field(default="monthly", pattern="^(monthly|weekly|daily)$")


class TrustedDeviceVerifyRequest(BaseModel):
    token: str = Field(min_length=20, max_length=10000)
    device_fingerprint: str = Field(min_length=4, max_length=256)


class TrustedDeviceRevokeRequest(BaseModel):
    device_fingerprint: str = Field(min_length=4, max_length=256)


@router.post("/auth/trusted-device/issue")
async def auth_trusted_device_issue(
    payload: TrustedDeviceIssueRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().issue_trusted_device_token(
            principal,
            device_fingerprint=payload.device_fingerprint,
            renewal_frequency=payload.renewal_frequency,
        )
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/trusted-device/verify")
async def auth_trusted_device_verify(payload: TrustedDeviceVerifyRequest) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().verify_trusted_device_token(payload.token, payload.device_fingerprint)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/trusted-device/revoke")
async def auth_trusted_device_revoke(
    payload: TrustedDeviceRevokeRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().revoke_trusted_device_token(principal, payload.device_fingerprint)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


# ---------------------------------------------------------------------------
# OAuth2 PKCE redirect flow endpoints
# ---------------------------------------------------------------------------


class OAuthBeginRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=32)
    redirect_uri: str = Field(min_length=10, max_length=2000)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class OAuthCallbackRequest(BaseModel):
    state: str = Field(min_length=10, max_length=512)
    code: str = Field(min_length=4, max_length=2000)


@router.post("/auth/oauth/begin")
async def auth_oauth_begin(payload: OAuthBeginRequest) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().oauth_begin(
            payload.provider,
            payload.redirect_uri,
            payload.client_type,
        )
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


@router.post("/auth/oauth/callback")
async def auth_oauth_callback(payload: OAuthCallbackRequest) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        return get_auth_service().oauth_callback(payload.state, payload.code)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_error_payload(exc)) from exc


