#!/usr/bin/env python3
"""BellForge GitHub updater agent.

This agent polls GitHub (or any static HTTP host) for:
- config/version.json
- config/manifest.json

It downloads only changed files, verifies SHA-256 integrity, prepares a shadow
release tree in /opt/bellforge/.staging, and swaps managed roots with rollback
protection so the Pi is never left half-updated.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

SETTINGS_PATH = Path(os.environ.get("BELLFORGE_SETTINGS", "/opt/bellforge/config/settings.json"))


@dataclass(slots=True)
class UpdaterSettings:
    update_base_url: str
    install_dir: Path
    staging_dir: Path
    log_file: Path
    poll_interval_seconds: int
    max_retries: int
    retry_delay_seconds: int
    trigger_port: int
    auto_reboot_after_update: bool
    services_to_restart: list[str]
    preserve_local_paths: set[str]


def load_settings(path: Path) -> UpdaterSettings:
    if not path.is_file():
        raise FileNotFoundError(f"settings.json not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8"))
    install_dir = Path(data.get("install_dir", "/opt/bellforge"))

    return UpdaterSettings(
        update_base_url=str(data.get("update_base_url", "")).rstrip("/"),
        install_dir=install_dir,
        staging_dir=Path(data.get("staging_dir", str(install_dir / ".staging"))),
        log_file=Path(data.get("log_file", "/var/log/bellforge-updater.log")),
        poll_interval_seconds=int(data.get("poll_interval_seconds", 300)),
        max_retries=int(data.get("max_retries", 3)),
        retry_delay_seconds=int(data.get("retry_delay_seconds", 20)),
        trigger_port=int(data.get("trigger_port", 8765)),
        auto_reboot_after_update=bool(data.get("auto_reboot_after_update", False)),
        services_to_restart=list(data.get("services_to_restart", ["bellforge-backend.service", "bellforge-client.service"])),
        preserve_local_paths=set(data.get("preserve_local_paths", ["config/settings.json", "config/client.env"])),
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def configure_logging(log_file: Path) -> logging.Logger:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("bellforge.updater")
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return logger

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    return logger


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_version(version_text: str) -> tuple[int, int, int]:
    try:
        a, b, c = version_text.split(".")
        return int(a), int(b), int(c)
    except (ValueError, AttributeError):
        return (0, 0, 0)


class UpdateAgent:
    def __init__(self, settings: UpdaterSettings, logger: logging.Logger) -> None:
        if not settings.update_base_url:
            raise ValueError("update_base_url cannot be empty")

        self.settings = settings
        self.log = logger
        self.install_dir = settings.install_dir
        self.staging_dir = settings.staging_dir
        # Gate that prevents two update cycles from running concurrently.
        # This matters when both the poll loop and a broadcast /trigger-update
        # request fire at the same time: without the lock the two coroutines
        # would interleave _atomic_swap_roots and corrupt the install tree.
        self._cycle_lock: asyncio.Lock = asyncio.Lock()
        self._trigger_server: asyncio.AbstractServer | None = None
        self._trigger_task: asyncio.Task[None] | None = None

    def _staging_file(self, name: str) -> Path:
        return self.staging_dir / name

    def _write_json_atomic(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _write_state(self, staging_in_progress: bool, reboot_pending: bool = False) -> None:
        self._write_json_atomic(
            self._staging_file("state.json"),
            {
                "timestamp": utc_now(),
                "staging_in_progress": staging_in_progress,
                "reboot_pending": reboot_pending,
            },
        )

    def _write_progress(self, bytes_downloaded: int, bytes_total: int) -> None:
        percent = 0.0
        if bytes_total > 0:
            percent = round((bytes_downloaded / bytes_total) * 100.0, 2)
        self._write_json_atomic(
            self._staging_file("download_progress.json"),
            {
                "timestamp": utc_now(),
                "bytes_downloaded": int(bytes_downloaded),
                "bytes_total": int(bytes_total),
                "percent": percent,
            },
        )

    def _write_last_result(self, result: str, message: str, reboot_pending: bool = False) -> None:
        self._write_json_atomic(
            self._staging_file("last_update_result.json"),
            {
                "timestamp": utc_now(),
                "last_update_attempt": utc_now(),
                "result": result,
                "message": message,
                "reboot_pending": reboot_pending,
            },
        )

    def _local_version(self) -> str:
        version_path = self.install_dir / "config" / "version.json"
        if not version_path.is_file():
            return "0.0.0"
        try:
            return json.loads(version_path.read_text(encoding="utf-8")).get("version", "0.0.0")
        except json.JSONDecodeError:
            return "0.0.0"

    async def _fetch_json(self, client: httpx.AsyncClient, relative_path: str) -> dict[str, Any]:
        url = f"{self.settings.update_base_url}/{relative_path.lstrip('/')}"
        response = await client.get(url, timeout=45.0)
        response.raise_for_status()
        return response.json()

    async def _download_file(self, client: httpx.AsyncClient, relative_path: str, destination: Path) -> None:
        url = f"{self.settings.update_base_url}/{relative_path}"
        destination.parent.mkdir(parents=True, exist_ok=True)

        async with client.stream("GET", url, timeout=120.0) as response:
            response.raise_for_status()
            with open(destination, "wb") as handle:
                async for chunk in response.aiter_bytes(65536):
                    handle.write(chunk)

    def _changed_files(self, manifest_files: dict[str, Any]) -> list[str]:
        changed: list[str] = []
        for rel_path, metadata in manifest_files.items():
            current = self.install_dir / rel_path
            expected_hash = str(metadata.get("sha256", ""))
            if not current.is_file():
                changed.append(rel_path)
                continue
            if sha256_file(current) != expected_hash:
                changed.append(rel_path)
        return changed

    def _managed_roots(self, manifest_files: dict[str, Any]) -> list[str]:
        roots = sorted({path.split("/", 1)[0] for path in manifest_files})
        return [root for root in roots if root]

    async def _stage_downloads(
        self,
        client: httpx.AsyncClient,
        release_dir: Path,
        changed_files: list[str],
        manifest_files: dict[str, Any],
    ) -> Path:
        files_dir = release_dir / "files"
        files_dir.mkdir(parents=True, exist_ok=True)

        bytes_total = sum(int(manifest_files[path].get("size", 0)) for path in changed_files)
        bytes_downloaded = 0
        self._write_progress(bytes_downloaded, bytes_total)

        for rel_path in changed_files:
            destination = files_dir / rel_path
            self.log.info(f"Downloading {rel_path}")
            await self._download_file(client, rel_path, destination)

            expected_hash = str(manifest_files[rel_path].get("sha256", ""))
            actual_hash = sha256_file(destination)
            if actual_hash != expected_hash:
                raise RuntimeError(f"Hash mismatch after download: {rel_path}")

            bytes_downloaded += destination.stat().st_size
            self._write_progress(bytes_downloaded, bytes_total)

        return files_dir

    def _build_shadow_tree(
        self,
        release_dir: Path,
        files_dir: Path,
        manifest_files: dict[str, Any],
        managed_roots: list[str],
    ) -> Path:
        shadow_dir = release_dir / "shadow"
        if shadow_dir.exists():
            shutil.rmtree(shadow_dir)
        shadow_dir.mkdir(parents=True, exist_ok=True)

        for root in managed_roots:
            live_root = self.install_dir / root
            shadow_root = shadow_dir / root
            if live_root.exists():
                shutil.copytree(live_root, shadow_root, dirs_exist_ok=True)
            else:
                shadow_root.mkdir(parents=True, exist_ok=True)

        # Overlay changed files onto the shadow release tree.
        for rel_path in manifest_files:
            changed_path = files_dir / rel_path
            if changed_path.is_file():
                dest = shadow_dir / rel_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(changed_path, dest)

        # Remove stale files not present in manifest, except preserved local files.
        tracked_paths = set(manifest_files.keys())
        for root in managed_roots:
            shadow_root = shadow_dir / root
            if not shadow_root.exists():
                continue
            for path in shadow_root.rglob("*"):
                if not path.is_file():
                    continue
                rel = path.relative_to(shadow_dir).as_posix()
                if rel in self.settings.preserve_local_paths:
                    continue
                if rel not in tracked_paths:
                    path.unlink()

        return shadow_dir

    def _atomic_swap_roots(self, shadow_dir: Path, managed_roots: list[str]) -> None:
        swap_dir = self.staging_dir / "swap"
        backup_dir = swap_dir / "backup"
        backup_dir.mkdir(parents=True, exist_ok=True)

        swapped: list[str] = []
        try:
            for root in managed_roots:
                live_root = self.install_dir / root
                shadow_root = shadow_dir / root
                backup_root = backup_dir / root

                if backup_root.exists():
                    shutil.rmtree(backup_root)

                if live_root.exists():
                    live_root.rename(backup_root)

                if shadow_root.exists():
                    shadow_root.rename(live_root)
                else:
                    live_root.mkdir(parents=True, exist_ok=True)

                swapped.append(root)

        except Exception as exc:
            self.log.error(f"Swap failed, rolling back: {exc}")

            for root in reversed(swapped):
                live_root = self.install_dir / root
                backup_root = backup_dir / root
                if live_root.exists():
                    shutil.rmtree(live_root)
                if backup_root.exists():
                    backup_root.rename(live_root)

            raise

    def _write_tracking_files(self, manifest: dict[str, Any]) -> None:
        """Persist the remote manifest so the next cycle can detect drift.

        version.json is intentionally NOT written here — it was already
        downloaded verbatim and placed by the atomic swap, so re-serialising
        it with json.dumps would produce byte-for-byte-different content and
        break SHA-256 verification on the next cycle.
        """
        config_dir = self.install_dir / "config"
        config_dir.mkdir(parents=True, exist_ok=True)

        # Write atomically via a sibling temp file + os.replace() so the
        # backend /manifest endpoint never reads a partially-written file.
        manifest_path = config_dir / "manifest.json"
        tmp_path = manifest_path.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        tmp_path.replace(manifest_path)

    def _post_update_action(self, remote_version: dict[str, Any]) -> bool:
        should_reboot = bool(remote_version.get("reboot_required", False)) or self.settings.auto_reboot_after_update
        if should_reboot:
            self.log.info("Reboot requested by update policy. Rebooting now.")
            subprocess.run(["/sbin/reboot"], check=False)
            return True

        for service_name in self.settings.services_to_restart:
            self.log.info(f"Restarting service: {service_name}")
            result = subprocess.run(["systemctl", "restart", service_name], capture_output=True, text=True)
            if result.returncode != 0:
                self.log.warning(f"Failed to restart {service_name}: {result.stderr.strip()}")
        return False

    async def _handle_trigger_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            first_line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            request_line = first_line.decode("utf-8", errors="replace").strip()

            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                if line in (b"\r\n", b"\n", b""):
                    break

            if request_line.startswith("POST /trigger-update"):
                asyncio.create_task(self.run_update_cycle())
                body = b'{"status":"accepted"}\n'
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n".encode("ascii")
                    + b"Connection: close\r\n\r\n"
                    + body
                )
            else:
                body = b'{"error":"not found"}\n'
                writer.write(
                    b"HTTP/1.1 404 Not Found\r\n"
                    b"Content-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n".encode("ascii")
                    + b"Connection: close\r\n\r\n"
                    + body
                )

            await writer.drain()
        except Exception as exc:
            self.log.warning(f"Trigger listener error: {exc}")
        finally:
            writer.close()
            await writer.wait_closed()

    async def _ensure_trigger_listener(self) -> None:
        if self._trigger_server is not None:
            return
        self._trigger_server = await asyncio.start_server(
            self._handle_trigger_connection,
            host="0.0.0.0",
            port=self.settings.trigger_port,
        )
        self.log.info(f"Trigger listener started on 0.0.0.0:{self.settings.trigger_port}")
        self._trigger_task = asyncio.create_task(self._trigger_server.serve_forever())

    async def run_update_cycle(self) -> None:
        # Fast, non-blocking guard: if a cycle is already in flight (e.g. a
        # broadcast trigger arrived while the scheduler was mid-swap) skip
        # rather than queue up a second concurrent run.
        if self._cycle_lock.locked():
            self.log.info("Update cycle already in progress; skipping concurrent trigger.")
            return
        async with self._cycle_lock:
            await self._run_update_cycle_locked()

    async def _run_update_cycle_locked(self) -> None:
        self._write_state(staging_in_progress=True, reboot_pending=False)
        async with httpx.AsyncClient() as client:
            remote_version = await self._fetch_json(client, "config/version.json")
            remote_manifest = await self._fetch_json(client, "config/manifest.json")

            local_version = self._local_version()
            remote_version_text = str(remote_version.get("version", "0.0.0"))
            self.log.info(f"Version check local={local_version} remote={remote_version_text}")

            manifest_files = dict(remote_manifest.get("files", {}))
            if not manifest_files:
                self.log.warning("Remote manifest has no files. Skipping cycle.")
                return

            changed_files = self._changed_files(manifest_files)
            has_newer_version = parse_version(remote_version_text) > parse_version(local_version)

            if not changed_files and not has_newer_version:
                self.log.info("No changes detected.")
                self._write_state(staging_in_progress=False, reboot_pending=False)
                self._write_last_result("no-change", "No file or version changes detected.")
                return

            managed_roots = self._managed_roots(manifest_files)
            release_dir = self.staging_dir / "releases" / remote_version_text
            if release_dir.exists():
                shutil.rmtree(release_dir)
            release_dir.mkdir(parents=True, exist_ok=True)

            self.log.info(f"Preparing release {remote_version_text} with {len(changed_files)} changed file(s).")
            files_dir = await self._stage_downloads(client, release_dir, changed_files, manifest_files)
            shadow_dir = self._build_shadow_tree(release_dir, files_dir, manifest_files, managed_roots)

            self._atomic_swap_roots(shadow_dir, managed_roots)
            self._write_tracking_files(remote_manifest)
            reboot_pending = self._post_update_action(remote_version)
            self._write_state(staging_in_progress=False, reboot_pending=reboot_pending)
            self._write_last_result("success", f"Update applied successfully: {remote_version_text}", reboot_pending=reboot_pending)

            self.log.info(f"Update applied successfully: {remote_version_text}")

    async def run_forever(self) -> None:
        await self._ensure_trigger_listener()
        while True:
            success = False
            for attempt in range(1, self.settings.max_retries + 1):
                try:
                    await self.run_update_cycle()
                    success = True
                    break
                except Exception as exc:
                    self.log.error(f"Attempt {attempt}/{self.settings.max_retries} failed: {exc}")
                    self._write_state(staging_in_progress=False, reboot_pending=False)
                    self._write_last_result("failed", f"Attempt {attempt} failed: {exc}")
                    if attempt < self.settings.max_retries:
                        await asyncio.sleep(self.settings.retry_delay_seconds)

            if not success:
                self.log.error("All retries failed; waiting for next scheduled cycle.")

            await asyncio.sleep(self.settings.poll_interval_seconds)


async def main() -> None:
    settings = load_settings(SETTINGS_PATH)
    logger = configure_logging(settings.log_file)
    logger.info("BellForge updater started")
    logger.info(f"update_base_url={settings.update_base_url}")
    logger.info(f"install_dir={settings.install_dir}")
    agent = UpdateAgent(settings, logger)
    await agent.run_forever()


if __name__ == "__main__":
    asyncio.run(main())
