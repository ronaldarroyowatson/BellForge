"""Schedule endpoint — serves today's bell schedule to Pi clients."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()

_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "config"


@router.get("/schedule", summary="Return the current bell schedule")
async def get_schedule() -> JSONResponse:
    path = _CONFIG_DIR / "schedule.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="schedule.json not found.")
    return JSONResponse(content=json.loads(path.read_text()))
