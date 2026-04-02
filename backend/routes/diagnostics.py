from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.auth import get_auth_status
from backend.services.display_preferences import get_display_preferences, update_display_preferences
from backend.services.device_info import collect_device_status
from backend.services.display_pipeline import collect_display_pipeline, run_self_heal
from backend.services.logs import read_logs
from backend.services.network import NetworkUpdateRequest, get_network_info, update_network_settings
from backend.services.updater_status import get_updater_status, trigger_update_check_now

router = APIRouter()
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class NetworkUpdatePayload(BaseModel):
    ssid: str | None = Field(default=None, max_length=128)
    password: str | None = Field(default=None, max_length=256)
    use_ethernet: bool = False


class DisplaySelfHealPayload(BaseModel):
    action: Literal[
        "enable-client",
        "restart-client",
        "restart-lightdm",
        "reboot",
        "reset-gpu",
        "clear-framebuffer",
        "force-hdmi-mode",
        "cold-reboot",
    ]


class DisplayPreferencesPayload(BaseModel):
    overscan_percent: int | None = Field(default=None, ge=85, le=100)
    diagnostics_rotation_seconds: int | None = Field(default=None, ge=4, le=30)


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


@router.post("/updater/check-now", summary="Trigger updater manual check now")
async def updater_check_now() -> dict[str, Any]:
    try:
        return await trigger_update_check_now(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Updater trigger failed: {exc}")) from exc


@router.get("/display/pipeline", summary="Get end-to-end display pipeline diagnostics")
async def display_pipeline() -> dict[str, Any]:
    try:
        return await collect_display_pipeline(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display pipeline failed: {exc}")) from exc


@router.get("/display/preferences", summary="Get current display preferences")
async def display_preferences() -> dict[str, Any]:
    try:
        return get_display_preferences(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display preferences failed: {exc}")) from exc


@router.post("/display/preferences", summary="Update display preferences")
async def update_display_preferences_route(payload: DisplayPreferencesPayload) -> dict[str, Any]:
    try:
        return update_display_preferences(
            _PROJECT_ROOT,
            overscan_percent=payload.overscan_percent,
            diagnostics_rotation_seconds=payload.diagnostics_rotation_seconds,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display preference update failed: {exc}")) from exc


@router.post("/display/self-heal", summary="Run a display self-heal action")
async def display_self_heal(payload: DisplaySelfHealPayload) -> dict[str, Any]:
    try:
        return run_self_heal(payload.action)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display self-heal failed: {exc}")) from exc
