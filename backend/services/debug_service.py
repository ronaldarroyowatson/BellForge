from __future__ import annotations

import json
import traceback
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DEFAULT_DEBUG_LOG_FILE = "tests/logs/bellforge-debug/events.jsonl"
DEFAULT_MAX_BYTES = 2_000_000
DEFAULT_MAX_AGE_DAYS = 7
DEFAULT_INSPECT_LIMIT = 400


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _coerce_int(value: Any, default: int, minimum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return repr(value)


@dataclass(frozen=True)
class DebugConfig:
    log_path: Path
    max_bytes: int
    max_age_days: int
    verbose: bool
    enabled: bool


def _load_settings(project_root: Path) -> dict[str, Any]:
    config_dir = project_root / "config"
    settings_path = config_dir / "settings.json"
    template_path = config_dir / "settings.template.json"
    for candidate in (settings_path, template_path):
        if candidate.is_file():
            try:
                loaded = json.loads(candidate.read_text(encoding="utf-8"))
                return loaded if isinstance(loaded, dict) else {}
            except Exception:
                return {}
    return {}


def get_debug_config(project_root: Path) -> DebugConfig:
    settings = _load_settings(project_root)
    log_path_value = settings.get("debug_log_file") or DEFAULT_DEBUG_LOG_FILE
    log_path = Path(log_path_value)
    if not log_path.is_absolute():
        log_path = project_root / log_path

    return DebugConfig(
        log_path=log_path,
        max_bytes=_coerce_int(settings.get("debug_log_max_bytes"), DEFAULT_MAX_BYTES, 10_000),
        max_age_days=_coerce_int(settings.get("debug_log_max_age_days"), DEFAULT_MAX_AGE_DAYS, 1),
        verbose=_coerce_bool(settings.get("debug_verbose"), default=False),
        enabled=_coerce_bool(settings.get("debug_enabled"), default=True),
    )


def _iter_events(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                events.append(parsed)
    return events


def _prune_events(events: list[dict[str, Any]], config: DebugConfig) -> list[dict[str, Any]]:
    cutoff = _utc_now() - timedelta(days=config.max_age_days)
    retained = []
    for event in events:
        timestamp = _parse_timestamp(event.get("timestamp"))
        if timestamp is not None and timestamp < cutoff:
            continue
        retained.append(event)

    encoded = [json.dumps(entry, separators=(",", ":"), ensure_ascii=True) for entry in retained]
    total_bytes = sum(len(item.encode("utf-8")) + 1 for item in encoded)
    while encoded and total_bytes > config.max_bytes:
        dropped = encoded.pop(0)
        retained.pop(0)
        total_bytes -= len(dropped.encode("utf-8")) + 1
    return retained


def _write_events(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(entry, ensure_ascii=True) for entry in events)
    if payload:
        payload += "\n"
    path.write_text(payload, encoding="utf-8")


def write_debug_event(
    project_root: Path,
    *,
    source: str,
    channel: str,
    message: str,
    payload: Any = None,
    level: str = "info",
    event_type: str = "event",
    include_stack: bool = False,
    verbose_only: bool = False,
) -> dict[str, Any]:
    config = get_debug_config(project_root)
    if not config.enabled:
        return {"ok": False, "reason": "disabled"}
    if verbose_only and not config.verbose:
        return {"ok": False, "reason": "verbose-disabled"}

    entry = {
        "timestamp": _utc_now_iso(),
        "source": str(source or "unknown"),
        "channel": str(channel or "general"),
        "message": str(message or "event"),
        "level": str(level or "info").lower(),
        "event_type": str(event_type or "event"),
        "payload": _json_safe(payload),
    }
    if include_stack:
        entry["stack"] = traceback.format_stack(limit=12)

    events = _iter_events(config.log_path)
    events.append(entry)
    events = _prune_events(events, config)
    _write_events(config.log_path, events)
    return {
        "ok": True,
        "log_path": str(config.log_path),
        "entry": entry,
    }


def read_debug_events(
    project_root: Path,
    *,
    limit: int = 200,
    channel: str | None = None,
    source: str | None = None,
    contains: str | None = None,
    level: str | None = None,
) -> dict[str, Any]:
    config = get_debug_config(project_root)
    events = _prune_events(_iter_events(config.log_path), config)

    if channel:
        events = [event for event in events if str(event.get("channel")) == channel]
    if source:
        events = [event for event in events if str(event.get("source")) == source]
    if level:
        events = [event for event in events if str(event.get("level")) == level]
    if contains:
        needle = contains.lower()
        filtered = []
        for event in events:
            blob = json.dumps(event, ensure_ascii=False).lower()
            if needle in blob:
                filtered.append(event)
        events = filtered

    limited = events[-max(1, min(limit, 2000)):]
    return {
        "timestamp": _utc_now_iso(),
        "log_path": str(config.log_path),
        "line_count": len(limited),
        "events": limited,
        "config": {
            "max_bytes": config.max_bytes,
            "max_age_days": config.max_age_days,
            "verbose": config.verbose,
            "enabled": config.enabled,
        },
    }


def inspect_debug_events(project_root: Path, *, limit: int = DEFAULT_INSPECT_LIMIT) -> dict[str, Any]:
    payload = read_debug_events(project_root, limit=limit)
    events = payload["events"]
    channel_counts = Counter(str(event.get("channel") or "general") for event in events)
    level_counts = Counter(str(event.get("level") or "info") for event in events)

    findings: list[dict[str, Any]] = []
    latest_layout_snapshot = None
    latest_registry_snapshot = None

    for event in reversed(events):
        payload_data = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        channel = str(event.get("channel") or "")
        level = str(event.get("level") or "")

        if latest_layout_snapshot is None and payload_data.get("layoutSnapshot"):
            latest_layout_snapshot = payload_data.get("layoutSnapshot")
        if latest_registry_snapshot is None and payload_data.get("registry"):
            latest_registry_snapshot = payload_data.get("registry")

        if level in {"error", "critical"}:
            findings.append({
                "severity": level,
                "channel": channel,
                "message": event.get("message"),
                "timestamp": event.get("timestamp"),
            })
            continue

        if channel in {
            "rendering failures",
            "card registry sync",
            "Pi update workflow",
            "exceptions and warnings",
        } and level in {"warn", "warning"}:
            findings.append({
                "severity": "warn",
                "channel": channel,
                "message": event.get("message"),
                "timestamp": event.get("timestamp"),
            })

    findings.reverse()
    return {
        "timestamp": _utc_now_iso(),
        "summary": {
            "total_events": len(events),
            "channel_counts": dict(channel_counts),
            "level_counts": dict(level_counts),
            "latest_layout_snapshot": latest_layout_snapshot,
            "latest_registry_snapshot": latest_registry_snapshot,
        },
        "findings": findings[-20:],
        "events": events[-50:],
        "log_path": payload["log_path"],
    }