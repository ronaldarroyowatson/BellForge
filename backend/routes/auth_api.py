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
    password: str = Field(min_length=10, max_length=256)
    name: str | None = Field(default=None, max_length=120)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class LocalLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=10, max_length=256)
    client_type: str = Field(default="web", min_length=2, max_length=40)


class LocalPasswordResetRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)


class LocalPasswordResetConfirmRequest(BaseModel):
    reset_token: str = Field(min_length=20, max_length=512)
    new_password: str = Field(min_length=10, max_length=256)


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
