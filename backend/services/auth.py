from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _mask(value: str | None) -> str:
    if not value:
        return ""
    if len(value) <= 2:
        return "*" * len(value)
    return value[0] + ("*" * (len(value) - 2)) + value[-1]


def _extract_credentials(settings: dict[str, Any]) -> tuple[str | None, str | None]:
    auth_raw = settings.get("auth")
    auth_obj: dict[str, Any] = auth_raw if isinstance(auth_raw, dict) else {}
    username = auth_obj.get("username") or settings.get("auth_username")
    password = auth_obj.get("password") or settings.get("auth_password")
    if isinstance(username, str) and isinstance(password, str):
        return username, password
    return None, None


def validate_auth(username: str | None, password: str | None) -> bool:
    return bool(username and password and len(password) >= 8)


def get_auth_status(project_root: Path) -> dict[str, Any]:
    config_dir = project_root / "config"
    settings = _read_json(config_dir / "settings.json")
    auth_state = _read_json(config_dir / "auth_state.json")

    username, password = _extract_credentials(settings)
    authenticated = validate_auth(username, password)

    return {
        "timestamp": _utc_now(),
        "credentials": {
            "username": _mask(username),
            "password": "********" if password else "",
        },
        "authentication_succeeded": bool(auth_state.get("authentication_succeeded", authenticated)),
        "last_auth_attempt": auth_state.get("last_auth_attempt"),
    }
