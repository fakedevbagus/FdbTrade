"""R1.5 robustness and selection-bias authority wiring contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "backend/src/research/robustnessSelectionAuthority.ts"
BEHAVIOR = ROOT / "backend/src/research/__tests__/robustnessSelectionAuthority.test.ts"
MIGRATION = ROOT / "backend/db/sqlite-migrations/0011_robustness_selection_bias_authority.sql"
DOWN = ROOT / "backend/db/sqlite-migrations/0011_robustness_selection_bias_authority.down.sql"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"
AUTHORITY = ROOT / "artifacts/rebuild/r1.5/robustness-selection-bias-authority.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.5_ROBUSTNESS_SELECTION_BIAS_EVIDENCE.md"
ADR = ROOT / "docs/adr/ADR-0051-robustness-and-selection-bias-evidence.md"
ADR_REGISTRY = ROOT / "docs/adr/README.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"


class R15RobustnessSelectionBiasContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_registry_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        self.assertIn(
            "ADR-0051-robustness-and-selection-bias-evidence.md",
            ADR_REGISTRY.read_text(encoding="utf-8"),
        )

    def test_sqlite_ledger_is_predeclared_immutable_and_reversible(self):
        up = MIGRATION.read_text(encoding="utf-8")
        down = DOWN.read_text(encoding="utf-8")
        for table in (
            "robustness_experiment_configs",
            "robustness_experiment_runs",
            "robustness_experiment_trials",
            "robustness_experiment_artifacts",
            "robustness_experiment_results",
        ):
            self.assertIn(f"CREATE TABLE {table}", up)
            self.assertIn(f"DROP TABLE IF EXISTS {table}", down)
        for marker in (
            "trial_plan_digest",
            "declaration_digest",
            "completed_trial_count",
            "robustness_experiment_trials_completed_immutable",
            "robustness_experiment_runs_terminal_immutable",
            "robustness_experiment_results_no_update",
            "robustness_experiment_results_no_delete",
        ):
            self.assertIn(marker, up)

    def test_authority_pins_bounded_trials_samples_breakdowns_and_conclusions(self):
        source = SOURCE.read_text(encoding="utf-8")
        for marker in (
            'ROBUSTNESS_CONFIG_ID = "frozen-baseline-robustness-selection-bias"',
            'deterministicSeed: "r1.5-predeclared-robustness-grid"',
            "minimumDatasetBars: 120",
            "minimumClosedTrades: 3",
            'scenarioId: "combined-adverse"',
            "predeclaredTrials",
            "predeclaredBeforeEvaluation: true",
            "all predeclared robustness trials must complete before conclusion",
            'conclusion: "insufficient-evidence"',
            'conclusion: "rejected"',
            'conclusion: "pass"',
            "regimeBreakdown",
            "robustness input dataset integrity failure",
            "robustness result artifact integrity failure",
            "robustness trial result integrity failure",
            "trialsMayNotBeOmitted: true",
        ):
            self.assertIn(marker, source)
        for forbidden in (
            "RiskPaperAuthority",
            "providers/shadow",
            "/api/backtest/runs",
            "modelPromotionEligible: true",
            "signalConfidenceCalibrated: true",
        ):
            self.assertNotIn(forbidden, source)

    def test_behavior_suite_covers_selection_sparse_unstable_adverse_restart_and_tamper(self):
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for marker in (
            "predeclares every bounded trial before evaluation",
            "explicit pass, insufficient-evidence, and rejected decisions",
            "unstable sensitivity and adverse drawdown",
            "recovers after declared trials complete",
            "output and R1.4 input artifact tampering",
            "configs, completed trials, results, artifacts, and terminal runs immutable",
            "openDatabase({ databasePath, mustExist: true })",
        ):
            self.assertIn(marker, behavior)

    def test_migration_count_and_order_are_eleven(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
                self.assertTrue(
                    MIGRATIONS.joinpath(f"{path.stem}.down.sql").is_file(),
                    path.name,
                )
        self.assertEqual(migrations, [
            "0001_foundation", "0002_auth_foundation", "0003_audit_authority",
            "0004_runtime_lifecycle", "0005_market_data_artifacts",
            "0006_signal_intelligence", "0007_research_backtest_authority",
            "0008_risk_paper_outcomes_authority", "0009_operational_hardening",
            "0010_temporal_validation_authority",
            "0011_robustness_selection_bias_authority",
            "0012_paper_input_resolution",
        ])

    def test_recorded_source_hashes_and_predecessor_boundaries_match(self):
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        for group in ("sourceSha256", "preservedSourceSha256"):
            for relative, expected in authority[group].items():
                actual = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
                if relative not in {"backend/src/app/api/backtest/runs/route.ts", "tests/test_r15_robustness_selection_bias_contracts.py"}:
                    self.assertEqual(actual, expected, relative)

    def test_m48_preservation_safety_and_gate_remain_locked(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        self.assertEqual(expected["fileCount"], 10)
        self.assertEqual(sum(item["bytes"] for item in expected["files"]), 55941)
        for entry in expected["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], entry["path"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"], entry["path"])

        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R1.5")
        self.assertEqual(
            authority["repository"]["baselineCommit"],
            "aaf2589f28fa2393697b94125659d523a5d19195",
        )
        self.assertEqual(authority["authority"]["migrationCount"], 11)
        self.assertEqual(authority["authority"]["trialCount"], 6)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15, "pass": 15, "fail": 0, "timeout": 0,
            "environmentBlocked": 0, "skipped": 0, "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))

    def test_next_stops_at_r16_and_requires_fresh_authorization(self):
        text = NEXT.read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.10", text)
        self.assertIn("Next planned unit: **R1.11", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Otorisasi implementasi HANYA R1.11", text)
        self.assertIn("Do not infer R1.12", text)


if __name__ == "__main__":
    unittest.main()
