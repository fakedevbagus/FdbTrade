"""M46 immutable historical research workflow contracts."""
from __future__ import annotations

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend" / "src"
HISTORICAL = BACKEND / "data" / "historical"

class M46HistoricalContracts(unittest.TestCase):
    def test_required_modules_and_user_routes_exist(self):
        for name in ("csvParser.ts", "datasetRegistry.ts", "importService.ts", "replayLoader.ts", "storeDir.ts"):
            self.assertTrue((HISTORICAL / name).is_file(), name)
        for route in (
            BACKEND / "app" / "api" / "historical" / "datasets" / "route.ts",
            BACKEND / "app" / "api" / "historical" / "preview" / "route.ts",
            BACKEND / "app" / "api" / "historical" / "datasets" / "[datasetId]" / "replay" / "route.ts",
        ):
            self.assertTrue(route.is_file(), route)

    def test_import_fails_closed_for_oversize_and_ambiguous_input(self):
        text = (HISTORICAL / "csvParser.ts").read_text(encoding="utf-8")
        self.assertIn("MAX_IMPORT_ROWS", text)
        self.assertIn("CSV row limit exceeded", text)
        self.assertIn("exactly", text.lower())

    def test_historical_mode_never_falls_back_to_fixture(self):
        text = (BACKEND / "backtest" / "api.ts").read_text(encoding="utf-8")
        self.assertIn("Historical replay rejected", text)
        self.assertIn("request.datasetId", text)
        self.assertIn("dataset instrument/timeframe differs", text)

    def test_user_interface_labels_mode_and_requires_approval(self):
        text = (ROOT / "frontend" / "src" / "app" / "(app)" / "research" / "datasets" / "page.tsx").read_text(encoding="utf-8")
        self.assertIn("historical", text.lower())
        self.assertIn("confirm", text.lower())
        self.assertIn("live execution off", text.lower())
        self.assertIn("provider order transport off", text.lower())

    def test_no_live_or_provider_order_authority_added(self):
        for path in HISTORICAL.rglob("*.ts"):
            text = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("provider_order_transport_enabled=true", text)
            self.assertNotIn("live_execution_enabled=true", text)

if __name__ == "__main__":
    unittest.main()
