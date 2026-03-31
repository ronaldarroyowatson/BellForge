from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.auth import get_auth_status
from backend.services.device_info import collect_device_status
from backend.services.logs import read_logs
from backend.services.network import NetworkUpdateRequest, get_network_info, update_network_settings
from backend.services.updater_status import get_updater_status

router = APIRouter()
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class NetworkUpdatePayload(BaseModel):
    ssid: str | None = Field(default=None, max_length=128)
    password: str | None = Field(default=None, max_length=256)
    use_ethernet: bool = False


def _error_detail(message: str) -> dict[str, str]:
    return {
        "error": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/device/status", summary="Get live device diagnostics")
async def device_status() -> dict[str, Any]:
    try:
        return await collect_device_status(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Device status failed: {exc}")) from exc


@router.get("/network/info", summary="Get current network status")
async def network_info() -> dict[str, Any]:
    try:
        return await get_network_info(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Network info failed: {exc}")) from exc


@router.post("/network/update", summary="Apply network updates")
async def network_update(payload: NetworkUpdatePayload) -> dict[str, Any]:
    try:
        request = NetworkUpdateRequest(
            ssid=payload.ssid,
            password=payload.password,
            use_ethernet=payload.use_ethernet,
        )
        return await update_network_settings(_PROJECT_ROOT, request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Network update failed: {exc}")) from exc


@router.get("/auth/status", summary="Get authentication diagnostics")
async def auth_status() -> dict[str, Any]:
    try:
        return get_auth_status(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Auth status failed: {exc}")) from exc


@router.get("/logs/{service}", summary="Get service logs")
async def service_logs(
    service: Literal["backend", "updater", "client", "install-repair"],
    lines: int = Query(default=200, ge=1, le=2000),
    contains: str | None = Query(default=None, max_length=120),
) -> dict[str, Any]:
    try:
        return read_logs(_PROJECT_ROOT, service=service, line_count=lines, contains=contains)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(str(exc))) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Log retrieval failed: {exc}")) from exc


@router.get("/updater/status", summary="Get updater lifecycle state")
async def updater_status() -> dict[str, Any]:
    try:
        return await get_updater_status(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Updater status failed: {exc}")) from exc
