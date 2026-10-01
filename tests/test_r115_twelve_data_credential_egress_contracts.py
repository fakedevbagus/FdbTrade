"""R1.15 Twelve Data credential and egress boundary contracts."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARY = ROOT / "backend/src/data/providers/twelveDataBoundary.ts"
BEHAVIOR = ROOT / "backend/src/data/providers/__tests__/twelveDataBoundary.test.ts"


class R115TwelveDataBoundaryContracts(unittest.TestCase):
    def test_security_boundary_is_exact_bounded_and_unwired(self):
        source = BOUNDARY.read_text()
        for marker in (
            'TWELVE_DATA_ORIGIN = "https://api.twelvedata.com"',
            'TWELVE_DATA_PATH = "/time_series"', 'TWELVE_DATA_SECRET_FILE = "twelve-data.json"',
            "TWELVE_DATA_TIMEOUT_MS = 5_000", "TWELVE_DATA_MAX_ATTEMPTS = 2",
            "TWELVE_DATA_MINUTE_BUDGET = 8", "TWELVE_DATA_DAY_BUDGET = 800",
            '"GET"', '"15min"', '"1h"', '"4h"', '"EUR/USD"', '"NZD/USD"',
            "secret_permissions", "secret_owner", "dns_denied",
            "rate_budget_exhausted", 'redirect: "error"',
        ):
            self.assertIn(marker, source)
        for forbidden in ("fetch(", "axios", "http://", "POST", "PUT", "PATCH", "DELETE"):
            self.assertNotIn(forbidden, source)
        behavior = BEHAVIOR.read_text()
        for marker in ("secret_permissions", "secret_symlink", "request_denied", "dns_denied", "dummy-test-key"):
            self.assertIn(marker, behavior)

    def test_authority_docs_progression_and_safety(self):
        guide = (ROOT / "docs/rebuild/TWELVE_DATA_CREDENTIAL_EGRESS_BOUNDARY.md").read_text()
        self.assertIn("No test or production code invokes Twelve Data", guide)
        self.assertIn("metadata-only", guide)
        authority = json.loads((ROOT / "artifacts/rebuild/r1.15/twelve-data-credential-egress-boundary.json").read_text())
        self.assertTrue(all(value is False for value in authority["safety"].values()))
        self.assertEqual(authority["finalGate"]["summary"]["pass"], 15)
        nxt = (ROOT / "docs/rebuild/NEXT.md").read_text()
        self.assertIn("Current completed unit: **R1.18", nxt)
        self.assertIn("Next planned unit: **R1.19", nxt)
        self.assertIn("not authorized", nxt)

    def test_preservation(self):
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