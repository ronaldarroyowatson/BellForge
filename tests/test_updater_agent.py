from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from updater.agent import UpdateAgent, UpdaterSettings


class UpdaterAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.install_dir = Path(self.temp_dir.name)
        self.staging_dir = self.install_dir / ".staging"
        self.staging_dir.mkdir(parents=True, exist_ok=True)
        logger_name = f"bellforge.updater.test.{id(self)}"
        self.logger = logging.getLogger(logger_name)
        self.logger.handlers.clear()
        self.logger.addHandler(logging.NullHandler())
        self.logger.setLevel(logging.INFO)
        self.settings = UpdaterSettings(
            update_base_url="https://example.invalid/bellforge",
            install_dir=self.install_dir,
            staging_dir=self.staging_dir,
            log_file=self.install_dir / "updater.log",
            poll_interval_seconds=300,
            max_retries=1,
            retry_delay_seconds=1,
            trigger_port=8765,
            auto_reboot_after_update=False,
            services_to_restart=["bellforge-backend.service", "bellforge-client.service"],
            preserve_local_paths={"config/settings.json", "config/client.env"},
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_apply_pending_release_syncs_dependencies_before_restarting_services(self) -> None:
        python_exe = self.install_dir / ".venv" / "Scripts" / "python.exe"
        python_exe.parent.mkdir(parents=True, exist_ok=True)
        python_exe.write_text("", encoding="utf-8")

        release_dir = self.staging_dir / "releases" / "1.2.3"
        shadow_dir = release_dir / "shadow"
        (shadow_dir / "backend").mkdir(parents=True, exist_ok=True)
        (shadow_dir / "updater").mkdir(parents=True, exist_ok=True)
        (shadow_dir / "backend" / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
        (shadow_dir / "updater" / "requirements.txt").write_text("httpx\n", encoding="utf-8")
        (release_dir / "manifest.json").write_text(json.dumps({"version": "1.2.3", "files": {}}), encoding="utf-8")
        (self.staging_dir / "pending_update.json").write_text(
            json.dumps(
                {
                    "release_version": "1.2.3",
                    "release_dir": str(release_dir),
                    "managed_roots": ["backend", "client", "updater"],
                    "trigger_source": "manual",
                }
            ),
            encoding="utf-8",
        )

        agent = UpdateAgent(self.settings, self.logger)

        completed = subprocess.CompletedProcess(args=["ok"], returncode=0, stdout="", stderr="")
        with (
            patch.object(agent, "_atomic_swap_roots") as swap_mock,
            patch.object(agent, "_write_tracking_files") as tracking_mock,
            patch("updater.agent.subprocess.run", return_value=completed) as run_mock,
        ):
            agent._apply_pending_release_if_present()

        commands = [call.args[0] for call in run_mock.call_args_list]
        self.assertGreaterEqual(len(commands), 4)
        self.assertEqual(
            commands[0],
            [
                str(python_exe),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "-r",
                str(shadow_dir / "backend" / "requirements.txt"),
            ],
        )
        self.assertEqual(
            commands[1],
            [
                str(python_exe),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "-r",
                str(shadow_dir / "updater" / "requirements.txt"),
            ],
        )
        swap_mock.assert_called_once()
        tracking_mock.assert_called_once()
        self.assertEqual(commands[2], ["systemctl", "restart", "bellforge-backend.service"])
        self.assertEqual(commands[3], ["systemctl", "restart", "bellforge-client.service"])
        self.assertFalse((self.staging_dir / "pending_update.json").exists())

    def test_stage_downloads_retries_hash_mismatch_with_fresh_download(self) -> None:
        agent = UpdateAgent(self.settings, self.logger)
        release_dir = self.staging_dir / "releases" / "9.9.9"
        release_dir.mkdir(parents=True, exist_ok=True)

        good_bytes = b"<html>correct payload</html>\n"
        bad_bytes = b"<html>stale payload</html>\n"
        expected_hash = __import__("hashlib").sha256(good_bytes).hexdigest()

        manifest_files = {
            "client/settings.html": {
                "sha256": expected_hash,
                "size": len(good_bytes),
            }
        }

        attempts: list[str | None] = []

        async def fake_download(_client, _relative_path: str, destination: Path, *, cache_token: str | None = None) -> None:
            attempts.append(cache_token)
            destination.parent.mkdir(parents=True, exist_ok=True)
            payload = bad_bytes if len(attempts) == 1 else good_bytes
            destination.write_bytes(payload)

        async def run_test() -> None:
            with patch.object(agent, "_download_file", side_effect=fake_download):
                await agent._stage_downloads(
                    client=None,
                    release_dir=release_dir,
                    changed_files=["client/settings.html"],
                    manifest_files=manifest_files,
                    cache_token="initial-token",
                )

        asyncio.run(run_test())

        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], "initial-token")
        self.assertNotEqual(attempts[1], "initial-token")

        staged_file = release_dir / "files" / "client" / "settings.html"
        self.assertTrue(staged_file.is_file())
        self.assertEqual(staged_file.read_bytes(), good_bytes)


if __name__ == "__main__":
    unittest.main()