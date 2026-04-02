from __future__ import annotations

from typing import Any, Never

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from backend.routes.auth_api import device_principal_dependency, user_principal_dependency
from backend.services.unified_auth import AuthError, TokenPrincipal, get_auth_service

router = APIRouter()


class RegisterDeviceRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=120)
    device_fingerprint: str = Field(min_length=8, max_length=256)
    org_id: str | None = Field(default=None, min_length=1, max_length=80)
    classroom_id: str | None = Field(default=None, min_length=1, max_length=80)
    permissions: list[str] | None = Field(default=None, max_length=32)


class RevokeDeviceRequest(BaseModel):
    device_id: str = Field(min_length=4, max_length=120)
    reason: str | None = Field(default=None, max_length=200)


class TransferDeviceRequest(BaseModel):
    device_id: str = Field(min_length=4, max_length=120)
    target_user_id: str = Field(min_length=4, max_length=120)


class HeartbeatRequest(BaseModel):
    status: str = Field(default="online", min_length=2, max_length=40)
    ip_address: str | None = Field(default=None, max_length=80)
    network_id: str | None = Field(default=None, max_length=120)


class PairingInitRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=120)
    device_fingerprint: str = Field(min_length=8, max_length=256)
    network_id: str | None = Field(default=None, max_length=120)


class PairingClaimCodeRequest(BaseModel):
    pairing_code: str = Field(min_length=6, max_length=8, pattern=r"^[0-9]{6,8}$")
    org_id: str | None = Field(default=None, min_length=1, max_length=80)
    classroom_id: str | None = Field(default=None, min_length=1, max_length=80)


class PairingClaimQrRequest(BaseModel):
    pairing_token: str = Field(min_length=20, max_length=10000)
    org_id: str | None = Field(default=None, min_length=1, max_length=80)
    classroom_id: str | None = Field(default=None, min_length=1, max_length=80)


class PairingStatusRequest(BaseModel):
    pairing_token: str = Field(min_length=20, max_length=10000)
    device_fingerprint: str = Field(min_length=8, max_length=256)


def _raise(exc: AuthError) -> Never:
    from fastapi import HTTPException

    raise HTTPException(status_code=exc.status_code, detail={"error": exc.code, "message": exc.message}) from exc


@router.post("/devices/register")
async def register_device(payload: RegisterDeviceRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().register_device(
            principal,
            device_name=payload.device_name,
            device_fingerprint=payload.device_fingerprint,
            org_id=payload.org_id,
            classroom_id=payload.classroom_id,
            permissions=payload.permissions,
        )
    except AuthError as exc:
        _raise(exc)


@router.get("/devices/list")
async def list_devices(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return {"devices": get_auth_service().list_devices(principal)}
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/revoke")
async def revoke_device(payload: RevokeDeviceRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().revoke_device(principal, payload.device_id, payload.reason)
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/transfer")
async def transfer_device(payload: TransferDeviceRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().transfer_device(principal, payload.device_id, payload.target_user_id)
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/heartbeat")
async def heartbeat(payload: HeartbeatRequest, principal: TokenPrincipal = Depends(device_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().heartbeat(
            principal,
            status=payload.status,
            ip_address=payload.ip_address,
            network_id=payload.network_id,
        )
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/pairing/init")
async def pairing_init(payload: PairingInitRequest) -> dict[str, Any]:
    try:
        return get_auth_service().create_pairing_session(
            device_name=payload.device_name,
            device_fingerprint=payload.device_fingerprint,
            network_id=payload.network_id,
        )
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/pairing/claim-code")
async def pairing_claim_code(payload: PairingClaimCodeRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().claim_pairing_code(
            principal,
            payload.pairing_code,
            payload.org_id,
            payload.classroom_id,
        )
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/pairing/claim-qr")
async def pairing_claim_qr(payload: PairingClaimQrRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().claim_pairing_qr(
            principal,
            payload.pairing_token,
            payload.org_id,
            payload.classroom_id,
        )
    except AuthError as exc:
        _raise(exc)


@router.post("/devices/pairing/status")
async def pairing_status(payload: PairingStatusRequest) -> dict[str, Any]:
    try:
        return get_auth_service().pairing_status(payload.pairing_token, payload.device_fingerprint)
    except AuthError as exc:
        _raise(exc)


class AutoModeActivateRequest(BaseModel):
    controller_device_id: str = Field(min_length=4, max_length=120)
    network_id: str = Field(min_length=1, max_length=120)


class AutoModeDiscoveryRequest(BaseModel):
    discovered_device_name: str = Field(min_length=1, max_length=120)
    discovered_fingerprint: str = Field(min_length=8, max_length=256)
    network_id: str = Field(min_length=1, max_length=120)
    source: str = Field(default="heartbeat", pattern=r"^(mdns|broadcast|heartbeat|db-queue)$")
    pending_pairing_token: str | None = Field(default=None, max_length=10000)
    already_authenticated: bool = False


class AutoModeDecisionRequest(BaseModel):
    pending_id: str = Field(min_length=4, max_length=120)
    approve: bool
    org_id: str | None = Field(default=None, min_length=1, max_length=80)
    classroom_id: str | None = Field(default=None, min_length=1, max_length=80)


@router.post("/automode/activate")
async def automode_activate(payload: AutoModeActivateRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().automode_activate(principal, payload.controller_device_id, payload.network_id)
    except AuthError as exc:
        _raise(exc)


@router.post("/automode/discovery/report")
async def automode_discovery_report(payload: AutoModeDiscoveryRequest) -> dict[str, Any]:
    try:
        return get_auth_service().automode_discovery_report(
            discovered_device_name=payload.discovered_device_name,
            discovered_fingerprint=payload.discovered_fingerprint,
            network_id=payload.network_id,
            source=payload.source,
            pending_pairing_token=payload.pending_pairing_token,
            already_authenticated=payload.already_authenticated,
        )
    except AuthError as exc:
        _raise(exc)


@router.get("/automode/pending")
async def automode_pending(
    principal: TokenPrincipal = Depends(user_principal_dependency),
    network_id: str | None = Query(default=None, min_length=1, max_length=120),
) -> dict[str, Any]:
    try:
        return {"pending": get_auth_service().automode_pending(principal, network_id)}
    except AuthError as exc:
        _raise(exc)


@router.post("/automode/decide")
async def automode_decide(payload: AutoModeDecisionRequest, principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return get_auth_service().automode_decide(
            principal,
            pending_id=payload.pending_id,
            approve=payload.approve,
            org_id=payload.org_id,
            classroom_id=payload.classroom_id,
        )
    except AuthError as exc:
        _raise(exc)


@router.get("/automode/history")
async def automode_history(principal: TokenPrincipal = Depends(user_principal_dependency)) -> dict[str, Any]:
    try:
        return {"history": get_auth_service().automode_history(principal)}
    except AuthError as exc:
        _raise(exc)
