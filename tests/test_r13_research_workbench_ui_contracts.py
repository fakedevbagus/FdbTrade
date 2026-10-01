"""R1.3 projection-only research workbench contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
FRONTEND_BOUNDARY = ROOT / "frontend/src/lib/research-workbench.ts"
FRONTEND_PAGE = ROOT / "frontend/src/app/(app)/research/workbench/page.tsx"
FRONTEND_FORM = ROOT / "frontend/src/components/research/ResearchRunForm.tsx"
FRONTEND_VIEWS = ROOT / "frontend/src/components/research/ResearchRunViews.tsx"
FRONTEND_PROXY = ROOT / "frontend/src/app/api/research/runs/route.ts"
FRONTEND_TEST = ROOT / "frontend/src/lib/__tests__/research-workbench.test.tsx"
PROXY_TEST = ROOT / "frontend/src/app/api/research/runs/__tests__/route.test.ts"
BACKEND_TEST = ROOT / "backend/src/app/api/research/runs/__tests__/route.test.ts"
AUTHORITY = ROOT / "artifacts/rebuild/r1.3/research-workbench-ui.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.3_RESEARCH_WORKBENCH_UI.md"
ADR = ROOT / "docs/adr/ADR-0049-projection-only-research-workbench.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"


class R13ResearchWorkbenchUiContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)

    def test_ui_is_a_strict_projection_over_only_r12(self):
        boundary = FRONTEND_BOUNDARY.read_text(encoding="utf-8")
        page = FRONTEND_PAGE.read_text(encoding="utf-8")
        form = FRONTEND_FORM.read_text(encoding="utf-8")
        views = FRONTEND_VIEWS.read_text(encoding="utf-8")
        proxy = FRONTEND_PROXY.read_text(encoding="utf-8")
        for marker in (
            ".strict()", "researchWorkbenchListSchema",
            "researchWorkbenchDetailSchema", "submissionRequestSchema",
            "eligibleResearchDatasets", "Session expired",
            "Research backend is unavailable",
        ):
            self.assertIn(marker, boundary)
        for marker in ("projection-only", "quality-blocked", "Historical-only", "Uncalibrated", "Non-promotion"):
            self.assertIn(marker, page + views)
        for marker in (
            "datasetId: selected.datasetId",
            "createdAtUtc: new Date().toISOString()",
            "Duplicate request reopened the existing durable research run",
        ):
            self.assertIn(marker, form)
        self.assertIn('`${BFF_API_URL}/api/research/runs`', proxy)
        self.assertNotIn("/api/backtest/runs", boundary + page + form + views + proxy)
        self.assertNotIn("/api/paper/", boundary + page + form + views + proxy)

    def test_frontend_behavior_covers_required_states_and_exact_forwarding(self):
        frontend = FRONTEND_TEST.read_text(encoding="utf-8")
        proxy = PROXY_TEST.read_text(encoding="utf-8")
        for marker in (
            "strict authoritative shape", "quality-eligible R0.6 datasets",
            "stale session and invalid ids", "backend unavailability",
            "exactly dataset identity and an explicit canonical UTC instant",
            "duplicate replay and stale-session failures",
            "success metrics, frozen costs, lineage, and interpretation",
            "blocked, failed, and empty states",
        ):
            self.assertIn(marker, frontend)
        for marker in (
            "exact POST body and opaque session cookie",
            "rejects query extensions", "safe backend-unavailable state",
        ):
            self.assertIn(marker, proxy)

    def test_r12_backend_contract_and_sources_are_preserved(self):
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        for relative, expected in authority["backendSourceSha256"].items():
            actual = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
            if relative != "backend/src/app/api/backtest/runs/route.ts":
                self.assertEqual(actual, expected, relative)
        backend = BACKEND_TEST.read_text(encoding="utf-8")
        for marker in (
            "replays idempotently, and reopens after restart",
            "persists quality-blocked evidence", "recovers an interrupted run",
            "fails closed on corrupt prior result evidence",
            "does not mutate R0.7 evaluation or R0.9 risk-paper authorities",
            "rejects a tampered terminal artifact",
        ):
            self.assertIn(marker, backend)

    def test_migration_history_extends_in_order(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
        self.assertEqual(migrations, [
            "0001_foundation", "0002_auth_foundation", "0003_audit_authority",
            "0004_runtime_lifecycle", "0005_market_data_artifacts",
            "0006_signal_intelligence", "0007_research_backtest_authority",
            "0008_risk_paper_outcomes_authority", "0009_operational_hardening",
            "0010_temporal_validation_authority",
            "0011_robustness_selection_bias_authority",
            "0012_paper_input_resolution",
            "0013_scheduled_analysis_alerts",
        ])

    def test_m48_preservation_and_safety_remain_locked(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        self.assertEqual(expected["fileCount"], 10)
        self.assertEqual(sum(item["bytes"] for item in expected["files"]), 55941)
        for entry in expected["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], entry["path"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"], entry["path"])

        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R1.3")
        self.assertEqual(authority["authority"]["migrationCount"], 9)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15, "pass": 15, "fail": 0, "timeout": 0,
            "environmentBlocked": 0, "skipped": 0, "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))

    def test_r13_handoff_was_consumed_only_by_authorized_r14(self):
        text = NEXT.read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.18", text)
        self.assertIn("Next planned unit: **R1.19", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Otorisasi audit HANYA R1.19", text)
        self.assertIn("Do not infer R1.20", text)


if __name__ == "__main__":
    unittest.main()
