"""R1.16 Twelve Data credentialed read-only shadow contracts."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHADOW = ROOT / "backend/src/data/providers/twelveDataShadow.ts"
CLI = ROOT / "scripts/twelve_data_shadow.mjs"
HTTPS = ROOT / "backend/src/data/providers/twelveDataHttps.ts"
BEHAVIOR = ROOT / "backend/src/data/providers/__tests__/twelveDataShadow.test.ts"


class R116TwelveDataShadowContracts(unittest.TestCase):
    def test_shadow_is_bounded_operator_triggered_and_non_authoritative(self):
        source = SHADOW.read_text(encoding="utf-8")
        for marker in (
            "TWELVE_DATA_SHADOW_MAX_RESPONSE_BYTES", "TWELVE_DATA_SHADOW_MAX_ROWS",
            "excludedProviderOpenTimestamps", "referenceOnlyTimestamps",
            "providerOnlyTimestamps", "meanMaxAbsDeltaPips",
            "worstMaxAbsDeltaPips", "eligibleForSignals: false",
            "eligibleForResearch: false", "eligibleForPaper: false",
            "published: false", "mutated: false",
        ):
            self.assertIn(marker, source)
        for forbidden in (
            "MarketDataAuthority", "AuthoritativeFixtureIngestion", "DatabaseSync",
            "INSERT INTO", "UPDATE ", "DELETE FROM", "providers/shadow/",
        ):
            self.assertNotIn(forbidden, source)
        cli = CLI.read_text(encoding="utf-8")
        transport = HTTPS.read_text(encoding="utf-8")
        self.assertIn('method: "GET"', transport)
        self.assertIn("rejectUnauthorized: true", transport)
        self.assertIn("servername: url.hostname", transport)
        self.assertIn("createPinnedTwelveDataTransport", cli)
        for forbidden in ('method: "POST"', 'method: "PUT"', 'method: "PATCH"', "setInterval(", "cron("):
            self.assertNotIn(forbidden, cli + transport)

    def test_behavior_docs_progression_and_gate(self):
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for marker in (
            "still-open candle", "coverage", "duplicate", "secret_missing",
            "credentialFingerprint",
        ):
            self.assertIn(marker, behavior)
        guide = (ROOT / "docs/rebuild/TWELVE_DATA_CREDENTIALED_READ_ONLY_SHADOW.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("No credentialed smoke test was run", guide)
        self.assertIn("M48", guide)
        evidence = json.loads(
            (ROOT / "artifacts/rebuild/r1.16/twelve-data-credentialed-read-only-shadow.json").read_text()
        )
        self.assertFalse(evidence["provider"]["realProviderCallPerformed"])
        self.assertTrue(all(value is False for value in evidence["authority"].values()))
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