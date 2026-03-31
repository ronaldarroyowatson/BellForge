#!/usr/bin/env python3
"""scripts/bump_version.py — Increment version.json and regenerate manifest.json.

Usage:
    python scripts/bump_version.py          # bump patch  (1.2.3 → 1.2.4)
    python scripts/bump_version.py minor --allow-minor
    python scripts/bump_version.py major --allow-major
    python scripts/bump_version.py 2.5.0    # set exact version

Called by the GitHub Actions release workflow on every push to main.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Project root is one directory above this script.
ROOT        = Path(__file__).resolve().parent.parent
VERSION_PATH = ROOT / "config" / "version.json"


def read_version() -> dict:
    if not VERSION_PATH.is_file():
        return {"version": "0.0.0", "released_at": "", "min_updater_version": "1.0.0", "reboot_required": False, "notes": ""}
    with open(VERSION_PATH) as f:
        return json.load(f)


def parse_semver(v: str) -> tuple[int, int, int]:
    parts = v.split(".")
    if len(parts) != 3:
        raise ValueError(f"Invalid semver: {v!r}")
    return int(parts[0]), int(parts[1]), int(parts[2])


def bump(current: str, part: str) -> str:
    """Return a new semver string with the requested part incremented."""
    major, minor, patch = parse_semver(current)
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    # Default: patch
    return f"{major}.{minor}.{patch + 1}"


def write_version(data: dict) -> None:
    with open(VERSION_PATH, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  version.json updated → {data['version']}")


def call_generate_manifest() -> None:
    """Invoke the manifest generator as a subprocess so it runs fresh."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate_manifest.py")],
        cwd=ROOT,
    )
    if result.returncode != 0:
        print("ERROR: manifest generation failed.", file=sys.stderr)
        sys.exit(result.returncode)


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else "patch"
    allow_minor = "--allow-minor" in sys.argv
    allow_major = "--allow-major" in sys.argv

    data = read_version()
    old_version = data["version"]

    # Determine new version
    if arg == "major" and not allow_major:
        print("ERROR: major bump requires --allow-major", file=sys.stderr)
        sys.exit(2)

    if arg == "minor" and not allow_minor:
        print("ERROR: minor bump requires --allow-minor", file=sys.stderr)
        sys.exit(2)

    if arg in ("major", "minor", "patch"):
        new_version = bump(old_version, arg)
    else:
        # Treat as explicit version string
        parse_semver(arg)  # validate format
        new_version = arg

    data["version"]     = new_version
    data["released_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"Bumping version: {old_version} → {new_version}")
    write_version(data)

    print("Regenerating manifest…")
    call_generate_manifest()

    print(f"\nDone. Ready to commit and push.")
    print(f"  Suggested commit message:")
    print(f'    chore: release v{new_version} [skip ci]')


if __name__ == "__main__":
    main()
