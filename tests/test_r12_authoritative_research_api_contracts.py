"""R1.2 authoritative research API wiring and preservation contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
COLLECTION_ROUTE = ROOT / "backend/src/app/api/research/runs/route.ts"
DETAIL_ROUTE = ROOT / "backend/src/app/api/research/runs/[runId]/route.ts"
AUTHORITY_SOURCE = ROOT / "backend/src/research/researchAuthority.ts"
STORE_DIR = ROOT / "backend/src/research/storeDir.ts"
BACKEND_TEST = ROOT / "backend/src/app/api/research/runs/__tests__/route.test.ts"
LEGACY_ROUTE = ROOT / "backend/src/app/api/backtest/runs/route.ts"
AUTHORITY = ROOT / "artifacts/rebuild/r1.2/authoritative-research-api.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.2_AUTHORITATIVE_RESEARCH_API.md"
ADR = ROOT / "docs/adr/ADR-0048-authoritative-research-api.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"


class R12AuthoritativeResearchApiContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)

    def test_routes_are_authenticated_strict_r08_adapters(self):
        collection = COLLECTION_ROUTE.read_text(encoding="utf-8")
        detail = DETAIL_ROUTE.read_text(encoding="utf-8")
        store = STORE_DIR.read_text(encoding="utf-8")
        for marker in (
            "await requireSession(request)",
            ".strict()",
            "datasetId",
            "createdAtUtc",
            "signalAuthority.registerBaselineRule",
            "authority.registerBaselineConfig",
            "authority.recover()",
            "recovery.corruptResults.length > 0",
            "authority.runDataset",
            "authority.listRuns()",
            'authority: "sqlite-and-content-addressed-artifact"',
            "legacyBacktestAuthoritative: false",
            "riskPaperAuthorityInvoked: false",
        ):
            self.assertIn(marker, collection)
        for marker in (
            "await requireSession(request)",
            "RUN_ID_PATTERN",
            "researchBacktestAuthority(getDatabase()).getRun(runId)",
            "Research run detail accepts no query parameters",
        ):
            self.assertIn(marker, detail)
        self.assertIn("new ResearchBacktestAuthority", store)
        self.assertNotIn("RiskPaperAuthority", collection + detail + store)
        self.assertNotIn("providers/shadow", collection + detail + store)

    def test_read_projection_verifies_sqlite_artifact_and_frozen_lineage(self):
        source = AUTHORITY_SOURCE.read_text(encoding="utf-8")
        for marker in (
            "listRuns(limit = RESEARCH_RUN_LIST_LIMIT)",
            "getRun(authorityRunId: string)",
            "this.verifyResultRow",
            "research backtest request identity mismatch",
            "research backtest frozen configuration mismatch",
            "research backtest terminal lineage mismatch",
            "research result artifact integrity failure",
            "research result summary integrity failure",
            "research backtest manifest mismatch",
        ):
            self.assertIn(marker, source)

    def test_behavior_suite_covers_required_boundaries(self):
        backend = BACKEND_TEST.read_text(encoding="utf-8")
        for marker in (
            "replays idempotently, and reopens after restart",
            "persists quality-blocked evidence",
            "recovers an interrupted run",
            "fails closed on corrupt prior result evidence",
            "rejects unknown, malformed, extended, queried, and unauthenticated requests",
            "does not mutate R0.7 evaluation or R0.9 risk-paper authorities",
            "deterministic SQLite/artifact-backed projections",
            "rejects a tampered terminal artifact",
            "openDatabase({ databasePath, mustExist: true })",
        ):
            self.assertIn(marker, backend)

    def test_legacy_backtest_route_is_not_promoted(self):
        legacy = LEGACY_ROUTE.read_text(encoding="utf-8")
        self.assertNotIn("ResearchBacktestAuthority", legacy)
        self.assertNotIn("researchBacktestAuthority", legacy)
        self.assertNotIn("research_backtest_runs", legacy)

    def test_migration_history_extends_in_order(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
        self.assertEqual(migrations, [
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
            "0011_robustness_selection_bias_authority",
            "0012_paper_input_resolution",
        ])

    def test_m48_preservation_and_safety_remain_locked(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        self.assertEqual(expected["fileCount"], 10)
        for entry in expected["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], entry["path"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"], entry["path"])

        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R1.2")
        self.assertEqual(authority["status"], "complete")
        self.assertEqual(authority["authority"]["migrationCount"], 9)
        self.assertFalse(authority["authority"]["legacyBacktestApiAuthoritative"])
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

    def test_r12_handoff_progressed_only_through_authorized_units(self):
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertIn("R1.3", authority["nextWorkUnit"])
        text = NEXT.read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.13", text)
        self.assertIn("Next planned unit: **R1.14", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Otorisasi audit HANYA R1.14", text)
        self.assertIn("Do not infer R1.15", text)


if __name__ == "__main__":
    unittest.main()
