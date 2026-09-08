"""P01-03 database foundation contract tests.

Covers: migration file/ledger conventions, the bootstrap script contract
(secret-free, destructive reset gated), env template parity (FDB_DB_* names),
the compose isolation contract, and — when Docker and the fdbtrade database
are available — a live lifecycle check (idempotent re-migrate, rollback,
re-apply). Live checks self-skip with a clear reason when the database is not
reachable (e.g. CI clean rooms without Docker).

Pure Python stdlib ``unittest``. Deterministic for deterministic inputs. All
internal timestamps are UTC (ADR-0004).
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
MIGRATIONS = BACKEND / "db" / "migrations"
DB = BACKEND / "src" / "db"
BOOTSTRAP = REPO_ROOT / "scripts" / "db-bootstrap.sh"
ENV_TEMPLATE = REPO_ROOT / "infra" / ".env.example"
COMPOSE = REPO_ROOT / "infra" / "compose.yaml"

MIGRATION_UP_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
LEDGER_DDL = "public.schema_migrations"


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def run(cmd, cwd=None, timeout=120, env=None):
    return subprocess.run(
        cmd,
        cwd=cwd or REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )


def load_env_file(path: pathlib.Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key] = value
    return env


class MigrationFileContract(unittest.TestCase):
    """Static conventions for on-disk migrations (ADR-0007)."""

    def test_migrations_directory_exists_and_has_files(self):
        self.assertTrue(MIGRATIONS.is_dir(), "missing db/migrations directory")
        files = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
        self.assertTrue(files, "no migration files found")
        for name in files:
            if name.endswith(".down.sql"):
                continue
            with self.subTest(name=name):
                self.assertRegex(name, r"^\d{4}_[a-z0-9_]+\.sql$")

    def test_every_up_migration_name_is_lexically_ordered_and_unique(self):
        ids = []
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name.endswith(".down.sql"):
                continue
            match = MIGRATION_UP_PATTERN.match(path.name)
            self.assertIsNotNone(match, f"bad migration name: {path.name}")
            ids.append(match.group(1))
        self.assertEqual(ids, sorted(ids), "migration ids must be ascending")
        self.assertEqual(len(ids), len(set(ids)), "migration ids must be unique")

    def test_foundation_migration_establishes_conventions(self):
        text = (MIGRATIONS / "0001_foundation.sql").read_text(encoding="utf-8")
        self.assertIn("CREATE SCHEMA IF NOT EXISTS fdb", text)
        self.assertIn("timestamptz", text)
        # The ledger is runner-owned: migrations must not create/alter it.
        self.assertNotIn("CREATE TABLE IF NOT EXISTS public.schema_migrations", text)
        self.assertNotIn("CREATE TABLE public.schema_migrations", text)

    def test_foundation_down_migration_reverses_it(self):
        text = (MIGRATIONS / "0001_foundation.down.sql").read_text(
            encoding="utf-8"
        )
        self.assertIn("DROP SCHEMA IF EXISTS fdb", text)
        # Rollbacks must never touch the runner-owned ledger.
        self.assertNotIn("DROP TABLE IF EXISTS public.schema_migrations", text)
        self.assertNotIn("DELETE FROM public.schema_migrations", text)
        self.assertNotIn("TRUNCATE public.schema_migrations", text)

    def test_no_business_tables_beyond_foundation(self):
        """Foundation must stay foundation-only (no unstable business schema)."""
        ups = [
            p
            for p in MIGRATIONS.glob("*.sql")
            if not p.name.endswith(".down.sql")
        ]
        self.assertEqual(
            [p.name for p in ups],
            ["0001_foundation.sql"],
            "P01-03 must not add business migrations",
        )


class BootstrapAndInfraContract(unittest.TestCase):
    """scripts/db-bootstrap.sh, infra/compose.yaml, .env.example parity."""

    def test_bootstrap_script_exists_and_is_syntax_valid(self):
        self.assertTrue(BOOTSTRAP.is_file())
        result = run(["bash", "-n", str(BOOTSTRAP)])
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_bootstrap_never_prints_the_password_value(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        # The generated password is written to .env but never echoed.
        self.assertIn("value not shown", text)
        self.assertNotIn("echo $password", text)

    def test_bootstrap_reset_requires_yes(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("--yes", text)
        self.assertIn("reset --yes", text)

    def test_compose_project_is_isolated_and_has_no_default_credentials(self):
        text = COMPOSE.read_text(encoding="utf-8")
        self.assertIn("name: fdbtrade", text)
        self.assertIn("image: postgres:16", text)
        self.assertIn("127.0.0.1:${FDB_DB_PORT", text)
        # Missing env vars must fail loudly, not fall back to weak defaults.
        self.assertIn("?FDB_DB_PASSWORD is required", text)
        # Isolation: the compose file must not reference external containers.
        self.assertNotIn("network_mode: host", text)
        self.assertNotIn("external: true", text)

    def test_env_template_declares_the_full_db_contract(self):
        text = ENV_TEMPLATE.read_text(encoding="utf-8")
        for name in (
            "FDB_DB_HOST",
            "FDB_DB_PORT",
            "FDB_DB_NAME",
            "FDB_DB_USER",
            "FDB_DB_PASSWORD",
            "FDB_DB_POOL_SIZE",
            "FDB_DB_SSL_MODE",
        ):
            self.assertIn(f"{name}=", text, f"missing {name} in template")

    def test_env_template_port_matches_backend_default(self):
        template = load_env_file(ENV_TEMPLATE)
        self.assertEqual(template["FDB_DB_PORT"], "15432")
        pkg = load_json(BACKEND / "package.json")
        self.assertIn("db:migrate", pkg["scripts"])
        self.assertIn("pg", pkg["dependencies"])

    def test_migrate_cli_never_logs_credentials(self):
        text = (DB / "migrate.mjs").read_text(encoding="utf-8")
        self.assertNotIn("console.log(password", text)
        self.assertNotIn("console.log(config", text)
        self.assertIn("cannot connect to database (code:", text)


class DbClientContract(unittest.TestCase):
    """backend/src/db/client.ts static safety contract."""

    def test_client_is_server_only(self):
        text = (DB / "client.ts").read_text(encoding="utf-8")
        self.assertIn("assertServerOnly()", text)

    def test_client_never_builds_connection_strings(self):
        text = (DB / "client.ts").read_text(encoding="utf-8")
        self.assertNotIn("postgres://", text)
        self.assertNotIn("postgresql://", text)

    def test_health_route_reports_database_check(self):
        text = (BACKEND / "src/app/api/health/route.ts").read_text("utf-8")
        self.assertIn("checkDatabaseHealth", text)
        self.assertIn('"degraded"', text)


class LiveDatabaseLifecycleTest(unittest.TestCase):
    """
    Live lifecycle against the local fdbtrade database (self-skipping).

    Requires: docker daemon, the fdbtrade-postgres container running, and a
    repository .env with credentials. Exercises the real runner CLI end to
    end: idempotent re-migrate, rollback, re-apply. On a CI clean room without
    Docker or a database, the class self-skips with a clear reason.
    """

    @classmethod
    def setUpClass(cls):
        if not (REPO_ROOT / ".env").exists():
            raise unittest.SkipTest("no .env; run `make db-up` for live checks")
        if run(["docker", "inspect", "fdbtrade-postgres"]).returncode != 0:
            raise unittest.SkipTest(
                "fdbtrade-postgres container not running; run `make db-up`"
            )
        cls.env = {**os.environ, **load_env_file(REPO_ROOT / ".env")}

    def _runner(self, command: str):
        result = run(
            [
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "run",
                f"db:{command}",
            ],
            env=self.env,
            timeout=180,
        )
        return result

    def test_full_lifecycle_migrate_idempotent_rollback_reapply(self):
        # Idempotency: whatever the current state, migrate is safe.
        first = self._runner("status")
        self.assertEqual(first.returncode, 0, msg=first.stdout + first.stderr)

        migrate_once = self._runner("migrate")
        self.assertEqual(
            migrate_once.returncode,
            0,
            msg=migrate_once.stdout + migrate_once.stderr,
        )
        self.assertRegex(migrate_once.stdout, r"applied=\d+")

        # Re-migrate: nothing pending, still exit 0.
        migrate_twice = self._runner("migrate")
        self.assertEqual(migrate_twice.returncode, 0)
        self.assertIn("applied=0", migrate_twice.stdout)

        # Rollback removes the migration from the ledger and schema.
        rollback = self._runner("rollback")
        self.assertEqual(rollback.returncode, 0, msg=rollback.stdout)
        self.assertIn("rolled back 0001_foundation", rollback.stdout)

        # Re-apply restores the applied state.
        reapply = self._runner("migrate")
        self.assertEqual(reapply.returncode, 0, msg=reapply.stdout)
        self.assertIn("applied 0001_foundation", reapply.stdout)

        status = self._runner("status")
        self.assertIn("applied  0001_foundation", status.stdout)

    def test_wrong_password_fails_explicitly_without_leaking_secret(self):
        wrong = {
            **self.env,
            "FDB_DB_PASSWORD": "definitely-not-the-password",
            "FDB_DB_PORT": "1",
        }
        result = run(
            [
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "run",
                "db:status",
            ],
            env=wrong,
            timeout=60,
        )
        self.assertNotEqual(result.returncode, 0)
        combined = result.stdout + result.stderr
        self.assertIn("cannot connect to database", combined)
        self.assertNotIn("definitely-not-the-password", combined)


if __name__ == "__main__":
    unittest.main()
