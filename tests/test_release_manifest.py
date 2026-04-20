from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import hashlib

import scripts.generate_manifest as generate_manifest
from updater.agent import sha256_file as updater_sha256_file


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

    def test_shebang_script_hashes_are_lf_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            script_path = Path(temp_dir) / "bellforge"
            script_bytes = b"#!/usr/bin/env bash\r\nset -eu\r\necho ok\r\n"
            script_path.write_bytes(script_bytes)

            expected_hash = hashlib.sha256(script_bytes.replace(b"\r\n", b"\n")).hexdigest()

            self.assertEqual(generate_manifest.sha256_file(script_path), expected_hash)
            self.assertEqual(updater_sha256_file(script_path), expected_hash)


if __name__ == "__main__":
    unittest.main()