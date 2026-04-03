from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from backend.services.display_pipeline import run_self_heal


class DisplayPipelineSelfHealTests(unittest.TestCase):
    def test_reboot_uses_root_helper_script_when_present(self) -> None:
        helper_success = subprocess.CompletedProcess(
            args=["/opt/bellforge/scripts/self_heal_root.sh", "reboot"],
            returncode=0,
            stdout="",
            stderr="",
        )

        with (
            patch("backend.services.display_pipeline.Path.is_file", return_value=True),
            patch("backend.services.display_pipeline.subprocess.run", return_value=helper_success) as run_mock,
        ):
            result = run_self_heal("reboot")

        self.assertTrue(result["ok"])
        self.assertFalse(result["used_sudo"])
        called = run_mock.call_args.args[0]
        self.assertEqual(called[1], "reboot")
        self.assertTrue(str(called[0]).replace("\\", "/").endswith("/opt/bellforge/scripts/self_heal_root.sh"))

    def test_command_specific_sudoers_still_allows_reboot(self) -> None:
        direct_failure = subprocess.CompletedProcess(
            args=["/sbin/reboot"],
            returncode=1,
            stdout="",
            stderr="System has not been booted with systemd as init system",
        )
        sudo_success = subprocess.CompletedProcess(
            args=["sudo", "-n", "/sbin/reboot"],
            returncode=0,
            stdout="",
            stderr="",
        )

        with (
            patch("backend.services.display_pipeline.shutil.which", return_value="/usr/bin/sudo"),
            patch("backend.services.display_pipeline.os.geteuid", create=True, return_value=1000),
            patch("backend.services.display_pipeline.subprocess.run", side_effect=[direct_failure, sudo_success]) as run_mock,
        ):
            result = run_self_heal("reboot")

        self.assertTrue(result["ok"])
        self.assertTrue(result["used_sudo"])
        self.assertFalse(result["permission_denied"])
        self.assertEqual(run_mock.call_args_list[1].args[0], ["sudo", "-n", "/sbin/reboot"])

    def test_permission_denied_is_reported_when_sudo_rejects_reboot(self) -> None:
        direct_failure = subprocess.CompletedProcess(
            args=["/sbin/reboot"],
            returncode=1,
            stdout="",
            stderr="Failed to reboot: Interactive authentication required.",
        )
        sudo_failure = subprocess.CompletedProcess(
            args=["sudo", "-n", "/sbin/reboot"],
            returncode=1,
            stdout="",
            stderr="sudo: a terminal is required to read the password",
        )

        with (
            patch("backend.services.display_pipeline.shutil.which", return_value="/usr/bin/sudo"),
            patch("backend.services.display_pipeline.os.geteuid", create=True, return_value=1000),
            patch("backend.services.display_pipeline.subprocess.run", side_effect=[direct_failure, sudo_failure]),
        ):
            result = run_self_heal("reboot")

        self.assertFalse(result["ok"])
        self.assertTrue(result["used_sudo"])
        self.assertTrue(result["permission_denied"])
        self.assertIn("sudo:", result["stderr"].lower())


if __name__ == "__main__":
    unittest.main()