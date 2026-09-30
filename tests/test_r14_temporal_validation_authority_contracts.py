"""R1.4 temporal validation authority wiring and preservation contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "backend/src/research/temporalValidationAuthority.ts"
RUNNER = ROOT / "backend/src/research/walkforwardRunner.ts"
BEHAVIOR_TEST = ROOT / "backend/src/research/__tests__/temporalValidationAuthority.test.ts"
MIGRATION = ROOT / "backend/db/sqlite-migrations/0010_temporal_validation_authority.sql"
DOWN = ROOT / "backend/db/sqlite-migrations/0010_temporal_validation_authority.down.sql"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"
AUTHORITY = ROOT / "artifacts/rebuild/r1.4/temporal-validation-authority.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.4_TEMPORAL_VALIDATION_AUTHORITY.md"
ADR = ROOT / "docs/adr/ADR-0050-temporal-validation-authority.md"
ADR_REGISTRY = ROOT / "docs/adr/README.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"


class R14TemporalValidationAuthorityContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_registry_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        self.assertIn(
            "ADR-0050-temporal-validation-authority.md",
            ADR_REGISTRY.read_text(encoding="utf-8"),
        )

    def test_sqlite_authority_is_separate_immutable_and_reversible(self):
        up = MIGRATION.read_text(encoding="utf-8")
        down = DOWN.read_text(encoding="utf-8")
        for table in (
            "temporal_validation_configs",
            "temporal_validation_runs",
            "temporal_validation_artifacts",
            "temporal_validation_results",
        ):
            self.assertIn(f"CREATE TABLE {table}", up)
            self.assertIn(f"DROP TABLE IF EXISTS {table}", down)
        for marker in (
            "dataset_artifact_digest",
            "config_digest",
            "split_digest",
            "walkforward_digest",
            "costs_digest",
            "deterministic_seed",
            "temporal_validation_runs_terminal_immutable",
            "temporal_validation_results_no_update",
            "temporal_validation_results_no_delete",
        ):
            self.assertIn(marker, up)

    def test_authority_pins_frozen_lineage_and_verifies_recovery_and_replay(self):
        source = SOURCE.read_text(encoding="utf-8")
        for marker in (
            'TEMPORAL_VALIDATION_CONFIG_ID = "frozen-baseline-temporal-validation"',
            'seed: "r1.4-frozen-temporal-baseline"',
            "trainRatio: 0.5",
            "validateRatio: 0.25",
            "testRatio: 0.25",
            "embargoBars: 2",
            "assertTemporalPlanIntegrity",
            "chronological split overlap or future leakage detected",
            "walk-forward overlap or future leakage detected",
            "walk-forward test embargo overlap detected",
            "this.marketData.load",
            "temporal validation input dataset integrity failure",
            "temporal validation result artifact integrity failure",
            "temporal validation engine evidence mismatch",
            "parameterSearchPerformed: false",
        ):
            self.assertIn(marker, source)
        self.assertIn("datasetForFold", RUNNER.read_text(encoding="utf-8"))
        for forbidden in (
            "RiskPaperAuthority",
            "providers/shadow",
            "/api/backtest/runs",
            "modelPromotionEligible: true",
            "parameterSearchPerformed: true",
        ):
            self.assertNotIn(forbidden, source)

    def test_behavior_suite_covers_temporal_failures_restart_and_tamper(self):
        behavior = BEHAVIOR_TEST.read_text(encoding="utf-8")
        for marker in (
            "chronological OOS and rolling walk-forward evidence with pinned lineage",
            "overlapping, future-leaking, and embargo-violating plans",
            "rejected quality and insufficient history",
            "recovers interrupted work",
            "output artifact tamper during recovery and replay",
            "input dataset tamper during recovery and replay",
            "configs, results, artifacts, and terminal runs immutable",
            "openDatabase({ databasePath, mustExist: true })",
        ):
            self.assertIn(marker, behavior)

    def test_migration_count_and_order_are_ten(self):
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
                if relative not in {"backend/src/app/api/backtest/runs/route.ts", "tests/test_r14_temporal_validation_authority_contracts.py"}:
                    self.assertEqual(actual, expected, relative)

    def test_m48_preservation_and_safety_remain_locked(self):
        preservation = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        expected = preservation["quarantinedWork"]
        self.assertEqual(expected["fileCount"], 10)
        self.assertEqual(sum(item["bytes"] for item in expected["files"]), 55941)
        for entry in expected["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"], entry["path"])
            self.assertEqual(
                hashlib.sha256(payload).hexdigest(),
                entry["sha256"],
                entry["path"],
            )

        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R1.4")
        self.assertEqual(authority["repository"]["baselineCommit"],
                         "8fca3a96b58a31e0112d9659dfe9809d68a45505")
        self.assertEqual(authority["authority"]["migrationCount"], 10)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15, "pass": 15, "fail": 0, "timeout": 0,
            "environmentBlocked": 0, "skipped": 0, "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))

    def test_next_stops_at_r15_and_requires_fresh_authorization(self):
        text = NEXT.read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.12", text)
        self.assertIn("Next planned unit: **R1.13", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Otorisasi implementasi HANYA R1.13", text)
        self.assertIn("Do not infer R1.14", text)


if __name__ == "__main__":
    unittest.main()
