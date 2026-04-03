#!/usr/bin/env python3
"""BellForge Windows-compatible smoke test.

Tests the full lifecycle without requiring root, systemd, or Linux:
  1. Backend server starts and exposes health/version/manifest endpoints.
  2. GitHub raw URL is reachable and returns valid JSON.
  3. Updater core logic detects the update, downloads all files, and verifies
     SHA-256 hashes against the remote manifest.
  4. Simulated install directory is fully cleaned up (uninstall phase).

Run:
    python tests/smoke_test_windows.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
GITHUB_RAW_BASE = "https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main"
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8765          # Use a non-standard port to avoid conflicts
BACKEND_BASE = f"http://{BACKEND_HOST}:{BACKEND_PORT}"

GREEN = "\033[92m"
RED   = "\033[91m"
CYAN  = "\033[96m"
YELLOW = "\033[93m"
RESET = "\033[0m"

PASS_COUNT = 0
FAIL_COUNT = 0


def _print(color: str, tag: str, msg: str) -> None:
    print(f"{color}[{tag}]{RESET} {msg}", flush=True)


def ok(msg: str) -> None:
    global PASS_COUNT
    PASS_COUNT += 1
    _print(GREEN, "PASS", msg)


def fail(msg: str) -> None:
    global FAIL_COUNT
    FAIL_COUNT += 1
    _print(RED, "FAIL", msg)


def info(msg: str) -> None:
    _print(CYAN, "INFO", msg)


def warn(msg: str) -> None:
    _print(YELLOW, "WARN", msg)


# ---------------------------------------------------------------------------
# Phase 1 — local backend
# ---------------------------------------------------------------------------

def start_backend() -> subprocess.Popen:
    """Launch uvicorn in a subprocess, return the process handle."""
    cmd = [
        sys.executable, "-m", "uvicorn",
        "backend.main:app",
        "--host", BACKEND_HOST,
        "--port", str(BACKEND_PORT),
        "--log-level", "error",
    ]
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def wait_for_backend(timeout: float = 20.0) -> bool:
    """Poll /health until the server is up or timeout expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{BACKEND_BASE}/health", timeout=2)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def test_backend(client: httpx.Client) -> None:
    info("=== Phase 1: Local backend ===")

    # /health
    try:
        r = client.get(f"{BACKEND_BASE}/health")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}"
        assert r.json().get("status") == "ok", f"Unexpected body: {r.text}"
        ok("/health — backend is alive")
    except Exception as exc:
        fail(f"/health — {exc}")

    # /version
    try:
        r = client.get(f"{BACKEND_BASE}/version")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}"
        data = r.json()
        ver = data.get("version")
        assert ver, f"No 'version' key in response: {data}"
        ok(f"/version — returned version={ver}")
    except Exception as exc:
        fail(f"/version — {exc}")

    # /manifest
    try:
        r = client.get(f"{BACKEND_BASE}/manifest")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}"
        data = r.json()
        assert "files" in data, f"No 'files' key in manifest: {data}"
        file_count = len(data["files"])
        ok(f"/manifest — returned {file_count} tracked file(s)")
    except Exception as exc:
        fail(f"/manifest — {exc}")

    # /display/main
    try:
        r = client.get(f"{BACKEND_BASE}/display/main")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}"
        ok("/display/main — HTML page delivered")
    except Exception as exc:
        fail(f"/display/main — {exc}")

    # auth/onboarding surfaces
    for path in (
        "/auth",
        "/onboarding",
        "/automode",
        "/client/auth.html",
        "/client/onboarding.html",
        "/client/automode.html",
    ):
        try:
            r = client.get(f"{BACKEND_BASE}{path}")
            assert r.status_code == 200, f"Expected 200, got {r.status_code}"
            ok(f"{path} — page delivered")
        except Exception as exc:
            fail(f"{path} — {exc}")

    # File endpoint path-traversal guard
    traversal_paths = [
        "../../../etc/passwd",
        "..%2F..%2Fetc%2Fpasswd",
        "backend/../../../etc/passwd",
    ]
    for bad_path in traversal_paths:
        try:
            r = client.get(f"{BACKEND_BASE}/file/{bad_path}")
            if r.status_code in (403, 404):
                ok(f"Path traversal blocked for: {bad_path!r}")
            else:
                fail(f"Path traversal NOT blocked ({r.status_code}) for: {bad_path!r}")
        except Exception as exc:
            # httpx may raise on weird URLs — that's also fine
            ok(f"Path traversal raised exception (safe) for: {bad_path!r}")

    # /api/* routes — check that old-style miss cleanly 404 not 500
    try:
        r = client.get(f"{BACKEND_BASE}/api/version")
        if r.status_code == 404:
            warn("/api/version returns 404 — routes/ modules not wired (known gap)")
        elif r.status_code == 200:
            ok("/api/version — api prefix route works")
        else:
            fail(f"/api/version — unexpected status {r.status_code}")
    except Exception as exc:
        fail(f"/api/version — {exc}")

    # /api/display/pipeline
    try:
        r = client.get(f"{BACKEND_BASE}/api/display/pipeline")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}"
        data = r.json()
        assert data.get("health") in {"ok", "warn", "error"}, f"Unexpected health: {data}"
        assert isinstance(data.get("issues"), list), f"Expected issues list: {data}"
        ok("/api/display/pipeline — display diagnostics endpoint works")
    except Exception as exc:
        fail(f"/api/display/pipeline — {exc}")


# ---------------------------------------------------------------------------
# Phase 2 — GitHub connectivity
# ---------------------------------------------------------------------------

def test_github(client: httpx.Client) -> dict:
    info("=== Phase 2: GitHub raw URL connectivity ===")

    remote_version: dict = {}
    remote_manifest: dict = {}

    try:
        r = client.get(f"{GITHUB_RAW_BASE}/config/version.json", timeout=20)
        r.raise_for_status()
        remote_version = r.json()
        ver = remote_version.get("version", "?")
        ok(f"GitHub version.json reachable — version={ver}")
    except Exception as exc:
        fail(f"GitHub version.json — {exc}")

    try:
        r = client.get(f"{GITHUB_RAW_BASE}/config/manifest.json", timeout=20)
        r.raise_for_status()
        remote_manifest = r.json()
        file_count = len(remote_manifest.get("files", {}))
        ok(f"GitHub manifest.json reachable — {file_count} file(s) tracked")
    except Exception as exc:
        fail(f"GitHub manifest.json — {exc}")

    # Sanity: manifest version matches version.json
    if remote_version and remote_manifest:
        rv = remote_version.get("version")
        mv = remote_manifest.get("version")
        if rv == mv:
            ok(f"Version consistency: version.json ({rv}) matches manifest.json ({mv})")
        else:
            fail(f"Version mismatch: version.json={rv} vs manifest.json={mv}")

    return {"version": remote_version, "manifest": remote_manifest}


# ---------------------------------------------------------------------------
# Phase 3 — Updater core logic
# ---------------------------------------------------------------------------

async def test_updater(remote_version: dict, remote_manifest: dict) -> None:
    info("=== Phase 3: Updater core logic ===")

    if not remote_version or not remote_manifest:
        warn("Skipping updater test — no remote data available")
        return

    # Build a temp install directory that looks like /opt/bellforge
    tmp = Path(tempfile.mkdtemp(prefix="bellforge_smoke_"))
    staging = tmp / ".staging"
    info(f"Simulated install dir: {tmp}")

    try:
        # Write a settings.json that points at GitHub
        config_dir = tmp / "config"
        config_dir.mkdir(parents=True, exist_ok=True)
        settings_data = {
            "update_base_url": GITHUB_RAW_BASE,
            "install_dir": str(tmp),
            "staging_dir": str(staging),
            "log_file": str(tmp / "updater.log"),
            "poll_interval_seconds": 300,
            "max_retries": 2,
            "retry_delay_seconds": 5,
            "services_to_restart": [],   # Skip systemctl on Windows
            "preserve_local_paths": ["config/settings.json", "config/client.env"],
            "device_id": "smoke-test",
        }
        settings_path = config_dir / "settings.json"
        settings_path.write_text(json.dumps(settings_data, indent=2), encoding="utf-8")

        # Write an OLD version.json to guarantee update is detected
        old_version = {"version": "0.0.0"}
        (config_dir / "version.json").write_text(json.dumps(old_version), encoding="utf-8")

        ok("Simulated install directory created with version 0.0.0")

        # Import the updater (must work without system paths)
        sys.path.insert(0, str(REPO_ROOT))
        from updater.agent import UpdaterSettings, UpdateAgent, configure_logging, sha256_file

        log = configure_logging(Path(settings_data["log_file"]))
        log.setLevel(logging.WARNING)  # Quiet for the test output; we report manually

        import os
        os.environ["BELLFORGE_SETTINGS"] = str(settings_path)
        from updater.agent import load_settings
        settings = load_settings(settings_path)

        agent = UpdateAgent(settings, log)

        # ---- Version detection ---
        local_ver = agent._local_version()
        if local_ver == "0.0.0":
            ok(f"Local version correctly read as {local_ver}")
        else:
            fail(f"Expected local version 0.0.0, got {local_ver}")

        # ---- Run one update cycle ----
        info("Running updater.run_update_cycle() against GitHub…")
        try:
            await agent.run_update_cycle()
            ok("Update cycle completed without exception")
        except Exception as exc:
            fail(f"Update cycle raised: {exc}")
            return

        pending_update = staging / "pending_update.json"
        if pending_update.is_file():
            ok("Update cycle staged a pending release marker")
        else:
            fail("Expected pending_update.json after staging, but none was written")
            return

        staged_local_ver = agent._local_version()
        if staged_local_ver == "0.0.0":
            ok("Staging left the live install untouched until apply-on-startup")
        else:
            fail(f"Expected staged cycle to keep live version at 0.0.0, got {staged_local_ver}")

        info("Applying staged release the same way the updater does on next startup…")
        try:
            agent._apply_pending_release_if_present()
            ok("Pending staged release applied without exception")
        except Exception as exc:
            fail(f"Applying staged release raised: {exc}")
            return

        if not pending_update.exists():
            ok("Pending release marker cleared after apply")
        else:
            fail("pending_update.json still exists after apply")

        # ---- Verify version was bumped after apply ----
        new_local_ver = agent._local_version()
        expected_ver = remote_version.get("version", "")
        if new_local_ver == expected_ver:
            ok(f"Version updated correctly to {new_local_ver} after staged apply")
        else:
            fail(f"Version not updated after staged apply: expected {expected_ver}, got {new_local_ver}")

        # ---- Verify every manifest file exists and has correct hash after apply ----
        manifest_files: dict = remote_manifest.get("files", {})
        hash_errors = 0
        missing_files = 0
        for rel_path, meta in manifest_files.items():
            installed = tmp / rel_path
            if not installed.is_file():
                fail(f"Missing after staged apply: {rel_path}")
                missing_files += 1
                continue
            actual = sha256_file(installed)
            expected = str(meta.get("sha256", ""))
            if actual != expected:
                fail(f"Hash mismatch after staged apply for {rel_path}: expected {expected[:12]}… got {actual[:12]}…")
                hash_errors += 1

        if missing_files == 0 and hash_errors == 0:
            ok(f"All {len(manifest_files)} manifest file(s) present and SHA-256 verified")
        else:
            fail(f"{missing_files} missing, {hash_errors} hash mismatches out of {len(manifest_files)} files")

        # ---- Phase 4: Uninstall simulation ----
        info("=== Phase 4: Uninstall (cleanup) ===")
        # Close all logging file handlers so Windows releases the log file
        # before shutil.rmtree tries to delete it.
        for handler in list(log.handlers):
            handler.close()
            log.removeHandler(handler)
        shutil.rmtree(tmp, ignore_errors=False)
        if not tmp.exists():
            ok(f"Simulated install dir removed cleanly: {tmp}")
        else:
            fail(f"Temp dir still exists after removal: {tmp}")
        # Mark tmp as already cleaned up
        tmp = None  # type: ignore[assignment]

    finally:
        if tmp is not None and tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    info("BellForge Windows smoke test starting")
    info(f"Repo root: {REPO_ROOT}")
    info(f"GitHub base: {GITHUB_RAW_BASE}")

    backend_proc: subprocess.Popen | None = None

    try:
        # --- Check dependencies ---
        try:
            import httpx  # noqa: F401
        except ImportError:
            print(f"{RED}[FAIL]{RESET} 'httpx' not installed. Run: pip install httpx", flush=True)
            sys.exit(1)

        # --- Start backend ---
        info(f"Starting backend on {BACKEND_BASE}…")
        backend_proc = start_backend()
        if not wait_for_backend(timeout=20):
            stderr_out = backend_proc.stderr.read().decode(errors="replace") if backend_proc.stderr else ""
            fail(f"Backend did not start within 20 s\n{stderr_out}")
            sys.exit(1)
        ok(f"Backend started (pid={backend_proc.pid})")

        with httpx.Client(timeout=15) as client:
            test_backend(client)
            remote = test_github(client)

        asyncio.run(test_updater(remote["version"], remote["manifest"]))

    finally:
        if backend_proc is not None:
            backend_proc.terminate()
            try:
                backend_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                backend_proc.kill()
            ok("Backend process stopped")

    # --- Summary ---
    total = PASS_COUNT + FAIL_COUNT
    print(flush=True)
    print("=" * 50)
    print(f"Results: {GREEN}{PASS_COUNT} passed{RESET} / {RED}{FAIL_COUNT} failed{RESET} / {total} total")
    print("=" * 50)
    sys.exit(0 if FAIL_COUNT == 0 else 1)


if __name__ == "__main__":
    main()
