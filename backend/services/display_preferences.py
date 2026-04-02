from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CLIENT_ENV = {
    "BELLFORGE_KIOSK_URL": "http://127.0.0.1:8000/client/index.html",
    "BELLFORGE_CEC_POWER_ON": "1",
    "BELLFORGE_HDMI_WAIT_SECONDS": "45",
    "BELLFORGE_X_WAIT_SECONDS": "45",
    "BELLFORGE_DISPLAY_SCALE": "0.96",
    "BELLFORGE_STATUS_ROTATE_SECONDS": "8",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_env_path(project_root: Path) -> Path:
    return project_root / "config" / "client.env"


def _read_client_env(project_root: Path) -> dict[str, str]:
    env_path = _client_env_path(project_root)
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values

    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        values[key.strip()] = value.strip()

    return values


def _write_client_env(project_root: Path, values: dict[str, str]) -> None:
    env_path = _client_env_path(project_root)
    env_path.parent.mkdir(parents=True, exist_ok=True)
    ordered = {**DEFAULT_CLIENT_ENV, **values}
    lines = [f"{key}={value}" for key, value in ordered.items()]
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _scale_to_percent(raw_value: str | None) -> int:
    try:
        numeric = float(raw_value or DEFAULT_CLIENT_ENV["BELLFORGE_DISPLAY_SCALE"])
    except ValueError:
        numeric = float(DEFAULT_CLIENT_ENV["BELLFORGE_DISPLAY_SCALE"])
    return max(85, min(100, round(numeric * 100)))


def _rotation_seconds(raw_value: str | None) -> int:
    try:
        numeric = int(str(raw_value or DEFAULT_CLIENT_ENV["BELLFORGE_STATUS_ROTATE_SECONDS"]).strip())
    except ValueError:
        numeric = int(DEFAULT_CLIENT_ENV["BELLFORGE_STATUS_ROTATE_SECONDS"])
    return max(4, min(30, numeric))


def get_display_preferences(project_root: Path) -> dict[str, Any]:
    env_values = {**DEFAULT_CLIENT_ENV, **_read_client_env(project_root)}
    overscan_percent = _scale_to_percent(env_values.get("BELLFORGE_DISPLAY_SCALE"))
    rotation_seconds = _rotation_seconds(env_values.get("BELLFORGE_STATUS_ROTATE_SECONDS"))
    return {
        "timestamp": _utc_now(),
        "overscan_percent": overscan_percent,
        "display_scale": round(overscan_percent / 100.0, 2),
        "diagnostics_rotation_seconds": rotation_seconds,
        "preferences": {
            "kiosk_url": env_values.get("BELLFORGE_KIOSK_URL", DEFAULT_CLIENT_ENV["BELLFORGE_KIOSK_URL"]),
            "cec_power_on": env_values.get("BELLFORGE_CEC_POWER_ON", DEFAULT_CLIENT_ENV["BELLFORGE_CEC_POWER_ON"]) == "1",
            "hdmi_wait_seconds": int(env_values.get("BELLFORGE_HDMI_WAIT_SECONDS", DEFAULT_CLIENT_ENV["BELLFORGE_HDMI_WAIT_SECONDS"])),
            "x_wait_seconds": int(env_values.get("BELLFORGE_X_WAIT_SECONDS", DEFAULT_CLIENT_ENV["BELLFORGE_X_WAIT_SECONDS"])),
        },
    }


def update_display_preferences(
    project_root: Path,
    *,
    overscan_percent: int | None = None,
    diagnostics_rotation_seconds: int | None = None,
) -> dict[str, Any]:
    current = {**DEFAULT_CLIENT_ENV, **_read_client_env(project_root)}

    if overscan_percent is not None:
        clamped_percent = max(85, min(100, int(overscan_percent)))
        current["BELLFORGE_DISPLAY_SCALE"] = f"{clamped_percent / 100.0:.2f}"

    if diagnostics_rotation_seconds is not None:
        clamped_rotation = max(4, min(30, int(diagnostics_rotation_seconds)))
        current["BELLFORGE_STATUS_ROTATE_SECONDS"] = str(clamped_rotation)

    _write_client_env(project_root, current)
    return {
        "timestamp": _utc_now(),
        "updated": True,
        "message": "Display preferences saved.",
        **get_display_preferences(project_root),
    }


def export_display_preferences_json(project_root: Path) -> str:
    return json.dumps(get_display_preferences(project_root))