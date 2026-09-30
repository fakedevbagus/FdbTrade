"""R1.14 sourced read-only provider selection dossier contracts."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOSSIER = ROOT / "docs/rebuild/PROVIDER_SELECTION_DOSSIER.md"
AUTHORITY = ROOT / "artifacts/rebuild/r1.14/provider-selection-dossier.json"


class R114ProviderSelectionDossierContracts(unittest.TestCase):
    def test_matrix_shortlist_rejections_and_unknowns(self):
        text = DOSSIER.read_text()
        for marker in (
            "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
            "15m", "1h", "4h", "Candle semantics", "Freshness", "License",
            "Authentication", "SDK independence", "Testability",
            "**Sourced facts**", "**Inference**", "**Unknown**",
            "Twelve Data Basic", "OANDA v20 candles",
            "Dukascopy Historical Data Export", "HistData",
            "Alpha Vantage FX_INTRADAY",
        ):
            self.assertIn(marker, text)
        authority = json.loads(AUTHORITY.read_text())
        self.assertEqual(sum(authority["weights"].values()), 100)
        self.assertEqual(len(authority["candidates"]), 5)
        self.assertEqual(len(authority["shortlist"]), 3)
        self.assertIsNone(authority["selectedProvider"])
        self.assertTrue(all(value is False for value in authority["safety"].values()))
        self.assertEqual(
            authority["finalGate"]["summary"],
            {"total": 15, "pass": 15, "fail": 0, "timeout": 0,
             "environmentBlocked": 0, "skipped": 0, "planned": 0},
        )

    def test_no_winner_scope_expansion_or_implementation(self):
        text = DOSSIER.read_text()
        self.assertIn("without selecting a winner", text)
        self.assertIn("Approve one named provider or defer", text)
        for provider in ("Twelve Data", "OANDA v20", "Dukascopy Historical Data Export"):
            self.assertIn(f"provider {provider}", text)
        self.assertIn("Tunda pemilihan provider", text)
        checkpoint = (ROOT / "docs/rebuild/checkpoints/R1.14_PROVIDER_SELECTION_DOSSIER.md").read_text()
        self.assertIn("No credential was created", checkpoint)
        self.assertIn("no provider API was called", checkpoint)
        nxt = (ROOT / "docs/rebuild/NEXT.md").read_text()
        self.assertIn("Current completed unit: **R1.17", nxt)
        self.assertIn("Next planned unit: **R1.18", nxt)
        self.assertIn("Selected provider: **Twelve Data**", nxt)

    def test_preservation(self):
        migrations = [
            path for path in sorted((ROOT / "backend/db/sqlite-migrations").glob("*.sql"))
            if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", path.name)
        ]
        self.assertEqual(len(migrations), 12)
        preservation = json.loads((ROOT / "artifacts/rebuild/r0.1/preservation.json").read_text())
        for item in preservation["quarantinedWork"]["files"]:
            data = (ROOT / item["path"]).read_bytes()
            self.assertEqual(len(data), item["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])


if __name__ == "__main__":
    unittest.main()