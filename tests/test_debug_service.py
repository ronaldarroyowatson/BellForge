from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.services.debug_service import inspect_debug_events, read_debug_events, write_debug_event


class DebugServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        (self.project_root / "config").mkdir(parents=True, exist_ok=True)
        (self.project_root / "config" / "settings.json").write_text(json.dumps({
            "debug_enabled": True,
            "debug_verbose": True,
            "debug_log_file": "tests/logs/bellforge-debug/events.jsonl",
            "debug_log_max_bytes": 1200,
            "debug_log_max_age_days": 7,
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_write_and_read_debug_events(self) -> None:
        first = write_debug_event(
            self.project_root,
            source="status",
            channel="layout engine decisions",
            message="computed layout",
            payload={"columns": 5, "layoutSnapshot": {"cards": 6}},
        )
        second = write_debug_event(
            self.project_root,
            source="settings",
            channel="card registry sync",
            message="registry mismatch detected",
            payload={"missing": ["browser-links"]},
            level="warn",
        )

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])

        payload = read_debug_events(self.project_root, limit=10)
        self.assertEqual(payload["line_count"], 2)
        self.assertEqual(payload["events"][0]["source"], "status")
        self.assertEqual(payload["events"][1]["channel"], "card registry sync")

    def test_inspector_surfaces_recent_findings(self) -> None:
        write_debug_event(
            self.project_root,
            source="pi-rollout",
            channel="Pi update workflow",
            message="staged update missing after poll",
            payload={"expectedVersion": "0.1.99"},
            level="warn",
        )
        write_debug_event(
            self.project_root,
            source="settings",
            channel="exceptions and warnings",
            message="preview mirror failed to load",
            payload={"reason": "iframe timeout"},
            level="error",
        )

        inspection = inspect_debug_events(self.project_root, limit=20)
        self.assertGreaterEqual(inspection["summary"]["total_events"], 2)
        self.assertGreaterEqual(len(inspection["findings"]), 2)
        self.assertIn("Pi update workflow", inspection["summary"]["channel_counts"])


if __name__ == "__main__":
    unittest.main()