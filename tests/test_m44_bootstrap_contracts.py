"""M44 — Reproducible bootstrap and beta onboarding behavior tests.

Covers: bootstrap wrapper safety/idempotency/dry-run/clean-checkout behavior,
operator CLI (``init``/``start``/``stop``/``status``/``check``/``recover`` plus
``preflight --json``), the requirement-file guard, M44 make gates executing for
real, and the unchanged safety invariants (live execution OFF, provider order
transport OFF, loopback-only binding).

Pure Python stdlib ``unittest`` (no extra dependencies). Deterministic for
deterministic inputs. All internal timestamps are UTC.

Note: the flag literals are assembled from fragments on purpose, so this file can
never itself trip the ``private-beta-check`` source scan.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTSTRAP = REPO_ROOT / "scripts" / "bootstrap.sh"
CLI = REPO_ROOT / "scripts" / "fdbtrade"
MAKEFILE = REPO_ROOT / "Makefile"
REQUIREMENTS = REPO_ROOT / "requirements.txt"
CHECKPOINT = REPO_ROOT / "docs" / "checkpoints" / "43_private_beta.md"
HANDOFF = REPO_ROOT / "docs" / "handoff" / "FRESH_CHAT_RESUME_PROMPT.md"
OPERATOR_GUIDE = REPO_ROOT / "docs" / "OPERATOR_GUIDE.md"
ACCEPTANCE = REPO_ROOT / "artifacts" / "private-beta" / "acceptance.json"

# Built by concatenation so this module contains no contiguous "<FLAG>=true".
FLAG_LIVE = "LIVE_EXECUTION_" + "ENABLED"
FLAG_TRANSPORT = "PROVIDER_ORDER_TRANSPORT_" + "ENABLED"
TRUE_PATTERN = r"\s*=\s*\"?true\"?"

M44_GATES = (
    "operational-packaging-check",
    "private-beta-check",
    "dashboard-check",
    "security-check",
    "phase2-check",
    "handoff-check",
    "format-check",
)

REQUIRED_CLI_COMMANDS = ("preflight", "init", "start", "stop", "status", "check", "recover")

REQUIRED_PREFLIGHT_KEYS = (
    "python",
    "node",
    "npm",
    "pnpm",
    "make",
    "bash",
    "sqlite3",
    "python_sqlite",
    "disk",
    "permissions",
    "ports",
)

SCAN_EXCLUDED_DIRS = {
    "node_modules",
    ".git",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    "artifacts",
}
SCAN_SUFFIXES = {".ts", ".tsx", ".js", ".json", ".py", ".md", ".yaml", ".yml", ".sh"}


def run(cmd, cwd=None, timeout=300):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
    )


def strip_timestamps(text: str) -> str:
    """Remove the leading `[UTC]` prefix from each bootstrap log line."""
    return "\n".join(re.sub(r"^\[[^\]]*\]\s?", "", line) for line in text.splitlines())


def load_cli_module():
    """Import scripts/fdbtrade as a module (its extension-less name forbids import)."""
    loader = importlib.machinery.SourceFileLoader("fdbtrade_cli_under_test", str(CLI))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def iter_scanned_sources():
    for directory, names, files in os.walk(REPO_ROOT, topdown=True):
        names[:] = [name for name in names if name not in SCAN_EXCLUDED_DIRS]
        root = pathlib.Path(directory)
        for name in files:
            path = root / name
            if path.suffix in SCAN_SUFFIXES:
                yield path


class BootstrapScriptContractTests(unittest.TestCase):
    """The bootstrap wrapper must be safe, deterministic, and idempotent."""

    def test_bootstrap_script_exists_and_syntax_is_valid(self):
        self.assertTrue(BOOTSTRAP.is_file(), "scripts/bootstrap.sh must exist")
        self.assertEqual(run(["bash", "-n", str(BOOTSTRAP)]).returncode, 0)

    def test_help_exits_zero_and_documents_usage(self):
        result = run(["bash", str(BOOTSTRAP), "--help"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("Usage", result.stdout)

    def test_unknown_option_is_rejected(self):
        result = run(["bash", str(BOOTSTRAP), "--definitely-not-an-option"])
        self.assertNotEqual(result.returncode, 0, "unknown options must fail closed")

    def test_dry_run_exits_zero_and_reports_a_plan(self):
        result = run(["bash", str(BOOTSTRAP), "--dry-run"])
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("PLAN", result.stdout)
        self.assertIn("no changes were made", result.stdout)

    def test_dry_run_is_deterministic_and_idempotent(self):
        first = strip_timestamps(run(["bash", str(BOOTSTRAP), "--dry-run"]).stdout)
        second = strip_timestamps(run(["bash", str(BOOTSTRAP), "--dry-run"]).stdout)
        self.assertEqual(first, second, "repeated dry runs must be identical")

    def test_never_requests_or_generates_a_secret(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        for forbidden in ("read -p", "read -s", "openssl rand", "uuidgen"):
            self.assertNotIn(forbidden, text, f"bootstrap must not use {forbidden!r}")
        self.assertIn("never requests, generates, prints or stores a secret", text)

    def test_reports_safety_flags_on_success_path(self):
        result = run(["bash", str(BOOTSTRAP), "--dry-run"])
        self.assertIn(f"{FLAG_LIVE}=false", result.stdout)
        self.assertIn(f"{FLAG_TRANSPORT}=false", result.stdout)
        self.assertIn("loopback-only", result.stdout)
class CleanCheckoutBootstrapTests(unittest.TestCase):
    """A clean temporary checkout (no .venv, no .env) must validate from scratch."""

    def _stage_clean_checkout(self, root: pathlib.Path) -> None:
        (root / "scripts").mkdir(parents=True)
        (root / "infra").mkdir(parents=True)
        shutil.copy2(BOOTSTRAP, root / "scripts" / "bootstrap.sh")
        shutil.copy2(REQUIREMENTS, root / "requirements.txt")
        shutil.copy2(REPO_ROOT / "infra" / ".env.example", root / "infra" / ".env.example")
        self.assertTrue(
            (REPO_ROOT / "pnpm-lock.yaml").is_file(),
            "pnpm-lock.yaml must exist: a locked install cannot be reproduced without it",
        )
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", root / "pnpm-lock.yaml")

    def test_clean_checkout_dry_run_plans_venv_and_env_without_mutating(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "checkout"
            self._stage_clean_checkout(root)

            result = run(["bash", "scripts/bootstrap.sh", "--dry-run"], cwd=str(root))

            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertIn("PLAN: create virtual environment", result.stdout)
            self.assertIn("PLAN: create .env", result.stdout)
            # Dry run must mutate nothing, even in a pristine checkout.
            self.assertFalse((root / ".venv").exists())
            self.assertFalse((root / ".env").exists())
            self.assertFalse((root / "node_modules").exists())

    def test_missing_lockfile_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "checkout"
            self._stage_clean_checkout(root)
            (root / "pnpm-lock.yaml").unlink()

            result = run(["bash", "scripts/bootstrap.sh", "--dry-run"], cwd=str(root))

            self.assertNotEqual(result.returncode, 0, "missing lockfile must fail closed")
            self.assertIn("pnpm-lock.yaml missing", result.stdout)


class RequirementGuardTests(unittest.TestCase):
    """The installable-requirement guard must tolerate a declared-empty file."""

    def setUp(self):
        self.module = load_cli_module()

    def _guard(self, text: str) -> bool:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "requirements.txt"
            path.write_text(text, encoding="utf-8")
            return self.module.has_installable_requirements(path)

    def test_comments_and_blank_lines_are_not_installable(self):
        self.assertFalse(self._guard("# only comments\n\n   \n# more\n"))

    def test_real_pin_is_installable(self):
        self.assertTrue(self._guard("# header\nrequests==2.32.0\n"))

    def test_inline_comment_still_counts_as_installable(self):
        self.assertTrue(self._guard("requests==2.32.0  # pinned\n"))

    def test_missing_file_is_not_installable(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "nope.txt"
            self.assertFalse(self.module.has_installable_requirements(missing))

    def test_repository_requirements_file_declares_no_third_party_pins(self):
        self.assertTrue(REQUIREMENTS.is_file())
        self.assertFalse(
            self.module.has_installable_requirements(REQUIREMENTS),
            "the Python dependency surface must stay stdlib-only (ADR-0033)",
        )

    def test_requirements_file_has_no_placeholder_junk(self):
        text = REQUIREMENTS.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.split("#", 1)[0].strip()
            if stripped:
                self.assertRegex(
                    stripped,
                    r"^[A-Za-z0-9_.\-]+==[^\s;]+$",
                    f"unpinned or malformed requirement: {stripped!r}",
                )


class OperatorCliContractTests(unittest.TestCase):
    """The operator CLI must expose and actually run the documented commands."""

    def test_cli_exists_and_compiles(self):
        self.assertTrue(CLI.is_file())
        self.assertEqual(run(["python3", "-m", "py_compile", str(CLI)]).returncode, 0)

    def test_help_lists_every_required_command(self):
        result = run(["python3", str(CLI), "--help"])
        self.assertEqual(result.returncode, 0)
        for command in REQUIRED_CLI_COMMANDS:
            self.assertIn(command, result.stdout, f"CLI must expose {command!r}")

    def test_preflight_json_exits_zero_with_every_required_key(self):
        result = run(["python3", str(CLI), "preflight", "--json"])
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["command"], "preflight")
        for key in REQUIRED_PREFLIGHT_KEYS:
            self.assertIn(key, payload["checks"], f"preflight must report {key!r}")
        self.assertIn(payload["status"], ("pass", "warn", "fail"))

    def test_preflight_json_stdout_is_pure_json(self):
        result = run(["python3", str(CLI), "preflight", "--json"])
        json.loads(result.stdout)  # raises if diagnostics leaked into stdout
        self.assertTrue(result.stderr.strip(), "human diagnostics belong on stderr")

    def test_preflight_reports_loopback_ports(self):
        payload = json.loads(run(["python3", str(CLI), "preflight", "--json"]).stdout)
        self.assertEqual(sorted(payload["checks"]["ports"]), ["15432", "3000", "3100"])

    def test_init_dry_run_exits_zero_and_prints_plan(self):
        result = run(["python3", str(CLI), "init", "--dry-run"])
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        combined = result.stdout + result.stderr
        self.assertIn("no changes were made", combined)

    def test_status_survives_backend_being_down(self):
        result = run(["python3", str(CLI), "status"])
        self.assertEqual(result.returncode, 0)
        self.assertIn(f"{FLAG_LIVE}=false", result.stdout)
        self.assertIn(f"{FLAG_TRANSPORT}=false", result.stdout)

    def test_recover_exits_zero_and_gives_actionable_steps(self):
        result = run(["python3", str(CLI), "recover"])
        self.assertEqual(result.returncode, 0)
        for needle in ("Recovery Guide", "make db-down", "pnpm install --frozen-lockfile"):
            self.assertIn(needle, result.stdout, f"recovery guidance must mention {needle!r}")

    def test_stop_is_scoped_and_never_kills_unrelated_servers(self):
        text = CLI.read_text(encoding="utf-8")
        self.assertNotIn("pgrep", text, "stop must not match processes by name")
        self.assertIn("_pids_listening_on", text)
        self.assertIn("SIGTERM", text)


class SafetyInvariantTests(unittest.TestCase):
    """Live execution, provider order transport, and public binding stay OFF."""

    def test_no_source_file_enables_live_execution(self):
        pattern = re.compile(FLAG_LIVE + TRUE_PATTERN)
        offenders = [
            str(path.relative_to(REPO_ROOT))
            for path in iter_scanned_sources()
            if pattern.search(path.read_text(encoding="utf-8", errors="ignore"))
        ]
        self.assertEqual(offenders, [], f"live execution must stay OFF; offenders: {offenders}")

    def test_no_source_file_enables_provider_order_transport(self):
        pattern = re.compile(FLAG_TRANSPORT + TRUE_PATTERN)
        offenders = [
            str(path.relative_to(REPO_ROOT))
            for path in iter_scanned_sources()
            if pattern.search(path.read_text(encoding="utf-8", errors="ignore"))
        ]
        self.assertEqual(
            offenders, [], f"provider order transport must stay OFF; offenders: {offenders}"
        )

    def test_m44_scripts_bind_loopback_only(self):
        for path in (BOOTSTRAP, CLI):
            with self.subTest(path=path.name):
                self.assertNotIn(
                    "0.0.0.0", path.read_text(encoding="utf-8"),
                    f"{path.name} must never bind a public address",
                )
        self.assertIn("127.0.0.1:3100", CLI.read_text(encoding="utf-8"))

    def test_preflight_json_reports_loopback_only_safety(self):
        payload = json.loads(run(["python3", str(CLI), "preflight", "--json"]).stdout)
        safety = payload["safety"]
        self.assertIs(safety["liveExecutionEnabled"], False)
        self.assertIs(safety["providerOrderTransportEnabled"], False)
        self.assertIs(safety["loopbackOnly"], True)


class AuthorityFileTests(unittest.TestCase):
    """The Phase 2 authority files must exist and stay honest."""

    def test_authority_files_exist(self):
        expected = (
            CHECKPOINT,
            HANDOFF,
            OPERATOR_GUIDE,
            ACCEPTANCE,
            REPO_ROOT / "RECOVERY.md",
            REPO_ROOT / "PHASE2_PROGRESS_MANIFEST.json",
            REPO_ROOT / "phase2" / "PHASE2_ACCEPTANCE_CRITERIA.md",
            REPO_ROOT / "phase2" / "PHASE2_ARCHITECTURE.md",
            REPO_ROOT / "phase2" / "PHASE2_RISK_REGISTER.md",
        )
        for path in expected:
            with self.subTest(path=str(path.relative_to(REPO_ROOT))):
                self.assertTrue(path.is_file(), f"missing authority file: {path}")

    def test_acceptance_evidence_is_committable(self):
        result = run(["git", "check-ignore", "-q", str(ACCEPTANCE)])
        self.assertNotEqual(
            result.returncode, 0, "acceptance evidence must be versioned, not ignored"
        )

    def test_acceptance_evidence_reports_no_live_authority(self):
        payload = json.loads(ACCEPTANCE.read_text(encoding="utf-8"))
        safety = payload["safety"]
        self.assertIs(safety["liveExecutionEnabled"], False)
        self.assertIs(safety["providerOrderTransportEnabled"], False)
        self.assertIs(safety["loopbackOnly"], True)
        self.assertIs(safety["paperOnly"], True)

    def test_manifest_is_valid_and_tracks_a_milestone(self):
        payload = json.loads(
            (REPO_ROOT / "PHASE2_PROGRESS_MANIFEST.json").read_text(encoding="utf-8")
        )
        self.assertIn("currentMilestone", payload)
        self.assertIn("nextPendingMilestone", payload)
        self.assertIsInstance(payload["currentMilestone"], int)

    def test_checkpoint_documents_m43_state_and_m44_authorization(self):
        text = CHECKPOINT.read_text(encoding="utf-8")
        for needle in ("M43", "M44", "make bootstrap", "127.0.0.1"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)


class MakeGateExecutionTests(unittest.TestCase):
    """Every M44 acceptance gate must be declared and must execute for real."""

    def test_every_m44_gate_is_declared_in_makefile(self):
        text = MAKEFILE.read_text(encoding="utf-8")
        for target in M44_GATES + ("bootstrap", "preflight"):
            with self.subTest(target=target):
                self.assertRegex(text, rf"(?m)^{re.escape(target)}:")

    def test_every_m44_gate_exits_zero(self):
        for target in M44_GATES:
            with self.subTest(target=target):
                result = run(["make", target], cwd=str(REPO_ROOT), timeout=600)
                self.assertEqual(
                    result.returncode, 0,
                    msg=f"make {target} failed:\n{result.stdout}\n{result.stderr}",
                )
                self.assertIn("PASS", result.stdout)
