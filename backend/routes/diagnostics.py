from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
import qrcode
import qrcode.image.svg

from backend.routes.auth_api import user_principal_dependency
from backend.services.auth import get_auth_status
from backend.services.control_server import get_control_server_service
from backend.services.unified_auth import TokenPrincipal
from backend.services.debug_service import inspect_debug_events, read_debug_events, write_debug_event
from backend.services.display_preferences import (
    get_display_preferences,
    get_status_layout,
    update_display_preferences,
    update_status_layout,
)
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
    theme: Literal["warm", "ocean", "forest", "high-contrast"] | None = None
    font_scale: float | None = Field(default=None, ge=0.85, le=1.35)
    ui_scale: float | None = Field(default=None, ge=0.8, le=1.2)
    card_radius_px: int | None = Field(default=None, ge=6, le=28)
    shadow_intensity: float | None = Field(default=None, ge=0.0, le=1.6)
    status_page_scale: float | None = Field(default=None, ge=0.75, le=1.0)
    layout_mode: Literal["portrait", "landscape"] | None = None


class StatusLayoutCardPayload(BaseModel):
    order: int | None = Field(default=None, ge=0, le=999)
    collapsed: bool | None = None
    hidden: bool | None = None


class StatusLayoutPayload(BaseModel):
    min_card_width: int | None = Field(default=None, ge=220, le=520)
    card_gap: int | None = Field(default=None, ge=8, le=32)
    card_order: list[str] | None = None
    cards: dict[str, StatusLayoutCardPayload] | None = None
    debug_enabled: bool | None = None
    reset_to_defaults: bool = False


class DebugEventPayload(BaseModel):
    source: str = Field(default="client", max_length=80)
    channel: str = Field(default="general", max_length=120)
    message: str = Field(default="event", max_length=240)
    level: Literal["debug", "info", "warn", "warning", "error", "critical"] = "info"
    event_type: str = Field(default="event", max_length=80)
    payload: dict[str, Any] | list[Any] | str | int | float | bool | None = None


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
    service: Literal["backend", "updater", "client", "install-repair", "debug"],
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


@router.post("/debug/event", summary="Append a structured debug event")
async def append_debug_event(payload: DebugEventPayload) -> dict[str, Any]:
    try:
        return write_debug_event(
            _PROJECT_ROOT,
            source=payload.source,
            channel=payload.channel,
            message=payload.message,
            payload=payload.payload,
            level=payload.level,
            event_type=payload.event_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Debug event append failed: {exc}")) from exc


@router.get("/debug/logs", summary="Read structured BellForge debug logs")
async def debug_logs(
    lines: int = Query(default=200, ge=1, le=2000),
    channel: str | None = Query(default=None, max_length=120),
    source: str | None = Query(default=None, max_length=80),
    contains: str | None = Query(default=None, max_length=120),
    level: str | None = Query(default=None, max_length=32),
) -> dict[str, Any]:
    try:
        return read_debug_events(
            _PROJECT_ROOT,
            limit=lines,
            channel=channel,
            source=source,
            contains=contains,
            level=level,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Debug log retrieval failed: {exc}")) from exc


@router.get("/debug/inspect", summary="Inspect recent debug events for BellForge failures")
async def debug_inspect(
    lines: int = Query(default=400, ge=1, le=2000),
) -> dict[str, Any]:
    try:
        return inspect_debug_events(_PROJECT_ROOT, limit=lines)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Debug inspection failed: {exc}")) from exc


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
            theme=payload.theme,
            font_scale=payload.font_scale,
            ui_scale=payload.ui_scale,
            card_radius_px=payload.card_radius_px,
            shadow_intensity=payload.shadow_intensity,
            status_page_scale=payload.status_page_scale,
            layout_mode=payload.layout_mode,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display preference update failed: {exc}")) from exc


@router.get("/display/status-layout", summary="Get current shared status layout")
async def status_layout() -> dict[str, Any]:
    try:
        return get_status_layout(_PROJECT_ROOT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Status layout retrieval failed: {exc}")) from exc


@router.post("/display/status-layout", summary="Update shared status layout")
async def update_status_layout_route(
    payload: StatusLayoutPayload,
    principal: TokenPrincipal = Depends(user_principal_dependency),
) -> dict[str, Any]:
    user_id = principal.user_id or principal.subject
    svc = get_control_server_service(_PROJECT_ROOT)
    if not svc.can_edit_layout(user_id):
        raise HTTPException(
            status_code=403,
            detail=_error_detail(
                "Layout editing is not permitted. "
                "This device must be the control server and you must be the server owner."
            ),
        )
    try:
        cards_payload = None
        if payload.cards is not None:
            cards_payload = {
                key: value.model_dump(exclude_none=True)
                for key, value in payload.cards.items()
            }
        return update_status_layout(
            _PROJECT_ROOT,
            min_card_width=payload.min_card_width,
            card_gap=payload.card_gap,
            card_order=payload.card_order,
            cards=cards_payload,
            debug_enabled=payload.debug_enabled,
            reset_to_defaults=payload.reset_to_defaults,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Status layout update failed: {exc}")) from exc


@router.post("/display/self-heal", summary="Run a display self-heal action")
async def display_self_heal(payload: DisplaySelfHealPayload) -> dict[str, Any]:
    try:
        return run_self_heal(payload.action)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"Display self-heal failed: {exc}")) from exc


@router.get("/qr/svg", summary="Render a QR code as SVG")
async def qr_svg(text: str = Query(min_length=1, max_length=2048)) -> Response:
    try:
        qr = qrcode.QRCode(border=2, box_size=7, error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr.add_data(text)
        qr.make(fit=True)
        image = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
        payload = image.to_string().decode("utf-8")
        return Response(content=payload, media_type="image/svg+xml")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_error_detail(f"QR render failed: {exc}")) from exc
