"""R0.4 SQLite authority and hermetic lifecycle contracts."""

from __future__ import annotations

import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
MIGRATIONS = BACKEND / "db" / "sqlite-migrations"
DB = BACKEND / "src" / "db"
ENV_TEMPLATE = REPO_ROOT / "infra" / ".env.example"
MIGRATION_UP_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")


def run(cmd, *, env=None, timeout=120):
    return subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )


class MigrationFileContract(unittest.TestCase):
    def test_active_migrations_are_ordered_unique_and_reversible(self):
        self.assertTrue(MIGRATIONS.is_dir())
        ups = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name.endswith(".down.sql"):
                continue
            match = MIGRATION_UP_PATTERN.match(path.name)
            self.assertIsNotNone(match, f"bad migration name: {path.name}")
            ups.append(path.stem)
            self.assertTrue(
                MIGRATIONS.joinpath(f"{path.stem}.down.sql").is_file(),
                f"missing down migration for {path.name}",
            )
        self.assertEqual(
            ups,
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
                "0011_robustness_selection_bias_authority",
            ],
        )

    def test_sqlite_schema_encodes_single_user_and_append_only_audit(self):
        auth = MIGRATIONS.joinpath("0002_auth_foundation.sql").read_text("utf-8")
        audit = MIGRATIONS.joinpath("0003_audit_authority.sql").read_text("utf-8")
        self.assertIn("singleton_key", auth)
        self.assertIn("CHECK(singleton_key = 1)", auth)
        self.assertIn("token_hash", auth)
        self.assertIn("audit_events_no_update", audit)
        self.assertIn("audit_events_no_delete", audit)
        self.assertIn("audit_events_chronology", audit)

    def test_legacy_postgres_migrations_are_not_active_authority(self):
        runner = DB.joinpath("sqlite.mjs").read_text("utf-8")
        self.assertIn('"sqlite-migrations"', runner)
        self.assertNotIn('"migrations",', runner)
        self.assertNotIn('from "pg"', runner)


class ConfigurationContract(unittest.TestCase):
    def test_env_template_declares_only_local_sqlite_state(self):
        text = ENV_TEMPLATE.read_text("utf-8")
        self.assertIn("FDB_DATA_ROOT=", text)
        self.assertIn("FDB_SQLITE_BUSY_TIMEOUT_MS=", text)
        self.assertNotIn("FDB_DB_", text)
        self.assertNotIn("FDB_CACHE_", text)

    def test_backend_has_no_postgres_runtime_dependency(self):
        package = json.loads(BACKEND.joinpath("package.json").read_text("utf-8"))
        self.assertNotIn("pg", package["dependencies"])
        self.assertNotIn("@types/pg", package["devDependencies"])
        self.assertIn("db:migrate", package["scripts"])

    def test_client_is_server_only_and_has_no_network_database_config(self):
        text = DB.joinpath("client.ts").read_text("utf-8")
        self.assertIn("assertServerOnly()", text)
        self.assertIn("node:sqlite", text)
        for forbidden in ("postgres://", "FDB_DB_HOST", "FDB_DB_PASSWORD", "Pool"):
            self.assertNotIn(forbidden, text)


class HermeticLifecycleTest(unittest.TestCase):
    def _runner(self, command: str, data_root: pathlib.Path):
        env = {**os.environ, "FDB_DATA_ROOT": str(data_root)}
        return run(
            [
                "corepack",
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "run",
                f"db:{command}",
            ],
            env=env,
            timeout=180,
        )

    def test_zero_to_migrate_idempotent_rollback_reapply_without_external_state(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r04-") as tmp:
            root = pathlib.Path(tmp) / "data"
            first = self._runner("migrate", root)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertIn("applied=11", first.stdout)

            second = self._runner("migrate", root)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("applied=0", second.stdout)

            rollback = self._runner("rollback", root)
            self.assertEqual(rollback.returncode, 0, rollback.stdout + rollback.stderr)
            self.assertIn("rolled back 0011_robustness_selection_bias_authority", rollback.stdout)

            reapply = self._runner("migrate", root)
            self.assertEqual(reapply.returncode, 0, reapply.stdout + reapply.stderr)
            self.assertIn("applied 0011_robustness_selection_bias_authority", reapply.stdout)

            database_path = root / "fdbtrade.sqlite3"
            self.assertTrue(database_path.is_file())
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(database_path.stat().st_mode), 0o600)
            with sqlite3.connect(database_path) as database:
                applied = database.execute(
                    "SELECT id FROM schema_migrations ORDER BY id"
                ).fetchall()
                self.assertEqual(len(applied), 11)
                self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_relative_data_root_fails_closed_without_creating_state(self):
        env = {**os.environ, "FDB_DATA_ROOT": "relative/data"}
        result = run(
            [
                "corepack",
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "run",
                "db:status",
            ],
            env=env,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FDB_DATA_ROOT must be an absolute path", result.stderr)


if __name__ == "__main__":
    unittest.main()
