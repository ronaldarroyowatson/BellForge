from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.services.unified_auth import get_auth_service


def get_auth_status(project_root: Path) -> dict[str, Any]:
    _ = project_root
    return get_auth_service().auth_status()
