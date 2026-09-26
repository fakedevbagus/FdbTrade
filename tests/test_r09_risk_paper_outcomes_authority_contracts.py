"""R0.9 durable risk, paper broker and operational-outcome contracts."""

from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
MIGRATION = BACKEND / "db" / "sqlite-migrations" / "0008_risk_paper_outcomes_authority.sql"
AUTHORITY = BACKEND / "src" / "paper" / "riskPaperAuthority.ts"


class RiskPaperOutcomeAuthorityContracts(unittest.TestCase):
    def test_sqlite_owns_risk_paper_ledger_reconciliation_and_outcomes(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        for table in (
            "risk_paper_configs",
            "risk_state_events",
            "risk_paper_runs",
            "risk_decisions",
            "paper_orders",
            "paper_order_events",
            "paper_fills",
            "paper_position_events",
            "paper_reconciliation_reports",
            "paper_outcomes",
            "paper_outcome_attribution_reports",
        ):
            self.assertIn(f"CREATE TABLE {table}", migration)
        for trigger in (
            "paper_order_requires_risk_decision",
            "paper_execution_requires_approval",
            "paper_fill_requires_approval",
            "paper_outcome_requires_closed_position",
            "risk_state_events_no_delete",
            "paper_order_events_no_update",
            "paper_fills_no_delete",
            "paper_outcomes_no_update",
        ):
            self.assertIn(trigger, migration)

    def test_authority_reopens_only_verified_signal_resolution_and_market_authority(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            "this.loadCandidate",
            "loadVerifiedPaperInputResolution(",
            "this.database, this.marketData, request.inputResolutionId",
            "this.marketData.load(candidate.datasetId)",
            "this.marketData.load(resolvedInputs.executionDataset.datasetId)",
            "assertDatasetAccepted(signalDataset",
            "assertDatasetAccepted(executionDataset",
            "evaluateRisk(riskRequest, DEFAULT_RISK_LIMITS)",
            "simulatePaperRoundTrip",
            "reconcilePaperBroker",
            "tradeRecordFromPaper",
            "computeAttributionReport",
        ):
            self.assertIn(marker, authority)

        for forbidden in (
            "request.executionDatasetId",
            "request.quoteToAccountRate",
            "request.observedSpreadPips",
            "request.estimatedSlippagePips",
        ):
            self.assertNotIn(forbidden, authority)

    def test_risk_is_mandatory_and_kill_state_is_latched(self):
        migration = MIGRATION.read_text(encoding="utf-8")
        authority = AUTHORITY.read_text(encoding="utf-8")
        self.assertIn("risk_decision_id     TEXT NOT NULL UNIQUE", migration)
        self.assertIn("paper execution requires an approved risk decision", migration)
        self.assertIn('return this.applyStateOverride("engage_kill"', authority)
        self.assertIn('return this.applyStateOverride("release_kill"', authority)
        self.assertIn("applyRiskOverride(current.state, override)", authority)
        self.assertIn("risk state evidence cannot postdate", authority)

    def test_recovery_idempotency_and_operational_interpretation_are_explicit(self):
        authority = AUTHORITY.read_text(encoding="utf-8")
        for marker in (
            'WHERE status = \'running\'',
            'fault?.("after_run_started")',
            'fault?.("after_risk_decision")',
            'fault?.("after_terminal_commit")',
            "paper signal already has a divergent authoritative request",
            'authority: "operational-paper-outcome"',
            "signalConfidenceCalibrated: false",
            "signalConfidenceValue: null",
            "modelPromotionEligible: false",
            "backtestEvidenceUsedAsConfidence: false",
        ):
            self.assertIn(marker, authority)

    def test_scope_has_no_live_provider_ui_backup_m48_or_network_authority(self):
        authority = AUTHORITY.read_text(encoding="utf-8").lower()
        self.assertIn('executionmode: "local-paper-simulation-only"', authority)
        self.assertIn("liveexecutionenabled: false", authority)
        self.assertIn("providerordertransportenabled: false", authority)
        for forbidden in (
            "providers/shadow",
            "fetch(",
            "axios",
            "submitorder",
            "provider_order_transport_enabled=true",
            "live_execution_enabled=true",
            "app/api",
            "backup",
            "restore",
        ):
            self.assertNotIn(forbidden, authority)


if __name__ == "__main__":
    unittest.main()
