"""R1.6 paper-input resolution authority wiring contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "backend/src/paper/paperInputResolutionAuthority.ts"
PAPER = ROOT / "backend/src/paper/riskPaperAuthority.ts"
BEHAVIOR = ROOT / "backend/src/paper/__tests__/paperInputResolutionAuthority.test.ts"
MIGRATION = ROOT / "backend/db/sqlite-migrations/0012_paper_input_resolution.sql"
DOWN = ROOT / "backend/db/sqlite-migrations/0012_paper_input_resolution.down.sql"
MIGRATIONS = ROOT / "backend/db/sqlite-migrations"
AUTHORITY = ROOT / "artifacts/rebuild/r1.6/paper-input-resolution-authority.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.6_PAPER_INPUT_RESOLUTION.md"
ADR = ROOT / "docs/adr/ADR-0052-paper-input-resolution-authority.md"
ADR_REGISTRY = ROOT / "docs/adr/README.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"


class R16PaperInputResolutionContracts(unittest.TestCase):
    def test_authority_checkpoint_adr_registry_and_handoff_exist(self):
        for path in (AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        self.assertIn(
            "ADR-0052-paper-input-resolution-authority.md",
            ADR_REGISTRY.read_text(encoding="utf-8"),
        )

    def test_sqlite_authority_is_immutable_and_reversible(self):
        up = MIGRATION.read_text(encoding="utf-8")
        down = DOWN.read_text(encoding="utf-8")
        for table in (
            "paper_input_configs",
            "paper_input_resolution_runs",
            "paper_input_resolutions",
        ):
            self.assertIn(f"CREATE TABLE {table}", up)
            self.assertIn(f"DROP TABLE IF EXISTS {table}", down)
        for marker in (
            "paper_input_configs_no_update",
            "paper_input_resolution_runs_terminal_immutable",
            "paper_input_resolution_runs_no_delete",
            "paper_input_resolutions_no_update",
            "paper_input_resolutions_no_delete",
        ):
            self.assertIn(marker, up)

    def test_resolution_is_deterministic_closed_scope_and_fail_closed(self):
        source = SOURCE.read_text(encoding="utf-8")
        for marker in (
            'PAPER_INPUT_CONFIG_ID = "registered-baseline-paper-inputs"',
            'accountCurrency: "USD"',
            "maximumInputAgeBars: 2",
            "providerAuthorityAvailable: false",
            'costSource: "registered-baseline-assumption-no-provider-observation"',
            'method: "identity" | "inverse"',
            'crossInstruments: readonly []',
            '"input_stale"',
            '"event_bar_missing"',
            '"event_bar_ambiguous"',
            '"config_drift"',
            "paper input resolution replay diverged",
        ):
            self.assertIn(marker, source)
        for forbidden in (
            "fetch(", "axios", "providers/shadow", "RiskPaperAuthority",
            "liveExecutionEnabled" + ": " + "true",
            "providerOrderTransportEnabled" + ": " + "true",
        ):
            self.assertNotIn(forbidden, source)

    def test_r09_consumes_resolution_not_ui_cost_or_conversion(self):
        paper = PAPER.read_text(encoding="utf-8")
        self.assertIn("loadVerifiedPaperInputResolution", paper)
        request = paper[paper.index("export interface PaperRunRequest"):paper.index("export interface PaperRunResult")]
        self.assertIn("inputResolutionId", request)
        for forbidden in ("observedSpreadPips", "estimatedSlippagePips", "conversion:"):
            self.assertNotIn(forbidden, request)
        self.assertIn("evaluateRisk(riskRequest, DEFAULT_RISK_LIMITS)", paper)
        self.assertIn("paper_fill_requires_approval", MIGRATION.parent.joinpath(
            "0008_risk_paper_outcomes_authority.sql"
        ).read_text(encoding="utf-8"))

    def test_behavior_covers_seven_pairs_failure_restart_and_tamper(self):
        behavior = BEHAVIOR.read_text(encoding="utf-8")
        for pair in ("EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"):
            self.assertIn(pair, behavior)
        for marker in (
            "explicit quote-to-USD direction and no hidden cross",
            "stale, missing, ambiguous, scope-mismatched, and corrupt inputs",
            "recovers interrupted work, survives restart, and rejects config/result tamper",
            "blocks registry drift instead of accepting caller-selected cost assumptions",
            "openDatabase({ databasePath: env.databasePath, mustExist: true })",
        ):
            self.assertIn(marker, behavior)

    def test_migration_count_and_order_are_twelve(self):
        migrations = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            match = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if match:
                migrations.append(f"{match.group(1)}_{match.group(2)}")
                self.assertTrue(MIGRATIONS.joinpath(f"{path.stem}.down.sql").is_file())
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
                if relative not in {"backend/src/app/api/backtest/runs/route.ts", "tests/test_r16_paper_input_resolution_contracts.py"}:
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
        self.assertEqual(authority["repository"]["baselineCommit"],
                         "87743915140e21a1220139364a7291aa2601b229")
        self.assertEqual(authority["authority"]["migrationCount"], 12)
        self.assertEqual(authority["finalGate"]["summary"], {
            "total": 15, "pass": 15, "fail": 0, "timeout": 0,
            "environmentBlocked": 0, "skipped": 0, "planned": 0,
        })
        self.assertEqual(authority["preservation"]["m48HashVerification"], "pass")
        self.assertTrue(all(value is False for value in authority["safety"].values()))

    def test_next_stops_at_r18_and_requires_fresh_authorization(self):
        text = NEXT.read_text(encoding="utf-8")
        self.assertIn("Current completed unit: **R1.10", text)
        self.assertIn("Next planned unit: **R1.11", text)
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertIn("Otorisasi implementasi HANYA R1.11", text)
        self.assertIn("Do not infer R1.12", text)


if __name__ == "__main__":
    unittest.main()
