"""R0.6 market-data and immutable artifact authority contracts."""

from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DATA = BACKEND / "src" / "data"
MIGRATION = BACKEND / "db" / "sqlite-migrations" / "0005_market_data_artifacts.sql"


class MarketDataAuthorityContracts(unittest.TestCase):
    def test_sqlite_owns_dataset_artifact_and_ingestion_metadata(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        for table in (
            "market_data_artifacts",
            "market_data_datasets",
            "market_data_ingestion_jobs",
        ):
            self.assertIn(f"CREATE TABLE {table}", migration)
        for trigger in (
            "market_data_artifacts_no_update",
            "market_data_artifacts_no_delete",
            "market_data_datasets_no_update",
            "market_data_datasets_no_delete",
            "market_data_jobs_terminal_immutable",
        ):
            self.assertIn(trigger, migration)
        self.assertIn("STRICT", migration)

    def test_authority_is_scoped_to_seven_majors_and_15m_1h_4h(self):
        authority = (DATA / "marketAuthority.ts").read_text(encoding="utf-8")
        for instrument in (
            "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
        ):
            self.assertIn(f'"{instrument}"', authority)
        self.assertIn('["15m", "1h", "4h"]', authority)
        self.assertNotIn('"XAUUSD"', authority)

    def test_publication_is_content_addressed_and_atomic_before_metadata(self):
        authority = (DATA / "marketAuthority.ts").read_text(encoding="utf-8")
        for marker in (
            'path.join("sha256", digest.slice(0, 2)',
            "fsyncSync(descriptor)",
            "renameSync(temporary, finalPath)",
            'options.fault?.("after_artifact_rename")',
            "withImmediateTransaction(this.database",
            "artifact integrity failure",
        ):
            self.assertIn(marker, authority)

    def test_historical_routes_use_canonical_sqlite_connection(self):
        route = (
            BACKEND / "src" / "app" / "api" / "historical" / "datasets" / "route.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("getDatabase()", route)
        self.assertIn("marketDataAuthority", route)
        self.assertNotIn("writeFileSync", route)

    def test_no_provider_order_or_live_authority_added(self):
        for path in (DATA / "marketAuthority.ts", DATA / "authoritativeIngestion.ts"):
            text = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("provider_order_transport_enabled=true", text)
            self.assertNotIn("live_execution_enabled=true", text)
            self.assertNotIn("providers/shadow", text)


if __name__ == "__main__":
    unittest.main()
