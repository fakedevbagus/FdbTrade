"""R1.17 Twelve Data authoritative provider ingestion contracts."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
INGESTION = ROOT / "backend/src/data/providers/twelveDataAuthoritativeIngestion.ts"
BOUNDARY = ROOT / "backend/src/data/providers/twelveDataBoundary.ts"
HTTPS = ROOT / "backend/src/data/providers/twelveDataHttps.ts"
BEHAVIOR = ROOT / "backend/src/data/providers/__tests__/twelveDataAuthoritativeIngestion.test.ts"


class R117TwelveDataAuthoritativeIngestionContracts(unittest.TestCase):
    def test_ingestion_reuses_r06_and_fails_closed(self):
        source = INGESTION.read_text(encoding="utf-8")
        for marker in (
            "TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS = 1_000",
            "TWELVE_DATA_AUTHORITY_MAX_PAGES = 5",
            "TWELVE_DATA_AUTHORITY_MAX_BARS",
            "buildDatasetManifest", "MarketDataAuthority",
            "market_data_ingestion_jobs", "validateCandleSeries",
            "provider_page_contains_open_bar", "provider_duplicate_timestamp",
            "provider_session_gap", "provider_incomplete_coverage",
            "provider_evidence_stale", 'mode: "historical"',
            "status !== \"verified\"", "faultAfterPublication",
        ):
            self.assertIn(marker, source)
        for forbidden in (
            "FixtureProvider", "setInterval(", "cron(", "signalAuthority",
            "researchAuthority", "riskPaperAuthority", "submitOrder",
        ):
            self.assertNotIn(forbidden, source)

    def test_boundary_and_transport_remain_exact(self):
        boundary = BOUNDARY.read_text(encoding="utf-8")
        for marker in (
            "start_date", "end_date",
            '"end_date,format,interval,outputsize,start_date,symbol,timezone"',
            'redirect: "error"', "assertPublicResolution",
        ):
            self.assertIn(marker, boundary)
        transport = HTTPS.read_text(encoding="utf-8")
        for marker in (
            'TWELVE_DATA_HTTPS_ORIGIN = "https://api.twelvedata.com"',
            'TWELVE_DATA_HTTPS_PATH = "/time_series"',
            'method: "GET"', "servername: url.hostname",
            "rejectUnauthorized: true", "DNS resolution was not pinned",
        ):
            self.assertIn(marker, transport)

    def test_adversarial_behavior_and_progression(self):
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for marker in (
            "partial-page failure", "rate exhaustion", "stale",
            "duplicate", "gapped", "simulated crash", "tamper",
            "never falls back to fixture data",
        ):
            self.assertIn(marker, behavior)
        evidence = json.loads(
            (ROOT / "artifacts/rebuild/r1.17/twelve-data-authoritative-provider-ingestion.json").read_text()
        )
        self.assertFalse(evidence["provider"]["realProviderCallPerformed"])
        self.assertFalse(evidence["ingestion"]["partialPublication"])
        self.assertFalse(evidence["ingestion"]["fixtureFallback"])
        self.assertTrue(all(value is False for value in evidence["safety"].values()))
        self.assertEqual(evidence["finalGate"]["summary"]["pass"], 15)
        nxt = (ROOT / "docs/rebuild/NEXT.md").read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.18", nxt)
        self.assertIn("Next planned unit: **R1.19", nxt)
        self.assertIn("not authorized", nxt)

    def test_migrations_and_m48_remain_exact(self):
        migrations = [
            path for path in sorted((ROOT / "backend/db/sqlite-migrations").glob("*.sql"))
            if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", path.name)
        ]
        self.assertEqual(len(migrations), 13)
        preservation = json.loads((ROOT / "artifacts/rebuild/r0.1/preservation.json").read_text())
        for item in preservation["quarantinedWork"]["files"]:
            data = (ROOT / item["path"]).read_bytes()
            self.assertEqual(len(data), item["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])


if __name__ == "__main__":
    unittest.main()