"""R1.8 projection-only paper and outcome workbench contracts."""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = ROOT / "frontend/src/app/(app)/paper/workbench/page.tsx"
FORM = ROOT / "frontend/src/components/paper/PaperConfirmationForm.tsx"
BOUNDARY = ROOT / "frontend/src/lib/paper-workbench.ts"
FRONT_TEST = ROOT / "frontend/src/lib/__tests__/paper-workbench.test.tsx"
PROXY = ROOT / "frontend/src/app/api/paper/runs/route.ts"
PROJECTION = ROOT / "backend/src/paper/paperWorkbenchProjection.ts"
LIST_ROUTE = ROOT / "backend/src/app/api/paper/runs/route.ts"
DETAIL_ROUTE = ROOT / "backend/src/app/api/paper/runs/[runId]/route.ts"
BACK_TEST = ROOT / "backend/src/app/api/paper/runs/__tests__/route.test.ts"
AUTHORITY = ROOT / "artifacts/rebuild/r1.8/paper-and-outcome-workbench.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.8_PAPER_AND_OUTCOME_WORKBENCH.md"
ADR = ROOT / "docs/adr/ADR-0054-paper-and-outcome-workbench.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"

class R18PaperOutcomeWorkbenchContracts(unittest.TestCase):
    def test_private_surface_evidence_and_progression_exist(self):
        for path in (PAGE, FORM, BOUNDARY, FRONT_TEST, PROXY, PROJECTION, AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        self.assertIn("/paper", (ROOT / "frontend/src/middleware.ts").read_text())
        self.assertIn("ADR-0054-paper-and-outcome-workbench.md", (ROOT / "docs/adr/README.md").read_text())

    def test_projection_is_read_only_and_authority_remains_backend_owned(self):
        text = PROJECTION.read_text()
        for marker in ("paper_input_resolutions", "signal_candidates", "risk_paper_runs", "paper_fills", "paper_position_events", "paper_reconciliation_reports"):
            self.assertIn(marker, text)
        for forbidden in ("INSERT INTO", "UPDATE ", "DELETE FROM", "evaluateRisk(", "simulatePaperRoundTrip(", "applyPaperFill(", "fetch("):
            self.assertNotIn(forbidden, text)
        for route in (LIST_ROUTE, DETAIL_ROUTE):
            source = route.read_text()
            self.assertIn("requireSession(request)", source)
            self.assertIn("inputRecovery", source)
            self.assertIn("authority.recover()", source)

    def test_ui_requires_explicit_confirmation_and_exact_payload(self):
        form = FORM.read_text()
        boundary = BOUNDARY.read_text()
        self.assertIn('type="checkbox"', form)
        self.assertIn("locked.current", form)
        self.assertIn('confirmation: "confirm-paper-run"', boundary)
        body = re.search(r"JSON\.stringify\(request\.data\)", boundary)
        self.assertIsNotNone(body)
        for forbidden in ("localStorage", "sessionStorage", "setInterval(", "setTimeout("):
            self.assertNotIn(forbidden, form + boundary)

    def test_truthful_states_assumptions_and_outcomes_are_visible(self):
        page = PAGE.read_text()
        boundary = BOUNDARY.read_text()
        for marker in ("PAPER ONLY", "KILL IS ENGAGED", "RED RISK STATE", "Registered baseline assumption — not a provider observation", "Paper-only outcome", "Inspect via durable GET", "No fills"):
            self.assertIn(marker, page)
        for state in ("pending", "running", "succeeded", "blocked", "rejected", "failed"):
            self.assertIn(f'"{state}"', boundary)
        for marker in ("riskDecision", "order", "fills", "positionEvents", "reconciliation", "outcome"):
            self.assertIn(marker, boundary)

    def test_focused_tests_cover_refresh_payload_replay_and_failure(self):
        frontend = FRONT_TEST.read_text()
        backend = BACK_TEST.read_text()
        for marker in ("never POSTs", "requires explicit confirmation", "strict R1.7 payload", "locks double-submit", "authentication", "backend outage", "malformed JSON"):
            self.assertIn(marker, frontend)
        for marker in ("projects a killed risk decision as rejected and creates no fills", "durable pre-paper risk-state failure", "positionEvents", "reconciliation", "providerObservation"):
            self.assertIn(marker, backend)

    def test_predecessor_authorities_and_m48_are_byte_preserved(self):
        r17 = json.loads((ROOT / "artifacts/rebuild/r1.7/operator-confirmed-paper-api.json").read_text())
        for relative, expected in r17["preservedSourceSha256"].items():
            if relative != "backend/src/app/api/backtest/runs/route.ts":
                self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected, relative)
        preservation = json.loads(PRESERVATION.read_text())
        for item in preservation["quarantinedWork"]["files"]:
            payload = (ROOT / item["path"]).read_bytes()
            self.assertEqual(len(payload), item["bytes"], item["path"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), item["sha256"], item["path"])

    def test_migrations_remain_twelve_and_r19_is_not_authorized(self):
        ordered = [p for p in sorted(MIGRATIONS.glob("*.sql")) if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", p.name)]
        self.assertEqual(len(ordered), 12)
        self.assertEqual(ordered[-1].name, "0012_paper_input_resolution.sql")
        text = NEXT.read_text()
        self.assertIn("Current completed unit: **R1.9", text)
        self.assertIn("Next planned unit: **R1.10", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Do not start R1.10", text)

    def test_authority_hashes_gate_and_safety_are_locked(self):
        authority = json.loads(AUTHORITY.read_text())
        self.assertEqual(authority["repository"]["baselineCommit"], "32e0cfc68115b94b7a982963d98eb80ab399913e")
        for group in ("sourceSha256", "preservedSourceSha256"):
            for relative, expected in authority[group].items():
                if relative not in {"backend/src/app/api/backtest/runs/route.ts", "tests/test_r18_paper_outcome_workbench_contracts.py"}:
                    self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected, relative)
        self.assertEqual(authority["finalGate"]["summary"], {"total": 15, "pass": 15, "fail": 0, "timeout": 0, "environmentBlocked": 0, "skipped": 0, "planned": 0})
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))
        self.assertIn("R1.9", authority["nextWorkUnit"])
        self.assertIn("not authorized", authority["nextWorkUnit"])

if __name__ == "__main__":
    unittest.main()
