from __future__ import annotations

import argparse
import hashlib
import subprocess
from pathlib import Path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 64)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def ensure_requirements_synced(venv_python: Path, requirements: Path, stamp_path: Path) -> bool:
    """Ensure venv packages match requirements file content.

    Returns True when a pip install was executed, else False.
    """
    requirements_hash = _sha256_file(requirements)
    current_hash = stamp_path.read_text(encoding="utf-8").strip() if stamp_path.exists() else ""
    if current_hash == requirements_hash:
        return False

    cmd = [
        str(venv_python),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        str(requirements),
    ]
    subprocess.run(cmd, check=True)
    stamp_path.parent.mkdir(parents=True, exist_ok=True)
    stamp_path.write_text(requirements_hash, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="BellForge backend runtime dependency guard")
    parser.add_argument("--venv-python", required=True)
    parser.add_argument("--requirements", required=True)
    parser.add_argument("--stamp", required=True)
    args = parser.parse_args()

    venv_python = Path(args.venv_python)
    requirements = Path(args.requirements)
    stamp = Path(args.stamp)
    ensure_requirements_synced(venv_python=venv_python, requirements=requirements, stamp_path=stamp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())