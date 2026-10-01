"""R1.18 scheduled analysis and alerts contracts."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIPELINE = ROOT / "backend/src/runtime/scheduledAnalysis.ts"
STARTUP = ROOT / "backend/src/runtime/startup.ts"
BEHAVIOR = ROOT / "backend/src/runtime/__tests__/scheduledAnalysis.test.ts"
MIGRATION = ROOT / "backend/db/sqlite-migrations/0013_scheduled_analysis_alerts.sql"


class R118ScheduledAnalysisAlertsContracts(unittest.TestCase):
    def test_pipeline_reuses_authorities_and_has_no_execution_path(self):
        source = PIPELINE.read_text(encoding="utf-8")
        for marker in (
            "AuthoritativeTwelveDataIngestion",
            "SignalIntelligenceAuthority",
            "DurableAlertCenter",
            "SCHEDULED_MAX_BACKLOG = 42",
            "SCHEDULED_LOOKBACK_BARS = 128",
            "risk_state_events",
            'paperMutationAuthority: false',
        ):
            self.assertIn(marker, source)
        for forbidden in (
            "RiskPaperAuthority", "submitOrder", "paperRun", "brokerAdapter",
            "modelPromotion", "FixtureProvider",
        ):
            self.assertNotIn(forbidden, source)

    def test_production_wiring_is_opt_in_and_bounded(self):
        source = STARTUP.read_text(encoding="utf-8")
        self.assertIn('FDB_RUNTIME_SCHEDULER_DEFAULT = "off"', source)
        self.assertIn("ScheduledAnalysisPipeline", source)
        self.assertIn("pipeline.handlers()", source)
        self.assertIn("queueBacklog: pipeline.backlog()", source)
        self.assertIn("createPinnedTwelveDataTransport", source)

    def test_durable_schema_and_adversarial_behavior(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        for marker in (
            "CREATE TABLE scheduled_analysis_work",
            "CREATE TABLE alert_preferences",
            "CREATE TABLE alert_events",
            "UNIQUE(decision_id, event_class)",
            "alert event identity is immutable",
            "alert events are durable evidence",
        ):
            self.assertIn(marker, migration)
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for marker in (
            "without paper mutation", "recovers crashes at ingest, analyze and emit",
            "provider outage", "bounds queued work", "paperCounts",
        ):
            self.assertIn(marker, behavior)

    def test_progression_migrations_and_m48(self):
        evidence = json.loads(
            (ROOT / "artifacts/rebuild/r1.18/scheduled-analysis-alerts.json").read_text()
        )
        self.assertFalse(evidence["scheduler"]["defaultEnabled"])
        self.assertFalse(evidence["pipeline"]["fixtureFallback"])
        self.assertTrue(all(value is False for value in evidence["safety"].values()))
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
        nxt = (ROOT / "docs/rebuild/NEXT.md").read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.18", nxt)
        self.assertIn("Next planned unit: **R1.19", nxt)
        self.assertIn("not authorized", nxt)


if __name__ == "__main__":
    unittest.main()