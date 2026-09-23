"""R0.8 deterministic research and backtest authority contracts."""

from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
MIGRATION = BACKEND / "db" / "sqlite-migrations" / "0007_research_backtest_authority.sql"
AUTHORITY = BACKEND / "src" / "research" / "researchAuthority.ts"


class ResearchBacktestAuthorityContracts(unittest.TestCase):
    def test_sqlite_owns_configs_runs_artifacts_and_results(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        for table in (
            "research_backtest_configs",
            "research_backtest_runs",
            "research_backtest_artifacts",
            "research_backtest_results",
        ):
            self.assertIn(f"CREATE TABLE {table}", migration)
        for trigger in (
            "research_backtest_configs_no_update",
            "research_backtest_runs_terminal_immutable",
            "research_backtest_artifacts_no_delete",
            "research_backtest_results_no_update",
        ):
            self.assertIn(trigger, migration)

    def test_authority_uses_verified_dataset_and_registered_signal_lineage(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            "this.marketData.load",
            "evaluateBaselineRule",
            "SIGNAL_RULE_ID",
            "SIGNAL_RULE_LOGIC_VERSION",
            "SIGNAL_RULE_CONFIG_VERSION",
            "runBacktest",
            "dataset.manifest.checksum.digest",
            'policyId: "realistic"',
        ):
            self.assertIn(marker, authority)
        self.assertNotIn("Math.random", authority)
        self.assertNotIn("Date.now", authority)

    def test_result_is_content_addressed_and_recoverable(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            'path.join("sha256", digest.slice(0, 2), `${digest}.json`)',
            'WHERE status = \'running\'',
            "research backtest run requires recovery",
            'after_artifact_publish',
            'after_terminal_commit',
            "research result artifact integrity failure",
            "orphanArtifacts",
        ):
            self.assertIn(marker, authority)

    def test_empirical_metrics_cannot_become_signal_confidence_or_promotion(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            "historicalOnly: true",
            "signalConfidenceCalibrated: false",
            "signalConfidenceValue: null",
            "modelPromotionEligible: false",
            "operationalOutcomeAuthority: false",
        ):
            self.assertIn(marker, authority)

    def test_no_execution_provider_ui_or_m48_authority_added(self):
        text = AUTHORITY.read_text(encoding="utf-8").lower()
        for forbidden in (
            "provider_order_transport_enabled=true",
            "live_execution_enabled=true",
            "providers/shadow",
            "submitorder",
            "paper broker",
            "app/api",
        ):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
