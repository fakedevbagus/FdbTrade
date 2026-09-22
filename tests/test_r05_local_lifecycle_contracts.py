"""R0.5 local application/runtime lifecycle contracts."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "scripts" / "fdbtrade"


def load_cli():
    loader = importlib.machinery.SourceFileLoader("fdbtrade_r05_cli", str(CLI))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class LocalLifecycleContracts(unittest.TestCase):
    def test_frontend_and_backend_scripts_pin_loopback_and_ports(self):
        backend = json.loads((ROOT / "backend" / "package.json").read_text())
        frontend = json.loads((ROOT / "frontend" / "package.json").read_text())
        for script in (backend["scripts"]["dev"], backend["scripts"]["start"]):
            self.assertIn("-H 127.0.0.1", script)
            self.assertIn("-p 3100", script)
        for script in (frontend["scripts"]["dev"], frontend["scripts"]["start"]):
            self.assertIn("-H 127.0.0.1", script)
            self.assertIn("-p 3000", script)

    def test_status_json_is_truthful_when_everything_is_absent(self):
        with tempfile.TemporaryDirectory() as root:
            env = {**os.environ, "FDB_DATA_ROOT": root}
            result = subprocess.run(
                ["python3", str(CLI), "status", "--json"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "stopped")
            self.assertFalse(payload["frontend"]["reachable"])
            self.assertFalse(payload["backend"]["reachable"])
            self.assertFalse(payload["database"]["initialized"])
            self.assertEqual(payload["database"]["authority"], "sqlite")

    def test_stop_refuses_corrupt_ownership_state_without_signalling(self):
        module = load_cli()
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"FDB_DATA_ROOT": root}
        ):
            run_dir = pathlib.Path(root) / "run"
            run_dir.mkdir()
            (run_dir / "lifecycle.json").write_text("not-json", encoding="utf-8")
            with mock.patch.object(module.os, "killpg") as killpg:
                self.assertEqual(module.stop(), 1)
                killpg.assert_not_called()

    def test_pid_reuse_is_rejected_by_start_token(self):
        module = load_cli()
        with mock.patch.object(module, "_process_start_token", return_value="new-token"):
            self.assertFalse(
                module._record_is_live({"pid": 123, "startToken": "old-token"})
            )

    def test_make_start_uses_the_single_operator_lifecycle(self):
        makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
        self.assertRegex(makefile, r"(?m)^start:\n\tpython3 scripts/fdbtrade start$")

    def test_start_coordinates_both_processes_before_reporting_ready(self):
        module = load_cli()
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"FDB_DATA_ROOT": root}
        ):
            (pathlib.Path(root) / "fdbtrade.sqlite3").touch()
            spawned = []

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    self.pid = 1000 + len(spawned)
                    spawned.append(command)

            def record(proc, role, port):
                return {
                    "role": role,
                    "pid": proc.pid,
                    "pgid": proc.pid,
                    "startToken": f"token-{role}",
                    "port": port,
                }

            with (
                mock.patch.object(module, "_port_is_in_use", return_value=False),
                mock.patch.object(module, "_pids_listening_on", return_value=[]),
                mock.patch.object(module.subprocess, "Popen", side_effect=FakeProcess),
                mock.patch.object(module, "_record_process", side_effect=record),
                mock.patch.object(module, "_record_is_live", return_value=True),
                mock.patch.object(module, "_backend_probe", return_value={"ready": True}),
                mock.patch.object(module, "_frontend_probe", return_value={"ready": True}),
            ):
                self.assertEqual(module.start(), 0)

            self.assertEqual(len(spawned), 2)
            self.assertIn("@fdbtrade/backend", spawned[0])
            self.assertIn("@fdbtrade/frontend", spawned[1])
            state = json.loads(
                (pathlib.Path(root) / "run" / "lifecycle.json").read_text()
            )
            self.assertEqual(state["phase"], "running")
            self.assertEqual([item["role"] for item in state["processes"]], ["backend", "frontend"])


class RuntimeAuthorityContracts(unittest.TestCase):
    def test_sqlite_migration_owns_all_runtime_state(self):
        migration = (
            ROOT / "backend" / "db" / "sqlite-migrations" / "0004_runtime_lifecycle.sql"
        ).read_text(encoding="utf-8")
        for table in (
            "runtime_locks",
            "runtime_cycles",
            "runtime_checkpoints",
            "runtime_completions",
            "runtime_dedupe",
        ):
            self.assertIn(f"CREATE TABLE {table}", migration)
        self.assertIn("STRICT", migration)

    def test_legacy_postgres_lock_adapter_is_removed(self):
        lock = (ROOT / "backend" / "src" / "runtime" / "lock.ts").read_text()
        for forbidden in (
            "PostgresAdvisoryProcessLock",
            "pg_try_advisory_lock",
            "pg_advisory_unlock",
        ):
            self.assertNotIn(forbidden, lock)

    def test_health_reads_runtime_facts_from_sqlite(self):
        health = (ROOT / "backend" / "src" / "app" / "api" / "health" / "route.ts").read_text()
        self.assertIn("readRuntimePersistenceHealth", health)
        self.assertIn('authority: "sqlite"', health)
        self.assertIn("checkpointIntegrity", health)

    def test_runtime_startup_uses_sqlite_store_and_process_lock(self):
        startup = (ROOT / "backend" / "src" / "runtime" / "startup.ts").read_text()
        self.assertIn("SqliteRuntimeStore", startup)
        self.assertIn("SqliteProcessLock", startup)
        self.assertIn("getDatabase()", startup)


if __name__ == "__main__":
    unittest.main()
