from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main()