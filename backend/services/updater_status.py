from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _read_settings(project_root: Path) -> dict[str, Any]:
    return _read_json(project_root / "config" / "settings.json")


def _local_version(project_root: Path) -> str | None:
    data = _read_json(project_root / "config" / "version.json")
    value = data.get("version")
    return value if isinstance(value, str) else None


async def _remote_version(update_base_url: str | None) -> str | None:
    if not update_base_url:
        return None
    url = f"{update_base_url.rstrip('/')}/config/version.json"
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            payload = response.json()
            value = payload.get("version")
            return value if isinstance(value, str) else None
    except Exception:
        return None


def _staging_state(project_root: Path) -> dict[str, Any]:
    staging_dir = project_root / ".staging"
    state = _read_json(staging_dir / "state.json")
    progress = _read_json(staging_dir / "download_progress.json")
    last_result = _read_json(staging_dir / "last_update_result.json")

    if not state:
        state = {
            "staging_in_progress": staging_dir.exists() and any(staging_dir.iterdir()),
            "reboot_pending": bool(last_result.get("reboot_pending", False)),
        }

    return {
        "staging_in_progress": bool(state.get("staging_in_progress", False)),
        "reboot_pending": bool(state.get("reboot_pending", False)),
        "download_progress": {
            "bytes_downloaded": int(progress.get("bytes_downloaded", 0)),
            "bytes_total": int(progress.get("bytes_total", 0)),
            "percent": float(progress.get("percent", 0.0)),
        },
        "last_result": last_result,
    }


def _last_update_attempt(project_root: Path) -> str | None:
    last_result_path = project_root / ".staging" / "last_update_result.json"
    if last_result_path.is_file():
        payload = _read_json(last_result_path)
        value = payload.get("last_update_attempt") or payload.get("timestamp")
        return value if isinstance(value, str) else None

    updater_log = Path("/var/log/bellforge-updater.log")
    if updater_log.is_file():
        return datetime.fromtimestamp(updater_log.stat().st_mtime, tz=timezone.utc).isoformat()
    return None


async def get_updater_status(project_root: Path) -> dict[str, Any]:
    settings = _read_settings(project_root)
    current_version = _local_version(project_root)
    latest_version = await _remote_version(settings.get("update_base_url"))
    state = _staging_state(project_root)

    last_result_any = state.get("last_result")
    last_result_obj: dict[str, Any] = last_result_any if isinstance(last_result_any, dict) else {}

    return {
        "timestamp": _utc_now(),
        "current_device_version": current_version,
        "latest_detected_version": latest_version,
        "staging_in_progress": bool(state.get("staging_in_progress", False)),
        "reboot_pending": bool(state.get("reboot_pending", False)),
        "download_progress": state.get("download_progress", {}),
        "last_update_attempt": _last_update_attempt(project_root),
        "last_update_result": last_result_obj.get("result", "unknown"),
    }
