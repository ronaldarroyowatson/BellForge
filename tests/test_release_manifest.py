from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import scripts.generate_manifest as generate_manifest


class ReleaseManifestTests(unittest.TestCase):
    def test_collect_files_skips_local_auth_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for relative in ("backend", "client", "updater", "config", "scripts"):
                (root / relative).mkdir(parents=True, exist_ok=True)

            (root / "backend" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            (root / "config" / "version.json").write_text('{"version": "0.0.0"}\n', encoding="utf-8")
            (root / "config" / "auth_registry.json").write_text('{"devices": []}\n', encoding="utf-8")

            original_root = generate_manifest.ROOT
            original_dirs = generate_manifest.DEPLOYABLE_DIRS
            try:
                generate_manifest.ROOT = root
                generate_manifest.DEPLOYABLE_DIRS = [
                    root / "backend",
                    root / "client",
                    root / "updater",
                    root / "config",
                    root / "scripts",
                ]
                entries = generate_manifest.collect_files()
            finally:
                generate_manifest.ROOT = original_root
                generate_manifest.DEPLOYABLE_DIRS = original_dirs

            self.assertIn("backend/main.py", entries)
            self.assertNotIn("config/auth_registry.json", entries)


if __name__ == "__main__":
    unittest.main()