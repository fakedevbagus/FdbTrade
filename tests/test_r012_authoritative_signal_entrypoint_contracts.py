"""R0.12 production wiring and preserved-authority contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
ROUTE = ROOT / "backend/src/app/api/signals/evaluations/route.ts"
ROUTE_TEST = ROOT / "backend/src/app/api/signals/evaluations/__tests__/route.test.ts"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"
AUTHORITY_ARTIFACT = (
    ROOT / "artifacts/rebuild/r0.12/authoritative-signal-entrypoint-authority.json"
)
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R0.12_AUTHORITATIVE_SIGNAL_ENTRYPOINT.md"
ADR = ROOT / "docs/adr/ADR-0045-operator-triggered-authoritative-signal-evaluation.md"


class AuthoritativeSignalEntrypointContracts(unittest.TestCase):
    def test_r012_authority_checkpoint_and_adr_exist(self):
        for path in (AUTHORITY_ARTIFACT, CHECKPOINT, ADR):
            self.assertTrue(path.is_file(), path)

    def test_route_uses_only_canonical_r06_r07_authorities(self):
        text = ROUTE.read_text(encoding="utf-8")
        for marker in (
            'from "@/db/client"',
            'from "@/data/historical/storeDir"',
            'from "@/signals/signalAuthority"',
            "new SignalIntelligenceAuthority",
            "authority.registerBaselineRule",
            "authority.recover",
            "authority.evaluateDataset",
        ):
            self.assertIn(marker, text)
        for forbidden in (
            "ResearchBacktestAuthority",
            "RiskPaperAuthority",
            "FixtureProvider",
            "providers/shadow",
            "buildScannerView",
            "submitOrder",
        ):
            self.assertNotIn(forbidden, text)

    def test_creation_boundary_remains_authenticated_strict_and_post_only(self):
        text = ROUTE.read_text(encoding="utf-8")
        for marker in (
            "await requireSession(request)",
            ".strict()",
            "datasetId:",
            "assessedAtUtc:",
            'ApiError.methodNotAllowed(["GET", "POST"])',
            "export const POST",
            "export const GET = withApi",
        ):
            self.assertIn(marker, text)
        for forbidden_request_field in (
            "instrument:",
            "timeframe:",
            "ruleId: z.",
            "order:",
            "riskDecision:",
        ):
            self.assertNotIn(forbidden_request_field, text)

    def test_response_keeps_execution_provider_research_risk_and_ui_off(self):
        text = ROUTE.read_text(encoding="utf-8")
        for marker in (
            'authority: "sqlite"',
            'executionMode: "decision-support-only"',
            "liveExecutionEnabled: false",
            "providerOrderTransportEnabled: false",
            "credentialedProviderSelected: false",
            "researchAuthorityInvoked: false",
            "riskPaperAuthorityInvoked: false",
            "uiAuthority: false",
        ):
            self.assertIn(marker, text)

    def test_file_backed_route_behavior_suite_exists(self):
        text = ROUTE_TEST.read_text(encoding="utf-8")
        for marker in (
            "openMigratedDatabase(databasePath)",
            "openDatabase({ databasePath, mustExist: true })",
            'outcome: "candidate"',
            'outcome: "wait"',
            'outcome: "blocked"',
            "recoveredRuns: 1",
            "research_backtest_runs",
            "risk_paper_runs",
            "paper_orders",
            "paper_outcomes",
            "operational_events",
        ):
            self.assertIn(marker, text)

    def test_migration_history_extends_in_order(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
        self.assertEqual(
            migrations,
            [
                "0001_foundation",
                "0002_auth_foundation",
                "0003_audit_authority",
                "0004_runtime_lifecycle",
                "0005_market_data_artifacts",
                "0006_signal_intelligence",
                "0007_research_backtest_authority",
                "0008_risk_paper_outcomes_authority",
                "0009_operational_hardening",
                "0010_temporal_validation_authority",
            ],
        )

    def test_all_quarantined_m48_files_remain_byte_identical(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        actual_files = sorted(
            path
            for path in (ROOT / expected["directory"]).iterdir()
            if path.is_file()
        )
        self.assertEqual(len(actual_files), expected["fileCount"])
        entries = {entry["path"]: entry for entry in expected["files"]}
        self.assertEqual(
            {str(path.relative_to(ROOT)) for path in actual_files},
            set(entries),
        )
        for relative, entry in entries.items():
            payload = (ROOT / relative).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], relative)
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"], relative)

    def test_authority_artifact_records_closed_scope_and_complete_gate(self):
        authority = json.loads(AUTHORITY_ARTIFACT.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R0.12")
        self.assertEqual(authority["status"], "complete")
        self.assertEqual(authority["authority"]["migrationCount"], 9)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15,
            "pass": 15,
            "fail": 0,
            "timeout": 0,
            "environmentBlocked": 0,
            "skipped": 0,
            "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))


if __name__ == "__main__":
    unittest.main()
