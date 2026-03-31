from __future__ import annotations

import fnmatch
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SERVICE_LOG_CANDIDATES: dict[str, tuple[str, ...]] = {
    "backend": (
        "/var/log/bellforge-backend.log",
        "/var/log/bellforge.log",
        "tests/logs/smoke.log",
    ),
    "updater": (
        "/var/log/bellforge-updater.log",
        "tests/logs/smoke.log",
    ),
    "client": (
        "/var/log/bellforge-client.log",
        "tests/logs/smoke.log",
    ),
    "install-repair": (
        "/var/log/bellforge-install.log",
        "/var/log/bellforge-repair.log",
        "tests/logs/test_install.log",
        "tests/logs/test_repair.log",
    ),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_candidate(project_root: Path, candidate: str) -> Path:
    path = Path(candidate)
    if path.is_absolute():
        return path
    return project_root / candidate


def _tail_lines(path: Path, line_count: int) -> list[str]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return [line.rstrip("\n") for line in deque(handle, maxlen=line_count)]


def _find_first_existing_log(project_root: Path, patterns: tuple[str, ...]) -> Path | None:
    for pattern in patterns:
        if "*" in pattern:
            base = project_root if not Path(pattern).is_absolute() else Path("/")
            for candidate in base.rglob("*"):
                if fnmatch.fnmatch(candidate.as_posix(), pattern) and candidate.is_file():
                    return candidate
            continue

        candidate = _resolve_candidate(project_root, pattern)
        if candidate.is_file():
            return candidate
    return None


def read_logs(project_root: Path, service: str, line_count: int = 200, contains: str | None = None) -> dict[str, Any]:
    if service not in SERVICE_LOG_CANDIDATES:
        raise ValueError(f"Unsupported log service: {service}")

    line_count = max(1, min(line_count, 2000))
    log_path = _find_first_existing_log(project_root, SERVICE_LOG_CANDIDATES[service])

    if log_path is None:
        return {
            "timestamp": _utc_now(),
            "service": service,
            "log_path": None,
            "line_count": 0,
            "lines": [],
            "message": "No log file found for service.",
        }

    lines = _tail_lines(log_path, line_count)
    if contains:
        lowered = contains.lower()
        lines = [line for line in lines if lowered in line.lower()]

    return {
        "timestamp": _utc_now(),
        "service": service,
        "log_path": str(log_path),
        "line_count": len(lines),
        "lines": lines,
    }
