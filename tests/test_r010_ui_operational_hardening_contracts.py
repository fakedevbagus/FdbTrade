"""R0.10 UI reconciliation and hermetic operational recovery contracts."""

from __future__ import annotations

import json
import hashlib
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "backend/db/sqlite-migrations/0009_operational_hardening.sql"
OPERATIONS = ROOT / "backend/src/operations/operationalAuthority.ts"
OVERVIEW_ROUTE = ROOT / "backend/src/app/api/operations/overview/route.ts"
CONTROLS_ROUTE = ROOT / "backend/src/app/api/admin/controls/route.ts"
HEALTH = ROOT / "backend/src/obs/healthService.ts"
UI = ROOT / "frontend/src/app/(app)/operations/page.tsx"
NAV = ROOT / "frontend/src/lib/site-config.ts"
CLI = ROOT / "scripts/operational-data.mjs"


def run(*args: str, env: dict[str, str] | None = None, timeout: int = 180):
    return subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class R010StaticContracts(unittest.TestCase):
    def test_operational_events_are_durable_append_only_evidence(self):
        migration = MIGRATION.read_text("utf-8")
        for marker in (
            "CREATE TABLE operational_events",
            "backup_created",
            "restore_verified",
            "deployment_drill_verified",
            "operational_events_sequence_guard",
            "operational_events_no_update",
            "operational_events_no_delete",
        ):
            self.assertIn(marker, migration)

    def test_overview_reads_existing_authority_and_keeps_safety_off(self):
        source = OPERATIONS.read_text("utf-8")
        for table in (
            "market_data_datasets",
            "signal_evaluation_runs",
            "signal_candidates",
            "research_backtest_runs",
            "risk_state_events",
            "risk_paper_runs",
            "risk_decisions",
            "paper_outcomes",
            "paper_reconciliation_reports",
            "operational_events",
        ):
            self.assertIn(table, source)
        for marker in (
            'liveExecutionEnabled: false',
            'providerOrderTransportEnabled: false',
            'modelPromotionAuthority: false',
            'uiAuthority: false',
        ):
            self.assertIn(marker, source)
        self.assertIn("requireSession", OVERVIEW_ROUTE.read_text("utf-8"))

    def test_kill_and_health_use_r09_sqlite_latch_not_process_store(self):
        controls = CONTROLS_ROUTE.read_text("utf-8")
        health = HEALTH.read_text("utf-8")
        self.assertIn("RiskPaperAuthority", controls)
        self.assertIn("risk_state_events", health)
        self.assertNotIn("riskStateStore", controls)
        self.assertNotIn("riskStateStore", health)
        self.assertNotIn("toggle_feature_flag", controls)
        self.assertNotIn("publish_artifact", controls)

    def test_navigation_points_to_authoritative_operational_surface(self):
        nav = NAV.read_text("utf-8")
        page = UI.read_text("utf-8")
        self.assertIn('href: "/operations"', nav)
        self.assertNotIn('href: "/scanner"', nav)
        self.assertNotIn('href: "/dashboard"', nav)
        self.assertIn("The UI is not authority", page)
        self.assertIn("Historical evidence only; never signal confidence", page)
        self.assertNotIn("Submit order", page)

    def test_operational_cli_has_no_external_service_or_provider_path(self):
        source = CLI.read_text("utf-8").lower()
        for forbidden in (
            "postgres",
            "redis",
            "docker",
            "providers/shadow",
            "http://",
            "https://",
            "submitorder",
        ):
            self.assertNotIn(forbidden, source)


class R010BackupRestoreBehavior(unittest.TestCase):
    def test_backup_restore_and_deployment_drill_are_verified_and_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r010-test-") as temporary:
            root = pathlib.Path(temporary)
            source = root / "source"
            backups = root / "backups"
            restored = root / "restored"

            init = run(
                "node", str(CLI), "init-drill-fixture", "--data-root", str(source)
            )
            self.assertEqual(init.returncode, 0, init.stdout + init.stderr)

            content = b"immutable-r010-candle-evidence\n"
            digest = hashlib.sha256(content).hexdigest()
            relative = pathlib.Path("sha256") / digest[:2] / f"{digest}.candles"
            artifact = source / "artifacts" / "market-data" / relative
            artifact.parent.mkdir(parents=True)
            artifact.write_bytes(content)
            with sqlite3.connect(source / "fdbtrade.sqlite3") as database:
                database.execute(
                    """INSERT INTO market_data_artifacts
                       (digest, relative_path, byte_count, media_type, created_at_utc)
                       VALUES (?, ?, ?, 'application/vnd.fdbtrade.candles', ?)""",
                    (digest, str(relative), len(content), "2026-09-23T00:00:00.000Z"),
                )
                database.commit()

            backup = run(
                "node",
                str(CLI),
                "backup",
                "--data-root",
                str(source),
                "--output-root",
                str(backups),
            )
            self.assertEqual(backup.returncode, 0, backup.stdout + backup.stderr)
            backup_result = json.loads(backup.stdout.strip().splitlines()[-1])
            backup_dir = pathlib.Path(backup_result["backupDirectory"])
            manifest = json.loads((backup_dir / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertEqual(manifest["workUnit"], "R0.11")
            self.assertEqual(
                manifest["integrityClaim"],
                "sha256-integrity-evidence-not-cryptographic-authenticity",
            )
            self.assertEqual(
                manifest["database"]["migrations"][-1]["id"],
                "0011_robustness_selection_bias_authority",
            )
            self.assertFalse(manifest["safety"]["liveExecutionEnabled"])
            self.assertFalse(manifest["safety"]["providerOrderTransportEnabled"])
            self.assertEqual(manifest["artifacts"][0]["digest"], digest)

            restore = run(
                "node",
                str(CLI),
                "restore",
                "--backup",
                str(backup_dir),
                "--target-data-root",
                str(restored),
            )
            self.assertEqual(restore.returncode, 0, restore.stdout + restore.stderr)
            with sqlite3.connect(restored / "fdbtrade.sqlite3") as database:
                self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                events = database.execute(
                    "SELECT event_type FROM operational_events ORDER BY sequence_no"
                ).fetchall()
                self.assertEqual(events[-1][0], "restore_verified")
            self.assertEqual(
                (restored / "artifacts" / "market-data" / relative).read_bytes(),
                content,
            )

            second_restore = run(
                "node",
                str(CLI),
                "restore",
                "--backup",
                str(backup_dir),
                "--target-data-root",
                str(restored),
            )
            self.assertNotEqual(second_restore.returncode, 0)
            self.assertIn("restore target must be empty", second_restore.stderr)

            drill = run(
                "node", str(CLI), "drill", "--data-root", str(source), timeout=240
            )
            self.assertEqual(drill.returncode, 0, drill.stdout + drill.stderr)
            self.assertEqual(json.loads(drill.stdout.strip().splitlines()[-1])["status"], "passed")
            with sqlite3.connect(source / "fdbtrade.sqlite3") as database:
                event_types = [
                    row[0]
                    for row in database.execute(
                        "SELECT event_type FROM operational_events ORDER BY sequence_no"
                    )
                ]
                self.assertIn("backup_created", event_types)
                self.assertIn("deployment_drill_verified", event_types)

    def test_restore_rejects_tampered_database(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r010-tamper-") as temporary:
            root = pathlib.Path(temporary)
            source = root / "source"
            backups = root / "backups"
            self.assertEqual(
                run("node", str(CLI), "init-drill-fixture", "--data-root", str(source)).returncode,
                0,
            )
            backup = run(
                "node", str(CLI), "backup", "--data-root", str(source),
                "--output-root", str(backups),
            )
            self.assertEqual(backup.returncode, 0, backup.stdout + backup.stderr)
            backup_dir = pathlib.Path(json.loads(backup.stdout.strip().splitlines()[-1])["backupDirectory"])
            database_file = backup_dir / "fdbtrade.sqlite3"
            with database_file.open("ab") as handle:
                handle.write(b"tamper")
            restore = run(
                "node", str(CLI), "restore", "--backup", str(backup_dir),
                "--target-data-root", str(root / "restored"),
            )
            self.assertNotEqual(restore.returncode, 0)
            self.assertIn("digest or size mismatch", restore.stderr)


if __name__ == "__main__":
    unittest.main()
