from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.services.runtime_deps_guard import ensure_requirements_synced


class RuntimeDepsGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.venv_python = self.root / ".venv" / "bin" / "python"
        self.venv_python.parent.mkdir(parents=True, exist_ok=True)
        self.venv_python.write_text("", encoding="utf-8")
        self.requirements = self.root / "backend" / "requirements.txt"
        self.requirements.parent.mkdir(parents=True, exist_ok=True)
        self.requirements.write_text("fastapi>=0.110.0\n", encoding="utf-8")
        self.stamp = self.root / ".venv" / ".bellforge_backend_requirements.sha256"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_first_run_installs_and_writes_stamp(self) -> None:
        completed = subprocess.CompletedProcess(args=["ok"], returncode=0, stdout="", stderr="")
        with patch("backend.services.runtime_deps_guard.subprocess.run", return_value=completed) as run_mock:
            did_install = ensure_requirements_synced(
                venv_python=self.venv_python,
                requirements=self.requirements,
                stamp_path=self.stamp,
            )

        self.assertTrue(did_install)
        self.assertTrue(self.stamp.exists())
        run_mock.assert_called_once()
        self.assertEqual(
            run_mock.call_args.args[0],
            [
                str(self.venv_python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "-r",
                str(self.requirements),
            ],
        )

    def test_second_run_noop_when_requirements_unchanged(self) -> None:
        completed = subprocess.CompletedProcess(args=["ok"], returncode=0, stdout="", stderr="")
        with patch("backend.services.runtime_deps_guard.subprocess.run", return_value=completed) as run_mock:
            first = ensure_requirements_synced(
                venv_python=self.venv_python,
                requirements=self.requirements,
                stamp_path=self.stamp,
            )
            second = ensure_requirements_synced(
                venv_python=self.venv_python,
                requirements=self.requirements,
                stamp_path=self.stamp,
            )

        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(run_mock.call_count, 1)

    def test_requirements_change_triggers_reinstall(self) -> None:
        completed = subprocess.CompletedProcess(args=["ok"], returncode=0, stdout="", stderr="")
        with patch("backend.services.runtime_deps_guard.subprocess.run", return_value=completed) as run_mock:
            ensure_requirements_synced(
                venv_python=self.venv_python,
                requirements=self.requirements,
                stamp_path=self.stamp,
            )
            self.requirements.write_text("fastapi>=0.110.0\nPyJWT[crypto]>=2.8.0\n", encoding="utf-8")
            changed = ensure_requirements_synced(
                venv_python=self.venv_python,
                requirements=self.requirements,
                stamp_path=self.stamp,
            )

        self.assertTrue(changed)
        self.assertEqual(run_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()