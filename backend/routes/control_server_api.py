"""Control Server API routes.

Endpoints
---------
GET  /api/control/status              — Current device role and server metadata
POST /api/control/promote             — Promote this device to server role
POST /api/control/join                — Join an existing server as satellite
POST /api/control/reset               — Reset role back to UNCONFIGURED
GET  /api/control/discover            — Probe the LAN for BellForge servers
GET  /api/control/permissions/layout-edit — Whether the calling user may edit layout
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend.routes.auth_api import user_principal_dependency
from backend.services.control_server import ControlServerService, get_control_server_service
from backend.services.unified_auth import AuthError, TokenPrincipal

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class PromoteRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=120)


class JoinRequest(BaseModel):
    server_address: str = Field(min_length=7, max_length=255)
    server_device_id: str = Field(min_length=1, max_length=120)
    server_device_name: str = Field(min_length=1, max_length=120)
    server_user_id: str = Field(min_length=1, max_length=120)


# ---------------------------------------------------------------------------
# Dependency helper
# ---------------------------------------------------------------------------


def _svc() -> ControlServerService:
    return get_control_server_service()


def _http_error(exc: AuthError) -> None:
    from fastapi import HTTPException

    raise HTTPException(status_code=exc.status_code, detail={"error": exc.code, "message": exc.message}) from exc


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/control/status", summary="Control server role status")
async def control_status() -> dict[str, Any]:
    """Return the current device role (unconfigured / server / satellite)."""
    return _svc().get_status()


@router.post("/control/promote", summary="Promote this device to server role")
async def control_promote(
    payload: PromoteRequest,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    """Promote this device to control-server role.

    Requires a valid user access token. The authenticated user becomes the
    server owner — only they may edit layout on this device.
    """
    try:
        user_id = principal.user_id or principal.subject
        return _svc().promote_to_server(user_id=user_id, device_name=payload.device_name)
    except ValueError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail={"error": "invalid_request", "message": str(exc)}) from exc


@router.post("/control/join", summary="Join an existing server as satellite")
async def control_join(payload: JoinRequest) -> dict[str, Any]:
    """Configure this device as a satellite.

    No user token is required here — the server address must already be
    known (obtained from the discovery endpoint or onboarding QR).
    """
    try:
        return _svc().join_as_satellite(
            server_address=payload.server_address,
            server_device_id=payload.server_device_id,
            server_device_name=payload.server_device_name,
            server_user_id=payload.server_user_id,
        )
    except ValueError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail={"error": "invalid_request", "message": str(exc)}) from exc


@router.post("/control/reset", summary="Reset device role to unconfigured")
async def control_reset(
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    """Reset this device's control-server role.  Requires authentication."""
    return _svc().reset_role()


@router.get("/control/discover", summary="Probe the LAN for BellForge servers")
async def control_discover() -> dict[str, Any]:
    """Broadcast a UDP discovery probe and collect responding servers.

    Blocks for up to the configured discovery timeout (default 3 s).
    Returns ``{servers: [{address, device_id, device_name}]}``.
    """
    servers = _svc().discover()
    return {"servers": servers, "count": len(servers)}


@router.get("/control/permissions/layout-edit", summary="Check layout-edit permission")
async def control_layout_edit_permission(
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    """Return whether the authenticated user may edit the status-page layout.

    Response shape::

        {
            "permitted": true | false,
            "role": "server" | "satellite" | "unconfigured",
            "reason": "<human-readable explanation>"
        }
    """
    user_id = principal.user_id or principal.subject
    svc = _svc()
    permitted = svc.can_edit_layout(user_id)
    status = svc.get_status()
    role = status.get("role", "unconfigured")

    if permitted:
        reason = "Authenticated server owner has full layout-edit access."
    elif role == "satellite":
        reason = "Satellite devices cannot edit layout locally. Connect to the server."
    else:
        reason = "Authenticated user is not the server owner."

    return {"permitted": permitted, "role": role, "reason": reason}
