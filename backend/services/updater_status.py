from __future__ import annotations

import asyncio
import json
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

UPDATER_SERVICE = "bellforge-updater.service"
ACTIVE_STATES = {"checking", "update-available", "downloading", "staging", "applying", "reboot-pending"}


def _parse_semver(value: str | None) -> tuple[int, int, int]:
    if not value:
        return (0, 0, 0)
    try:
        a, b, c = value.split(".")
        return (int(a), int(b), int(c))
    except Exception:
        return (0, 0, 0)


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


async def _remote_source_status(update_base_url: str | None) -> dict[str, Any]:
    status = {
        "update_base_url": update_base_url,
        "version_healthy": False,
        "manifest_healthy": False,
        "healthy": False,
        "latest_version": None,
        "manifest_version": None,
        "last_error": None,
    }
    if not update_base_url:
        status["last_error"] = "update_base_url is not configured."
        return status

    def build_remote_url(relative_path: str, cache_token: str) -> str:
        parsed = urlsplit(f"{update_base_url.rstrip('/')}/{relative_path.lstrip('/')}")
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["_bellforge_release"] = cache_token
        return urlunsplit(parsed._replace(query=urlencode(query)))

    base_url = update_base_url.rstrip("/")
    try:
        cache_token = uuid.uuid4().hex
        async with httpx.AsyncClient(timeout=3.0) as client:
            request_headers = {
                "Cache-Control": "no-cache, no-store, max-age=0",
                "Pragma": "no-cache",
            }
            version_response = await client.get(build_remote_url("config/version.json", cache_token), headers=request_headers)
            version_response.raise_for_status()
            version_payload = version_response.json()
            version_value = version_payload.get("version")
            if isinstance(version_value, str):
                status["latest_version"] = version_value
                status["version_healthy"] = True

            manifest_response = await client.get(build_remote_url("config/manifest.json", cache_token), headers=request_headers)
            manifest_response.raise_for_status()
            manifest_payload = manifest_response.json()
            manifest_version = manifest_payload.get("version")
            if isinstance(manifest_version, str):
                status["manifest_version"] = manifest_version
            status["manifest_healthy"] = isinstance(manifest_payload.get("files"), dict)
    except Exception as exc:
        status["last_error"] = str(exc)
        return status

    status["healthy"] = bool(status["version_healthy"] and status["manifest_healthy"])
    return status


def _service_status(unit: str) -> dict[str, Any]:
    active_result = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, check=False)
    enabled_result = subprocess.run(["systemctl", "is-enabled", unit], capture_output=True, text=True, check=False)
    active = active_result.stdout.strip() or "unknown"
    enabled = enabled_result.stdout.strip() or "unknown"
    return {
        "unit": unit,
        "active": active,
        "enabled": enabled,
        "healthy": active == "active" and enabled == "enabled",
    }


async def _trigger_listener_status(port: int) -> dict[str, Any]:
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=1.0)
        writer.close()
        await writer.wait_closed()
        return {
            "port": port,
            "reachable": True,
            "healthy": True,
            "last_error": None,
        }
    except Exception as exc:
        return {
            "port": port,
            "reachable": False,
            "healthy": False,
            "last_error": str(exc),
        }


async def _post_trigger_url(trigger_url: str) -> tuple[int | None, str | None]:
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.post(trigger_url)
            return response.status_code, None
    except httpx.ConnectError:
        return None, "Updater trigger listener unreachable on localhost."
    except httpx.TimeoutException:
        return None, "Updater trigger listener timed out."
    except Exception as exc:
        return None, f"Updater trigger failed: {exc}"


def _staging_state(project_root: Path) -> dict[str, Any]:
    staging_dir = project_root / ".staging"
    state = _read_json(staging_dir / "state.json")
    progress = _read_json(staging_dir / "download_progress.json")
    last_result = _read_json(staging_dir / "last_update_result.json")
    pending_update = _read_json(staging_dir / "pending_update.json")
    pending_release_version = pending_update.get("release_version") if isinstance(pending_update, dict) else None

    if not state:
        state = {
            "state": "staged" if pending_release_version else "idle",
            "message": (
                f"BellForge {pending_release_version} is staged for next startup."
                if pending_release_version
                else "Updater state has not been recorded yet."
            ),
            "staging_in_progress": staging_dir.exists() and any(staging_dir.iterdir()),
            "reboot_pending": bool(pending_release_version) or bool(last_result.get("reboot_pending", False)),
        }

    return {
        "state": str(state.get("state") or ("staging" if state.get("staging_in_progress") else "idle")),
        "message": str(state.get("message") or last_result.get("message") or ""),
        "staging_in_progress": bool(state.get("staging_in_progress", False)),
        "reboot_pending": bool(state.get("reboot_pending", False)),
        "current_version": state.get("current_version"),
        "latest_version": state.get("latest_version"),
        "trigger_source": state.get("trigger_source"),
        "update_available": state.get("update_available"),
        "timestamp": state.get("timestamp"),
        "boot_behavior": state.get("boot_behavior"),
        "staged_update_pending": bool(pending_release_version),
        "staged_release_version": pending_release_version,
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
    remote_source = await _remote_source_status(settings.get("update_base_url"))
    latest_version = remote_source.get("latest_version")
    state = _staging_state(project_root)
    service = _service_status(UPDATER_SERVICE)
    trigger_port = int(settings.get("trigger_port", 8765))
    trigger_listener = await _trigger_listener_status(trigger_port)

    last_result_any = state.get("last_result")
    last_result_obj: dict[str, Any] = last_result_any if isinstance(last_result_any, dict) else {}
    updater_state = str(state.get("state") or "idle")
    update_available = _parse_semver(latest_version) > _parse_semver(current_version)
    communication_pipeline_healthy = bool(service.get("healthy") and trigger_listener.get("healthy") and remote_source.get("healthy"))

    issues: list[str] = []
    if service.get("active") != "active":
        issues.append("Updater service is not active.")
    if service.get("enabled") != "enabled":
        issues.append("Updater service is not enabled at boot.")
    if not trigger_listener.get("healthy"):
        issues.append("Updater trigger listener is unreachable.")
    if not remote_source.get("healthy"):
        issues.append("Update source metadata is unreachable or incomplete.")
    if last_result_obj.get("result") == "failed":
        issues.append("Last updater attempt failed.")

    if not communication_pipeline_healthy:
        health = "error" if service.get("active") != "active" or not trigger_listener.get("healthy") else "warn"
    elif last_result_obj.get("result") == "failed":
        health = "warn"
    else:
        health = "ok"

    return {
        "timestamp": _utc_now(),
        "health": health,
        "current_device_version": current_version,
        "latest_detected_version": latest_version,
        "update_available": update_available,
        "state": updater_state,
        "state_active": updater_state in ACTIVE_STATES,
        "state_message": state.get("message") or last_result_obj.get("message") or "",
        "staging_in_progress": bool(state.get("staging_in_progress", False)),
        "reboot_pending": bool(state.get("reboot_pending", False)),
        "staged_update_pending": bool(state.get("staged_update_pending", False)),
        "staged_release_version": state.get("staged_release_version"),
        "auto_updates_enabled": service.get("enabled") == "enabled",
        "checks_on_boot": service.get("enabled") == "enabled",
        "poll_interval_seconds": int(settings.get("poll_interval_seconds", 300)),
        "communication_pipeline_healthy": communication_pipeline_healthy,
        "service": service,
        "trigger_listener": trigger_listener,
        "remote_source": remote_source,
        "download_progress": state.get("download_progress", {}),
        "last_check_at": state.get("timestamp"),
        "last_trigger_source": state.get("trigger_source") or last_result_obj.get("trigger_source"),
        "boot_behavior": state.get("boot_behavior") or "startup-check-then-poll",
        "last_update_attempt": _last_update_attempt(project_root),
        "last_update_result": last_result_obj.get("result", "unknown"),
        "last_update_message": last_result_obj.get("message") or state.get("message") or "",
        "issues": issues,
    }


async def trigger_update_check_now(project_root: Path) -> dict[str, Any]:
    settings = _read_settings(project_root)
    trigger_port = int(settings.get("trigger_port", 8765))
    trigger_url = f"http://127.0.0.1:{trigger_port}/trigger-update"

    current_version = _local_version(project_root)
    remote_source = await _remote_source_status(settings.get("update_base_url"))
    latest_version = remote_source.get("latest_version")
    update_available = _parse_semver(latest_version) > _parse_semver(current_version)
    state = _staging_state(project_root)
    updater_state = str(state.get("state") or "idle")

    result: dict[str, Any] = {
        "timestamp": _utc_now(),
        "ok": False,
        "accepted": False,
        "manual_check_requested": True,
        "trigger_url": trigger_url,
        "trigger_port": trigger_port,
        "status_code": None,
        "message": "",
        "current_version": current_version,
        "latest_version": latest_version,
        "update_available": update_available,
        "state": updater_state,
        "check_requested": True,
        "check_accepted": False,
        "stage_requested": update_available,
        "stage_accepted": False,
        "stage_reason": "pending",
        "stage_message": "Manual update check has not been sent yet.",
        "remote_source": remote_source,
    }

    if updater_state in ACTIVE_STATES:
        result["message"] = f"Updater is already active ({updater_state})."
        result["stage_reason"] = "updater-active"
        result["stage_message"] = result["message"]
        return result

    if bool(state.get("staged_update_pending", False)):
        staged_version = state.get("staged_release_version")
        result["message"] = (
            f"Update already staged for next startup ({staged_version})."
            if staged_version
            else "Update already staged for next startup."
        )
        result["stage_reason"] = "already-staged"
        result["stage_message"] = result["message"]
        return result

    status_code, error_message = await _post_trigger_url(trigger_url)
    result["status_code"] = status_code

    if status_code == 200:
        result["ok"] = True
        result["accepted"] = True
        result["check_accepted"] = True
        if update_available:
            result["stage_accepted"] = True
            result["stage_reason"] = "started"
            result["stage_message"] = "Manual update check accepted. Download and staging will run in the background."
            result["message"] = result["stage_message"]
        else:
            result["stage_reason"] = "no-update-known"
            result["stage_message"] = "Manual update check accepted. No newer version is currently detected."
            result["message"] = result["stage_message"]
    elif error_message:
        result["message"] = error_message
        result["stage_reason"] = "trigger-failed"
        result["stage_message"] = error_message
    else:
        result["message"] = f"Updater trigger returned HTTP {status_code}."
        result["stage_reason"] = "bad-status"
        result["stage_message"] = result["message"]

    return result
