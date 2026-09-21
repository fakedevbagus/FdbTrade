"""P00-02 skeleton contract tests.

Verifies deterministic root entry points and placeholder-package contracts.
Pure Python stdlib; deterministic for deterministic inputs. All internal
timestamps referenced are UTC per the workspace contract.
"""

from __future__ import annotations

import contextlib
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOLCHAIN = REPO_ROOT / "scripts" / "rebuild_toolchain.py"

REQUIRED_DIRS = (
    "frontend",
    "backend",
    "contracts",
    "quant",
    "scripts",
    "tests",
    "docs",
    "docs/adr",
    "infra",
)

REQUIRED_ROOT_FILES = (
    ".gitignore",
    "CONTRIBUTING.md",
    "Makefile",
    "OWNERS.md",
    "README.md",
    "package.json",
    "pnpm-workspace.yaml",
)

MAKEFILE_TARGETS = (
    "help",
    "install",
    "lint",
    "typecheck",
    "test",
    "build",
    "start",
    "check",
)

# P01-01/P01-02: frontend and backend are now implemented packages (Next.js
# application shell / typed API foundation). P02-01: contracts is now a real
# shared-contracts package (canonical market-data model). The placeholder
# contract below applies to no current package; it is kept as a guard for any
# future placeholder area.
WORKSPACE_MEMBERS = ("frontend", "backend", "contracts")

PLACEHOLDER_PACKAGES: tuple[str, ...] = ()

PLACEHOLDER_SCRIPTS = ("lint", "typecheck", "test", "build", "start")

ROOT_SCRIPTS = ("lint", "typecheck", "test", "build", "start", "check")

ALLOWED_PLACEHOLDER_FILES = frozenset({"README.md", "package.json"})


def read_json(path: pathlib.Path) -> dict[str, object]:
    """Read a JSON file. Raises FileNotFoundError / json.JSONDecodeError on bad input."""
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate_placeholder_package(pkg: dict[str, object]) -> list[str]:
    """Return a list of placeholder-package contract violations (empty list means valid.."""
    errors: list[str] = []
    name = pkg.get("name")
    if not isinstance(name, str) or not name.startswith("@fdbtrade/"):
        errors.append("name must be a string scoped under @fdbtrade/")
    if pkg.get("private") is not True:
        errors.append("private must be true")
    if pkg.get("version") != "0.0.0":
        errors.append("version must be 0.0.0 (placeholder")
    scripts = pkg.get("scripts")
    if not isinstance(scripts, dict):
        errors.append("scripts must be an object")
    else:
        for script in PLACEHOLDER_SCRIPTS:
            value = scripts.get(script)
            if not isinstance(value, str) or not value:
                errors.append(f"script {script!r} must be a non-empty string")
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        if pkg.get(key):
            errors.append(f"placeholder packages must not declare {key}")
    return errors


class WorkspaceContractTests(unittest.TestCase):
    """Valid-input contract checks against the live skeleton."""

    def test_required_directories_exist(self):
        for rel in REQUIRED_DIRS:
            with self.subTest(rel=rel):
                self.assertTrue((REPO_ROOT / rel).is_dir(), f"missing required directory: {rel}")

    def test_required_root_files_exist(self):
        for name in REQUIRED_ROOT_FILES:
            with self.subTest(name=name):
                self.assertTrue((REPO_ROOT / name).exists(), f"missing required root file: {name}")

    def test_root_package_json_contract(self):
        pkg = read_json(REPO_ROOT / "package.json")
        self.assertIs(pkg.get("private"), True)
        self.assertEqual(pkg.get("packageManager"), "pnpm@11.22.0")
        engines = pkg.get("engines")
        self.assertIsInstance(engines, dict)
        self.assertEqual(engines.get("node"), ">=24.0.0")
        self.assertEqual(engines.get("pnpm"), ">=11.0.0")
        scripts = pkg.get("scripts")
        self.assertIsInstance(scripts, dict)
        for script in ROOT_SCRIPTS:
            with self.subTest(script=script):
                self.assertIn(script, scripts)

    def test_pnpm_workspace_declares_workspace_members(self):
        text = (REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8")
        for member in WORKSPACE_MEMBERS:
            with self.subTest(member=member):
                self.assertIn(f"- {member}", text, f"workspace must declare member: {member}")

    def test_makefile_exposes_required_targets(self):
        text = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
        for target in MAKEFILE_TARGETS:

            with self.subTest(target=target):
                self.assertRegex(text, rf"(?m)^{re.escape(target)}:", f"Makefile must declare target: {target}")

    def test_placeholder_package_contracts(self):
        for rel in PLACEHOLDER_PACKAGES:

            pkg = read_json(REPO_ROOT / rel / "package.json")
            violations = validate_placeholder_package(pkg)
            with self.subTest(pkg=rel):
                self.assertEqual(violations, [], f"placeholder package violates contract: {violations}")

    def test_placeholder_packages_contain_no_business_logic(self):
        for rel in PLACEHOLDER_PACKAGES:

            pkg_root = REPO_ROOT / rel
            files = sorted(p for p in pkg_root.rglob("*") if p.is_file())
            with self.subTest(pkg=rel):
                self.assertTrue(files, f"placeholder package {rel} must contain README + package.json")
            for path in files:
                with self.subTest(pkg=rel, file=str(path.relative_to(REPO_ROOT))):
                    self.assertIn(path.name, ALLOWED_PLACEHOLDER_FILES,
                        f"unexpected file in placeholder package: {path.relative_to(REPO_ROOT)}")


class EntryPointExecutionTests(unittest.TestCase):
    """Root entry points dispatch to bounded, executable commands."""

    def _run_make(self, target: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["make", target],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )

    def test_make_help_lists_required_targets(self):
        result = self._run_make("help")
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Available targets", result.stdout)
        self.assertIn("make check", result.stdout)

    def test_leaf_lifecycle_targets_have_a_bounded_plan(self):
        # The outer R0.3 gate executes these stages for real. Re-running them
        # recursively from the Python test stage duplicates lint/typecheck/build
        # and makes the gate depend on nested 180-second subprocesses.
        commands = {
            "install": ("install",),
            "lint": ("stage", "lint"),
            "typecheck": ("stage", "typecheck"),
            "build": ("stage", "build"),
        }
        for target, command in commands.items():
            with self.subTest(target=target):
                result = subprocess.run(
                    [
                        sys.executable,
                        str(TOOLCHAIN),
                        "--dry-run",
                        "--json",
                        *command,
                    ],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["status"], "planned")
                self.assertTrue(all(item["timeoutSeconds"] > 0 for item in payload["results"]))

    def test_make_start_serves_when_production_build_exists(self):
        """`make start` launches the real frontend server (P01-01).

        The target blocks by design once a production build exists, so the
        test waits for the server's "Ready" line and then terminates the whole
        process group (make -> pnpm -> next) to avoid orphaned servers. On a
        clean checkout without `.next/BUILD_ID` the serving behaviour cannot
        be asserted, so the check is skipped there.
        """
        build_id = REPO_ROOT / "frontend" / ".next" / "BUILD_ID"
        if not build_id.exists():
            self.skipTest(
                "no frontend production build; make start serving behaviour not asserted"
            )
        # A fixed port makes this toolchain contract depend on unrelated host
        # processes. Reserve an available loopback port, then pass it to Next.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            frontend_port = listener.getsockname()[1]
        env = {**os.environ, "PORT": str(frontend_port)}
        proc = subprocess.Popen(
            ["make", "start"],
            cwd=REPO_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        output: list[str] = []
        ready = False
        try:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                line = proc.stdout.readline()  # type: ignore[union-attr]
                if not line:
                    break
                output.append(line)
                if "Ready" in line:
                    ready = True
                    break
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=30)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
            if proc.stdout is not None:
                proc.stdout.close()
        self.assertTrue(
            ready,
            msg="make start did not report ready:\n" + "".join(output),
        )

    def test_make_install_is_idempotent(self):
        lock = REPO_ROOT / "pnpm-lock.yaml"
        first = self._run_make("install")
        self.assertEqual(first.returncode,  0, msg=first.stdout + first.stderr)
        self.assertTrue(lock.is_file(), "pnpm install must produce pnpm-lock.yaml")
        before = lock.read_bytes()
        second = self._run_make("install")
        self.assertEqual(second.returncode,  0, msg=second.stdout + second.stderr)
        after = lock.read_bytes()
        self.assertEqual(before, after, "pnpm-lock.yaml must be stable across repeated installs")


class PackageContractFailureTests(unittest.TestCase):
    """Malformed or missing package.json inputs fail the placeholder contract."""

    def test_missing_package_json_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "pkg" / "package.json"
            with self.assertRaises(FileNotFoundError):
                read_json(missing)

    def test_malformed_json_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = pathlib.Path(tmp) / "package.json"
            bad.write_text("{ definitely not json", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                read_json(bad)

    def test_malformed_package_contracts_are_rejected(self):
        base = {
            "name": "@fdbtrade/x",
            "private": True,
            "version": "0.0.0",
            "scripts": {script: "echo no-op" for script in PLACEHOLDER_SCRIPTS},
        }
        cases = {
            "missing name": {**base, "name": None},
            "missing private": {**base, "private": False},
            "wrong version": {**base, "version": "1.0.0"},
            "missing scripts": {key: value for key, value in base.items() if key != "scripts"},
            "missing script entry": {**base, "scripts": {"lint": "echo no-op"}},
            "empty script entry": {**base, "scripts": {**base["scripts"], "build": ""}},
            "declares dependency": {**base, "dependencies": {"left-pad": "1.0.0"}},
            "declares devDependency": {**base, "devDependencies": {"typescript": "^5.0.0"}},
        }
        for label, pkg in cases.items():
            with self.subTest(case=label):
                violations = validate_placeholder_package(pkg)
                self.assertTrue(violations, f"{label} must be rejected:")


if __name__ == "__main__":
    unittest.main()
