from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.services.display_preferences import get_display_preferences, update_display_preferences


class DisplayPreferencesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        (self.project_root / "config").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_get_display_preferences_uses_defaults(self) -> None:
        payload = get_display_preferences(self.project_root)
        self.assertEqual(payload["overscan_percent"], 96)
        self.assertEqual(payload["diagnostics_rotation_seconds"], 8)
        self.assertEqual(payload["display_scale"], 0.96)

    def test_update_display_preferences_persists_values(self) -> None:
        payload = update_display_preferences(
            self.project_root,
            overscan_percent=92,
            diagnostics_rotation_seconds=11,
        )
        self.assertTrue(payload["updated"])
        self.assertEqual(payload["overscan_percent"], 92)
        self.assertEqual(payload["diagnostics_rotation_seconds"], 11)

        saved = (self.project_root / "config" / "client.env").read_text(encoding="utf-8")
        self.assertIn("BELLFORGE_DISPLAY_SCALE=0.92", saved)
        self.assertIn("BELLFORGE_STATUS_ROTATE_SECONDS=11", saved)


if __name__ == "__main__":
    unittest.main()