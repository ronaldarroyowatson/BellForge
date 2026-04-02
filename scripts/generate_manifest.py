#!/usr/bin/env python3
"""scripts/generate_manifest.py — Scan deployable files and write config/manifest.json.

Deployable files are everything under:
    - backend/
    - client/
    - updater/
    - config/ (except local-only files)

The manifest records the SHA-256 hash and byte size of each file so the Pi
updater can detect changes without downloading entire files.

Usage:
    python scripts/generate_manifest.py
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT         = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "config" / "manifest.json"
VERSION_PATH  = ROOT / "config" / "version.json"

# Directories whose contents are pushed to every Pi.
DEPLOYABLE_DIRS: list[Path] = [
    ROOT / "backend",
    ROOT / "client",
    ROOT / "updater",
    ROOT / "config",
]

# File extensions to skip (compiled artefacts, editor files, etc.)
SKIP_SUFFIXES = {".pyc", ".pyo", ".DS_Store", ".swp", ".swo"}
SKIP_NAMES    = {"__pycache__", ".git", ".mypy_cache", ".ruff_cache"}
SKIP_RELATIVE = {
    "config/manifest.json",   # Prevent recursive self-hash churn.
    "config/settings.json",   # Device-local secrets and options.
    "config/client.env",      # Device-local client endpoint override.
}

TEXT_SUFFIXES = {".py", ".html", ".js", ".json", ".service", ".env", ".md", ".txt", ".css", ".sh"}


def canonical_file_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix.lower() in TEXT_SUFFIXES or path.name in {"Dockerfile", ".env"}:
        return data.replace(b"\r\n", b"\n")
    return data


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    data = canonical_file_bytes(path)
    for index in range(0, len(data), 65536):
        h.update(data[index:index + 65536])
    return h.hexdigest()


def collect_files() -> dict[str, dict]:
    """Walk deployable dirs and return a manifest file entry for each file."""
    entries: dict[str, dict] = {}

    for base in DEPLOYABLE_DIRS:
        if not base.is_dir():
            print(f"  WARNING: deployable dir not found, skipping: {base}")
            continue

        for path in sorted(base.rglob("*")):
            # Skip directories and undesirable names/extensions
            if not path.is_file():
                continue
            if path.suffix in SKIP_SUFFIXES:
                continue
            if any(part in SKIP_NAMES for part in path.parts):
                continue

            rel = path.relative_to(ROOT).as_posix()
            if rel in SKIP_RELATIVE:
                continue
            canonical_bytes = canonical_file_bytes(path)
            entries[rel] = {
                "sha256": sha256_file(path),
                "size":   len(canonical_bytes),
            }
            print(f"  {rel}")

    return entries


def read_version() -> str:
    if not VERSION_PATH.is_file():
        return "0.0.0"
    try:
        return json.loads(VERSION_PATH.read_text())["version"]
    except (KeyError, json.JSONDecodeError):
        return "0.0.0"


def main() -> None:
    version = read_version()
    print(f"Generating manifest for v{version}…")
    print(f"Scanning deployable files:")

    files = collect_files()

    manifest = {
        "version":      version,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files":        files,
    }

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nmanifest.json written — {len(files)} file(s) indexed.")


if __name__ == "__main__":
    main()
