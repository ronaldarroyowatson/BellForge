from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from backend.services import updater_status


class UpdaterStatusTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        (self.project_root / "config").mkdir(parents=True, exist_ok=True)
        (self.project_root / ".staging").mkdir(parents=True, exist_ok=True)
        (self.project_root / "config" / "settings.json").write_text(
            json.dumps(
                {
                    "update_base_url": "https://example.invalid/bellforge",
                    "trigger_port": 8765,
                    "poll_interval_seconds": 300,
                }
            ),
            encoding="utf-8",
        )
        (self.project_root / "config" / "version.json").write_text(
            json.dumps({"version": "1.0.0"}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_get_updater_status_reports_rich_pipeline_health(self) -> None:
        (self.project_root / ".staging" / "state.json").write_text(
            json.dumps(
                {
                    "timestamp": "2026-04-02T10:00:00Z",
                    "state": "idle",
                    "message": "BellForge 1.0.1 applied successfully.",
                    "staging_in_progress": False,
                    "reboot_pending": False,
                    "trigger_source": "manual",
                    "boot_behavior": "startup-check-then-poll",
                }
            ),
            encoding="utf-8",
        )
        (self.project_root / ".staging" / "download_progress.json").write_text(
            json.dumps({"bytes_downloaded": 2048, "bytes_total": 2048, "percent": 100.0}),
            encoding="utf-8",
        )
        (self.project_root / ".staging" / "last_update_result.json").write_text(
            json.dumps(
                {
                    "timestamp": "2026-04-02T10:00:05Z",
                    "last_update_attempt": "2026-04-02T10:00:05Z",
                    "result": "success",
                    "message": "Update applied successfully: 1.0.1",
                    "trigger_source": "manual",
                }
            ),
            encoding="utf-8",
        )

        with (
            patch.object(updater_status, "_service_status", return_value={"unit": updater_status.UPDATER_SERVICE, "active": "active", "enabled": "enabled", "healthy": True}),
            patch.object(updater_status, "_trigger_listener_status", return_value={"port": 8765, "reachable": True, "healthy": True, "last_error": None}),
            patch.object(
                updater_status,
                "_remote_source_status",
                return_value={
                    "update_base_url": "https://example.invalid/bellforge",
                    "version_healthy": True,
                    "manifest_healthy": True,
                    "healthy": True,
                    "latest_version": "1.0.1",
                    "manifest_version": "1.0.1",
                    "last_error": None,
                },
            ),
        ):
            payload = await updater_status.get_updater_status(self.project_root)

        self.assertEqual(payload["health"], "ok")
        self.assertTrue(payload["communication_pipeline_healthy"])
        self.assertTrue(payload["update_available"])
        self.assertEqual(payload["state"], "idle")
        self.assertEqual(payload["last_trigger_source"], "manual")
        self.assertEqual(payload["service"]["active"], "active")
        self.assertEqual(payload["remote_source"]["latest_version"], "1.0.1")

    async def test_trigger_update_check_now_rejects_when_updater_is_active(self) -> None:
        (self.project_root / ".staging" / "state.json").write_text(
            json.dumps(
                {
                    "timestamp": "2026-04-02T10:10:00Z",
                    "state": "downloading",
                    "message": "Downloading 4 changed files.",
                    "staging_in_progress": True,
                    "reboot_pending": False,
                }
            ),
            encoding="utf-8",
        )

        with (
            patch.object(
                updater_status,
                "_remote_source_status",
                return_value={
                    "update_base_url": "https://example.invalid/bellforge",
                    "version_healthy": True,
                    "manifest_healthy": True,
                    "healthy": True,
                    "latest_version": "1.0.2",
                    "manifest_version": "1.0.2",
                    "last_error": None,
                },
            ),
            patch.object(updater_status, "_service_status", return_value={"unit": updater_status.UPDATER_SERVICE, "active": "active", "enabled": "enabled", "healthy": True}),
            patch.object(updater_status, "_trigger_listener_status", return_value={"port": 8765, "reachable": True, "healthy": True, "last_error": None}),
        ):
            payload = await updater_status.trigger_update_check_now(self.project_root)

        self.assertFalse(payload["accepted"])
        self.assertFalse(payload["check_accepted"])
        self.assertEqual(payload["stage_reason"], "updater-active")
        self.assertIn("already active", payload["message"])

    async def test_trigger_update_check_now_accepts_when_idle(self) -> None:
        (self.project_root / ".staging" / "state.json").write_text(
            json.dumps(
                {
                    "timestamp": "2026-04-02T10:15:00Z",
                    "state": "idle",
                    "message": "No update is available right now.",
                    "staging_in_progress": False,
                    "reboot_pending": False,
                }
            ),
            encoding="utf-8",
        )

        with (
            patch.object(
                updater_status,
                "_remote_source_status",
                return_value={
                    "update_base_url": "https://example.invalid/bellforge",
                    "version_healthy": True,
                    "manifest_healthy": True,
                    "healthy": True,
                    "latest_version": "1.0.2",
                    "manifest_version": "1.0.2",
                    "last_error": None,
                },
            ),
            patch.object(updater_status, "_post_trigger_url", return_value=(200, None)),
        ):
            payload = await updater_status.trigger_update_check_now(self.project_root)

        self.assertTrue(payload["accepted"])
        self.assertTrue(payload["check_accepted"])
        self.assertTrue(payload["stage_requested"])
        self.assertTrue(payload["stage_accepted"])
        self.assertEqual(payload["stage_reason"], "started")

    async def test_status_reports_staged_pending_release(self) -> None:
        (self.project_root / ".staging" / "pending_update.json").write_text(
            json.dumps(
                {
                    "release_version": "1.0.3",
                    "release_dir": str(self.project_root / ".staging" / "releases" / "1.0.3"),
                    "managed_roots": ["backend", "client"],
                }
            ),
            encoding="utf-8",
        )

        with (
            patch.object(updater_status, "_service_status", return_value={"unit": updater_status.UPDATER_SERVICE, "active": "active", "enabled": "enabled", "healthy": True}),
            patch.object(updater_status, "_trigger_listener_status", return_value={"port": 8765, "reachable": True, "healthy": True, "last_error": None}),
            patch.object(
                updater_status,
                "_remote_source_status",
                return_value={
                    "update_base_url": "https://example.invalid/bellforge",
                    "version_healthy": True,
                    "manifest_healthy": True,
                    "healthy": True,
                    "latest_version": "1.0.3",
                    "manifest_version": "1.0.3",
                    "last_error": None,
                },
            ),
        ):
            payload = await updater_status.get_updater_status(self.project_root)

        self.assertTrue(payload["staged_update_pending"])
        self.assertEqual(payload["staged_release_version"], "1.0.3")

    async def test_manual_check_restarts_updater_when_update_already_staged(self) -> None:
        (self.project_root / ".staging" / "pending_update.json").write_text(
            json.dumps(
                {
                    "release_version": "1.0.3",
                    "release_dir": str(self.project_root / ".staging" / "releases" / "1.0.3"),
                    "managed_roots": ["backend", "client"],
                }
            ),
            encoding="utf-8",
        )

        with (
            patch.object(
                updater_status,
                "_remote_source_status",
                return_value={
                    "update_base_url": "https://example.invalid/bellforge",
                    "version_healthy": True,
                    "manifest_healthy": True,
                    "healthy": True,
                    "latest_version": "1.0.3",
                    "manifest_version": "1.0.3",
                    "last_error": None,
                },
            ),
            patch.object(
                updater_status,
                "_restart_service",
                return_value={"unit": updater_status.UPDATER_SERVICE, "ok": True, "returncode": 0, "stdout": "", "stderr": ""},
            ),
        ):
            payload = await updater_status.trigger_update_check_now(self.project_root)

        self.assertTrue(payload["check_accepted"])
        self.assertTrue(payload["stage_accepted"])
        self.assertEqual(payload["stage_reason"], "apply-pending-on-restart")

    async def test_remote_source_status_busts_cache_for_metadata(self) -> None:
        requested_urls: list[str] = []
        requested_headers: list[dict[str, str] | None] = []

        class FakeResponse:
            def __init__(self, payload: dict[str, object]) -> None:
                self._payload = payload

            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict[str, object]:
                return self._payload

        class FakeClient:
            def __init__(self, *_args: object, **_kwargs: object) -> None:
                pass

            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, exc_type, exc, tb) -> bool:
                return False

            async def get(self, url: str, headers: dict[str, str] | None = None):
                requested_urls.append(url)
                requested_headers.append(headers)
                if url.endswith("version.json") or "version.json?" in url:
                    return FakeResponse({"version": "1.0.1"})
                return FakeResponse({"version": "1.0.1", "files": {"backend/main.py": {}}})

        with patch.object(updater_status.httpx, "AsyncClient", FakeClient):
            payload = await updater_status._remote_source_status("https://example.invalid/bellforge")

        self.assertTrue(payload["healthy"])
        self.assertEqual(len(requested_urls), 2)
        for url in requested_urls:
            parsed = urlparse(url)
            self.assertIn("_bellforge_release", parse_qs(parsed.query))
        for headers in requested_headers:
            self.assertIsNotNone(headers)
            assert headers is not None
            self.assertEqual(headers.get("Cache-Control"), "no-cache, no-store, max-age=0")


if __name__ == "__main__":
    unittest.main()