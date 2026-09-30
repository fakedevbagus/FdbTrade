"""R1.7 authenticated operator-confirmed paper API contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
ROUTE = ROOT / "backend/src/app/api/paper/runs/route.ts"
DETAIL = ROOT / "backend/src/app/api/paper/runs/[runId]/route.ts"
PROJECTION = ROOT / "backend/src/paper/paperRunProjection.ts"
BEHAVIOR = ROOT / "backend/src/app/api/paper/runs/__tests__/route.test.ts"
AUTHORITY = ROOT / "artifacts/rebuild/r1.7/operator-confirmed-paper-api.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.7_OPERATOR_CONFIRMED_PAPER_API.md"
ADR = ROOT / "docs/adr/ADR-0053-operator-confirmed-paper-api.md"
ADR_REGISTRY = ROOT / "docs/adr/README.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"


class R17OperatorConfirmedPaperApiContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_registry_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        self.assertIn(
            "ADR-0053-operator-confirmed-paper-api.md",
            ADR_REGISTRY.read_text(encoding="utf-8"),
        )

    def test_routes_are_authenticated_strict_and_explicitly_confirmed(self):
        route = ROUTE.read_text(encoding="utf-8")
        detail = DETAIL.read_text(encoding="utf-8")
        for source in (route, detail):
            self.assertIn("requireSession(request)", source)
            self.assertIn('export const dynamic = "force-dynamic"', source)
        for marker in (
            ".strict()",
            'z.literal("confirm-paper-run")',
            "inputResolutionId",
            "requestedQuantityUnits",
            "Paper run confirmation accepts no query parameters.",
            "loadVerifiedPaperInputResolution",
            "inputs.recover()",
            "authority.recover()",
            "authority.run({",
        ):
            self.assertIn(marker, route)
        self.assertLess(route.index("inputs.recover()"), route.index("authority.run({"))
        self.assertLess(route.index("authority.recover()"), route.index("authority.run({"))
        request_call = route[route.index("authority.run({"):]
        for forbidden in (
            "observedSpreadPips", "estimatedSlippagePips", "conversionRate",
            "executionDatasetId", "riskDecision",
        ):
            self.assertNotIn(forbidden, request_call)

    def test_projection_is_separate_from_preserved_r09_business_logic(self):
        projection = PROJECTION.read_text(encoding="utf-8")
        self.assertIn("class DurablePaperRunProjection", projection)
        self.assertIn("SELECT * FROM risk_paper_runs", projection)
        self.assertIn("riskDecisionSchema.parse", projection)
        self.assertIn("paperOrderSchema.parse", projection)
        for forbidden in (
            "evaluateRisk(", "simulatePaperRoundTrip(", "INSERT INTO",
            "UPDATE risk_paper_runs", "fetch(", "axios",
        ):
            self.assertNotIn(forbidden, projection)

    def test_behavior_covers_required_operator_and_failure_boundaries(self):
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for marker in (
            "requires auth, an explicit confirmation and a strict caller boundary",
            "executes once, replays idempotently and projects list/detail truthfully",
            "projects a killed risk decision as rejected and creates no fills",
            "recovers interrupted work after reopen and blocks missing or tampered resolution evidence",
            "guards list/detail reads and rejects malformed or absent run identities",
            "projects a durable pre-paper risk-state failure without inventing an order",
            "releaseKill(", "forceRiskState(", "openDatabase({ databasePath, mustExist: true })",
        ):
            self.assertIn(marker, behavior)

    def test_migration_count_and_order_remain_twelve(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
                self.assertTrue(MIGRATIONS.joinpath(f"{path.stem}.down.sql").is_file())
        self.assertEqual(len(migrations), 12)
        self.assertEqual(migrations[-1], "0012_paper_input_resolution")

    def test_recorded_source_hashes_and_predecessors_match(self):
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        # R1.8 is authorized to extend the R1.7 GET adapters and route tests with
        # read-only workbench facts. Historical hashes remain immutable evidence;
        # current hashes for those explicit adapters are recorded by R1.8.
        r18 = ROOT / "artifacts/rebuild/r1.8/paper-and-outcome-workbench.json"
        adapted = set(json.loads(r18.read_text(encoding="utf-8"))["sourceSha256"]) if r18.is_file() else set()
        for group in ("sourceSha256", "preservedSourceSha256"):
            for relative, expected in authority[group].items():
                actual = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
                if relative not in adapted and relative not in {"backend/src/app/api/backtest/runs/route.ts", "tests/test_r17_operator_confirmed_paper_api_contracts.py"}:
                    self.assertEqual(actual, expected, relative)
        self.assertEqual(
            authority["repository"]["baselineCommit"],
            "afd41536ef05181a1de8e3037c2c245c102c15b2",
        )

    def test_m48_gate_and_execution_safety_remain_locked(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        self.assertEqual(expected["fileCount"], 10)
        self.assertEqual(sum(item["bytes"] for item in expected["files"]), 55941)
        for entry in expected["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], entry["path"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"], entry["path"])
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["authority"]["migrationCount"], 12)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15, "pass": 15, "fail": 0, "timeout": 0,
            "environmentBlocked": 0, "skipped": 0, "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))

    def test_next_stops_at_r18_and_requires_fresh_authorization(self):
        text = NEXT.read_text(encoding="utf-8")
        if "Current completed unit: **R1.7" in text:
            self.assertIn("Next planned unit: **R1.8", text)
            self.assertIn("Otorisasi implementasi HANYA R1.8", text)
            self.assertIn("Do not infer R1.9", text)
        else:
            self.assertIn("Current completed unit: **R1.12", text)
            self.assertIn("Next planned unit: **R1.13", text)
            self.assertIn("Otorisasi implementasi HANYA R1.13", text)
            self.assertIn("Do not infer R1.14", text)
        self.assertIn("Authorization state: **not authorized**", text)


if __name__ == "__main__":
    unittest.main()
