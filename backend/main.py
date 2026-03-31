#!/usr/bin/env python3
"""BellForge backend starter.

Provides update metadata endpoints and simple display payload hosting.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routes import broadcast, diagnostics, schedule, update

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = PROJECT_ROOT / "config"
PAYLOAD_DIR = PROJECT_ROOT / "config" / "payloads"

# Only allow selective downloads from deployable roots.
ALLOWED_ROOTS: tuple[Path, ...] = (
    PROJECT_ROOT / "backend",
    PROJECT_ROOT / "client",
    PROJECT_ROOT / "updater",
    PROJECT_ROOT / "config",
)

app = FastAPI(
    title="BellForge Backend",
    description="Version, manifest, and display payload API for BellForge devices.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(update.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
app.include_router(broadcast.router, prefix="/api")
app.include_router(diagnostics.router, prefix="/api")
app.mount("/client", StaticFiles(directory=PROJECT_ROOT / "client"), name="client")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Not found: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def _resolve_safe_path(rel_path: str) -> Path:
    candidate = (PROJECT_ROOT / rel_path.lstrip("/")).resolve()
    if not any(str(candidate).startswith(str(root)) for root in ALLOWED_ROOTS):
        raise HTTPException(status_code=403, detail="Access denied")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {rel_path}")
    return candidate


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version")
async def version() -> JSONResponse:
    return JSONResponse(_read_json(CONFIG_DIR / "version.json"))


@app.get("/manifest")
async def manifest() -> JSONResponse:
    return JSONResponse(_read_json(CONFIG_DIR / "manifest.json"))


@app.get("/file/{file_path:path}")
async def file_download(file_path: str) -> FileResponse:
    return FileResponse(_resolve_safe_path(file_path))


@app.get("/display/{display_id}")
async def display(display_id: str) -> HTMLResponse:
    html = f"""<!doctype html>
<html lang=\"en\"> 
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />
  <title>BellForge Display {display_id}</title>
  <style>
    html,body {{ margin:0; height:100%; background:#111; color:#fff; font-family:Segoe UI,sans-serif; }}
    #payload {{ width:100%; height:100%; }}
  </style>
</head>
<body>
  <div id=\"payload\">Loading...</div>
  <script>
    const target = document.getElementById('payload');
    async function refresh() {{
      try {{
        const resp = await fetch('/display/{display_id}/payload', {{ cache: 'no-store' }});
        if (!resp.ok) throw new Error(`HTTP ${{resp.status}}`);
        const data = await resp.json();
        target.innerHTML = data.html;
      }} catch (err) {{
        target.innerHTML = '<div style="padding:2rem">Display offline</div>';
      }}
    }}
    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>"""
    return HTMLResponse(content=html)


@app.get("/display/{display_id}/payload")
async def display_payload(display_id: str) -> JSONResponse:
    payload_file = PAYLOAD_DIR / f"{display_id}.html"
    if not payload_file.is_file():
        payload_file = PAYLOAD_DIR / "default.html"

    html = payload_file.read_text(encoding="utf-8") if payload_file.is_file() else "<h1>BellForge</h1>"
    return JSONResponse({"display_id": display_id, "html": html})


@app.get("/status", response_class=FileResponse)
async def status_page() -> FileResponse:
    page = PROJECT_ROOT / "client" / "status.html"
    if not page.is_file():
        raise HTTPException(status_code=404, detail="status.html not found")
    return FileResponse(page)


@app.get("/settings", response_class=FileResponse)
async def settings_page() -> FileResponse:
    page = PROJECT_ROOT / "client" / "settings.html"
    if not page.is_file():
        raise HTTPException(status_code=404, detail="settings.html not found")
    return FileResponse(page)
