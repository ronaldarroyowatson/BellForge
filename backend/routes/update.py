"""Update distribution endpoints.

Serves version.json, manifest.json, and individual deployable files to Pi clients.
All file-serving paths are validated against an allowlist to prevent path traversal.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter()

# Project root is three levels up: routes/ → backend/ → project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_CONFIG_DIR    = _PROJECT_ROOT / "config"

# Only files under these roots may be downloaded by Pi clients.
_ALLOWED_ROOTS: tuple[Path, ...] = (
    _PROJECT_ROOT / "client",
    _PROJECT_ROOT / "updater",
    _PROJECT_ROOT / "config",
)


def _resolve_safe(rel_path: str) -> Path:
    """Resolve *rel_path* relative to project root and enforce allowlist.

    Raises:
        HTTPException 403 — if the resolved path escapes the allowed roots.
        HTTPException 404 — if the file does not exist.
    """
    candidate = (_PROJECT_ROOT / rel_path.lstrip("/")).resolve()

    if not any(str(candidate).startswith(str(root)) for root in _ALLOWED_ROOTS):
        raise HTTPException(status_code=403, detail="Access denied.")

    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Not found: {rel_path}")

    return candidate


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/version", summary="Return the current version manifest")
async def get_version() -> JSONResponse:
    path = _CONFIG_DIR / "version.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="version.json not found.")
    return JSONResponse(content=json.loads(path.read_text()))


@router.get("/manifest", summary="Return the file integrity manifest")
async def get_manifest() -> JSONResponse:
    path = _CONFIG_DIR / "manifest.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="manifest.json not found.")
    return JSONResponse(content=json.loads(path.read_text()))


@router.get("/files/{file_path:path}", summary="Download an individual deployable file")
async def get_file(file_path: str) -> FileResponse:
    safe = _resolve_safe(file_path)
    return FileResponse(safe)
