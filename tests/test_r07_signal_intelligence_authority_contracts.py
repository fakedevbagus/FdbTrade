"""R0.7 deterministic signal-intelligence authority contracts."""

from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
MIGRATION = BACKEND / "db" / "sqlite-migrations" / "0006_signal_intelligence.sql"
AUTHORITY = BACKEND / "src" / "signals" / "signalAuthority.ts"


class SignalIntelligenceAuthorityContracts(unittest.TestCase):
    def test_sqlite_owns_registry_runs_candidates_evidence_and_lifecycle(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        for table in (
            "signal_rule_registry",
            "signal_evaluation_runs",
            "signal_candidates",
            "signal_evidence",
            "signal_lifecycle_events",
        ):
            self.assertIn(f"CREATE TABLE {table}", migration)
        for trigger in (
            "signal_rule_registry_no_update",
            "signal_runs_terminal_immutable",
            "signal_candidates_no_update",
            "signal_evidence_no_delete",
            "signal_lifecycle_no_delete",
        ):
            self.assertIn(trigger, migration)

    def test_rule_is_versioned_deterministic_and_uses_canonical_signal_builder(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            'SIGNAL_RULE_ID = "authoritative-momentum-baseline"',
            'SIGNAL_RULE_LOGIC_VERSION = "1.0.0"',
            'SIGNAL_RULE_CONFIG_VERSION = "1.0.0"',
            "regimeFeatureSeriesFromCandles",
            "classifyRegimes",
            "buildSignal",
        ):
            self.assertIn(marker, authority)
        self.assertNotIn("Math.random", authority)
        self.assertNotIn("Date.now", authority)

    def test_quality_freshness_and_integrity_fail_closed(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            'dataset.qualityState === "accepted"',
            'dataset.freshnessState !== "fresh"',
            'outcome: "blocked"',
            "this.marketData.load",
            "artifact provenance mismatch",
        ):
            self.assertIn(marker, authority)

    def test_recovery_and_idempotency_are_explicit(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            'WHERE status = \'running\'',
            "signal evaluation run requires recovery",
            "after_run_started",
            "after_terminal_commit",
            "terminal signal run references missing evidence",
        ):
            self.assertIn(marker, authority)

    def test_no_execution_provider_or_m48_authority_added(self):
        text = AUTHORITY.read_text(encoding="utf-8").lower()
        for forbidden in (
            "provider_order_transport_enabled=true",
            "live_execution_enabled=true",
            "providers/shadow",
            "paper broker",
            "submitorder",
        ):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
