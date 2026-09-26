"""R1.1 authoritative signal workbench wiring and preservation contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
COLLECTION_ROUTE = ROOT / "backend/src/app/api/signals/evaluations/route.ts"
DETAIL_ROUTE = ROOT / "backend/src/app/api/signals/evaluations/[runId]/route.ts"
PROJECTION = ROOT / "backend/src/signals/signalWorkbench.ts"
BACKEND_TEST = ROOT / "backend/src/app/api/signals/evaluations/__tests__/route.test.ts"
FRONTEND_PAGE = ROOT / "frontend/src/app/(app)/signals/workbench/page.tsx"
FRONTEND_FORM = ROOT / "frontend/src/components/signals/SignalEvaluationForm.tsx"
FRONTEND_PROXY = ROOT / "frontend/src/app/api/signals/evaluations/route.ts"
FRONTEND_TEST = ROOT / "frontend/src/lib/__tests__/signal-workbench.test.tsx"
AUTHORITY = ROOT / "artifacts/rebuild/r1.1/authoritative-signal-workbench-authority.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.1_AUTHORITATIVE_SIGNAL_WORKBENCH.md"
ADR = ROOT / "docs/adr/ADR-0047-authoritative-signal-workbench-projection.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"


class R11AuthoritativeSignalWorkbenchContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)

    def test_backend_routes_use_authenticated_sqlite_projection(self):
        collection = COLLECTION_ROUTE.read_text(encoding="utf-8")
        detail = DETAIL_ROUTE.read_text(encoding="utf-8")
        projection = PROJECTION.read_text(encoding="utf-8")
        for marker in (
            "await requireSession(request)",
            "new SignalWorkbenchProjection",
            "projection.listDatasets()",
            "projection.listRuns()",
            'authority: "sqlite"',
            "legacyScannerAuthoritative: false",
        ):
            self.assertIn(marker, collection)
        for marker in (
            "await requireSession(request)",
            "RUN_ID_PATTERN",
            "projection.getRun(runId)",
            "Signal evaluation detail accepts no query parameters",
        ):
            self.assertIn(marker, detail)
        self.assertNotRegex(projection, r"\b(?:INSERT|UPDATE|DELETE)\b\s+(?:INTO|FROM|signal_)")
        for forbidden in (
            "ResearchBacktestAuthority",
            "RiskPaperAuthority",
            "providers/shadow",
            "buildScannerView",
            "advanceLifecycle(",
            ".recover(",
            ".evaluateDataset(",
        ):
            self.assertNotIn(forbidden, projection)

    def test_workbench_is_projection_over_existing_r012_post(self):
        page = FRONTEND_PAGE.read_text(encoding="utf-8")
        form = FRONTEND_FORM.read_text(encoding="utf-8")
        proxy = FRONTEND_PROXY.read_text(encoding="utf-8")
        for marker in (
            "Authoritative signal workbench",
            "The legacy scanner is not used here",
            "candidate",
            "wait",
            "blocked",
            "failed",
            "dataset.artifactDigest",
            "run.rule",
            "run.assessedAtUtc",
        ):
            self.assertIn(marker, page)
        for marker in (
            "submitSignalEvaluation",
            "datasetId: selected.datasetId",
            "assessedAtUtc: selected.assessedAtUtc",
            "existing durable evaluation",
        ):
            self.assertIn(marker, form)
        self.assertIn('`${BFF_API_URL}/api/signals/evaluations`', proxy)
        self.assertNotIn("/api/signals/scanner", page + form + proxy)

    def test_behavior_suites_cover_required_states_and_boundaries(self):
        backend = BACKEND_TEST.read_text(encoding="utf-8")
        frontend = FRONTEND_TEST.read_text(encoding="utf-8")
        for marker in (
            "openDatabase({ databasePath, mustExist: true })",
            "orders list rows newest-first",
            "projects wait, blocked and failed",
            "rejects malformed, unknown, extended and unauthenticated detail reads",
            "research_backtest_runs",
            "risk_paper_runs",
            "paper_orders",
            "paper_outcomes",
        ):
            self.assertIn(marker, backend)
        for marker in (
            "truthful empty state",
            "registered assessment instant",
            "duplicate replay and backend failure states",
            "liveExecutionEnabled" + ": " + "true",
        ):
            self.assertIn(marker, frontend)

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
        self.assertEqual(authority["workUnit"], "R1.1")
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

    def test_checkpoint_preserves_r12_handoff_and_fresh_authorization(self):
        text = CHECKPOINT.read_text(encoding="utf-8")
        self.assertIn("Next planned unit: R1.2", text)
        self.assertIn("R1.2 and every later unit require a separate explicit", text)


if __name__ == "__main__":
    unittest.main()
