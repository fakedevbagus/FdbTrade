"""R0.3 reproducible toolchain behavior and wiring contracts."""

from __future__ import annotations

import importlib.util
import importlib.machinery
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNNER = REPO_ROOT / "scripts" / "rebuild_toolchain.py"
OPERATOR_CLI = REPO_ROOT / "scripts" / "fdbtrade"


def load_runner():
    spec = importlib.util.spec_from_file_location("rebuild_toolchain", RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load rebuild toolchain")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_operator_cli():
    loader = importlib.machinery.SourceFileLoader("r03_fdbtrade_cli", str(OPERATOR_CLI))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("could not load operator CLI")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class IsolatedEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()

    def test_cache_environment_is_explicit_and_does_not_mutate_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "cache"
            original = dict(os.environ)
            env = self.runner.toolchain_env(root)

            self.assertEqual(os.environ, original)
            self.assertEqual(env["COREPACK_HOME"], str(root / "corepack"))
            self.assertEqual(env["PNPM_HOME"], str(root / "pnpm-home"))
            self.assertEqual(env["NPM_CONFIG_CACHE"], str(root / "npm"))
            self.assertEqual(env["XDG_CACHE_HOME"], str(root / "xdg"))
            for key in ("COREPACK_HOME", "PNPM_HOME", "NPM_CONFIG_CACHE", "XDG_CACHE_HOME"):
                self.assertTrue(env[key].startswith(str(root)))

    def test_dry_run_does_not_create_cache_and_reports_every_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            cache = root / "cache"
            output = root / "gate.json"
            env = {**os.environ, "FDB_TOOLCHAIN_CACHE_DIR": str(cache)}
            result = subprocess.run(
                [
                    sys.executable,
                    str(RUNNER),
                    "--dry-run",
                    "--json",
                    "--output",
                    str(output),
                    "gate",
                ],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload, json.loads(output.read_text(encoding="utf-8")))
            self.assertEqual(payload["status"], "planned")
            self.assertFalse(payload["cache"]["dependsOnOperatorHome"])
            self.assertFalse(cache.exists(), "dry-run must not create cache directories")
            self.assertTrue(payload["results"])
            self.assertTrue(all(item["status"] == "planned" for item in payload["results"]))
            self.assertTrue(all(item["timeoutSeconds"] > 0 for item in payload["results"]))


class DiagnosticClassificationTests(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()

    def _spec(self, code: str, timeout: int = 2):
        return self.runner.CommandSpec(
            stage="test",
            name="fixture",
            argv=(sys.executable, "-c", code),
            cwd=REPO_ROOT,
            timeout_seconds=timeout,
        )

    def test_pass_and_failure_are_distinct(self):
        env = dict(os.environ)
        passed = self.runner.run_command(self._spec("print('ok')"), env)
        failed = self.runner.run_command(
            self._spec("import sys; print('fatal: fixture', file=sys.stderr); sys.exit(7)"),
            env,
        )

        self.assertEqual((passed["status"], passed["exitCode"]), ("pass", 0))
        self.assertEqual((failed["status"], failed["exitCode"]), ("fail", 7))
        self.assertIn("fatal: fixture", failed["firstActionableFailure"])

    def test_timeout_is_never_reported_as_pass(self):
        timed_out = self.runner.run_command(
            self._spec("import time; time.sleep(2)", timeout=1),
            dict(os.environ),
        )
        self.assertEqual(timed_out["status"], "timeout")
        self.assertEqual(timed_out["exitCode"], 124)
        self.assertIn("timed out", timed_out["firstActionableFailure"])

    def test_successful_process_with_skipped_tests_is_not_pass(self):
        skipped = self.runner.run_command(
            self._spec("print('OK (skipped=2)')"),
            dict(os.environ),
        )
        self.assertEqual(skipped["status"], "skipped")
        self.assertEqual(skipped["exitCode"], 0)
        self.assertIn("skipped is not pass", skipped["firstActionableFailure"])

    def test_preflight_socket_restriction_still_returns_json(self):
        cli = load_operator_cli()
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(
            cli.socket, "socket", side_effect=PermissionError("socket denied")
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exit_code = cli.preflight(as_json=True)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "warn")
        self.assertEqual(
            set(payload["checks"]["ports"].values()), {"probe_unavailable"}
        )
        self.assertTrue(any("socket probe unavailable" in item for item in payload["warnings"]))


class WiringContractTests(unittest.TestCase):
    def test_make_and_ci_share_one_complete_gate(self):
        makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
        workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("toolchain-gate:", makefile)
        self.assertIn("rebuild_toolchain.py", makefile)
        self.assertIn("make toolchain-gate", workflow)
        self.assertIn("timeout-minutes:", workflow)
        self.assertNotIn("continue-on-error", workflow)

    def test_package_manager_is_exactly_pinned(self):
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertRegex(package["packageManager"], r"^pnpm@\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
