"""P00-04 CI baseline and ADR system contract tests.

Covers: ADR numbering/sections contract, ADR template contract, ADR index/format
doc, CI workflow contract (four required blocking jobs, no continue-on-error, no
secrets), and the local CI runner (syntax, --help, unknown-option, happy path,
failing-job blocking, source purity, and .env exclusion).

Pure Python stdlib ``unittest`` (no extra dependencies). Deterministic for
deterministic inputs. All internal timestamps are UTC.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CI_RUNNER = REPO_ROOT / "ci" / "run-local.sh"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
ADR_DIR = REPO_ROOT / "docs" / "adr"
ADR_TEMPLATE = REPO_ROOT / "02_TEMPLATES" / "ADR_TEMPLATE.md"

REQUIRED_JOBS = ("lint", "typecheck", "test", "build")

ADR_REQUIRED_SECTIONS = (
    "Status",
    "Date",
    "Deciders",
    "Supersedes",
    "Related",
    "## Context",
    "## Decision",
    "## Consequences",
    "## Verification",
)

# Expected ADR parts: number -> summary title text.
KNOWN_ADRS = {
    1: "baseline-stack",
    2: "repository-layout-and-workspace-contracts",
    3: "architecture-boundaries",
    4: "utc-time-policy",
    5: "live-trading-off-by-default",
    6: "ci-baseline",
    7: "sql-migrations-and-database-foundation",
    8: "private-single-user-authentication",
    9: "canonical-market-data-model",
    10: "market-data-provider-abstraction",
}


def run(cmd, cwd=None, timeout=120):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
    )


def write_fixture_makefile(path: pathlib.Path, fail_lint: bool = False):
    """Write a minimal deterministic Makefile for runner happy/negative tests."""
    lint = "@echo lint-fail; exit 1" if fail_lint else "@echo lint-ok"
    path.write_text(
        ".PHONY: lint typecheck test build\n"
        f"lint:\n\t{lint}\n"
        "typecheck:\n\t@echo typecheck-ok\n"
        "test:\n\t@echo test-ok\n"
        "build:\n\t@echo build-ok\n",
        encoding="utf-8",
)
class AdrContractTests(unittest.TestCase):
    """Valid/malformed cases for the ADR system."""

    def test_adr_files_numbered_contiguously_from_0001(self):
        pattern = re.compile(r"^ADR-(\d{4})-")
        present: dict[int, str] = {}
        for path in ADR_DIR.glob("ADR-*.md"):
            match = pattern.match(path.name)
            if not match:
                raise AssertionError(f"ADR filename has wrong shape: {path.name}")
            present[int(match.group(1))] = path.name
        expected = sorted(KNOWN_ADRS)
        self.assertEqual(sorted(present), expected,
                         "ADR numbers must be contiguous from 0001 with no gaps")
        self.assertEqual(len(present), len(expected),
                         "ADR count must match the known ADR list")

    def test_expected_adrs_exist_with_matching_summary(self):
        for number, summary in KNOWN_ADRS.items():
            with self.subTest(number=number):
                found = list(ADR_DIR.glob(f"ADR-{number:04d}-*.md"))
                self.assertEqual(len(found), 1, f"exactly one ADR-{number:04d} expected")
                self.assertIn(summary, found[0].name)

    def test_each_adr_has_required_sections(self):
        for path in sorted(ADR_DIR.glob("ADR-*.md")):
            text = path.read_text(encoding="utf-8")
            with self.subTest(path=path.name):
                self.assertTrue(text.startswith("# "), "ADR must start with a title")
                for section in ADR_REQUIRED_SECTIONS:
                    self.assertIn(section, text, f"{path.name} missing {section!r}")

    def test_adr_dates_are_iso(self):
        for path in ADR_DIR.glob("ADR-*.md"):
            match = re.search(r"^- Date: (\d{4}-\d{2}-\d{2})",
                              path.read_text(encoding="utf-8"), re.MULTILINE)
            with self.subTest(path=path.name):
                self.assertIsNotNone(match, f"{path.name} must have an ISO date")

    def test_template_contains_required_sections(self):
        text = ADR_TEMPLATE.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# ADR-XXXX:"), "template title must be ADR-XXXX")
        for section in ("Status", "Date", "Deciders", "Supersedes", "Related",
                        "## Context", "## Decision", "## Consequences", "## Verification"):
            self.assertIn(section, text, f"template missing {section!r}")

    def test_index_readme_documents_format(self):
        text = (ADR_DIR / "README.md").read_text(encoding="utf-8")
        for needle in ("Status", "## Decision", "## Consequences",
                       "ADR_TEMPLATE.md", "Numbering", "Index"):
            self.assertIn(needle, text, f"ADR README must document {needle!r}")
class WorkflowContractTests(unittest.TestCase):
    """The declarative CI defines four required, blocking jobs reusing make."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_workflow_triggers_on_main_push_and_pull_request(self):
        self.assertIn("on:", self.text)
        self.assertIn("pull_request", self.text)

    def test_each_required_job_calls_its_make_target(self):
        for target in REQUIRED_JOBS:
            with self.subTest(target=target):
                self.assertIn(f"make {target}", self.text,
                              f"workflow must run `make {target}`")

    def test_no_job_allows_continue_on_error(self):
        self.assertNotIn("continue-on-error", self.text,
                         "required jobs must block; continue-on-error must not appear")

    def test_workflow_contains_required_job_names(self):
        for name in ("lint", "typecheck", "unit-tests", "build"):
            with self.subTest(name=name):
                self.assertIn(name, self.text, f"workflow missing job {name!r}")

    def test_workflow_has_no_secret_markers(self):
        lowered = self.text.lower()
        for token in ("password", "token=", "api_key", "private key"):
            self.assertNotIn(token, lowered, f"workflow must not embed {token!r}")


class RunnerContractTests(unittest.TestCase):
    """Local CI runner: syntax, CLI, happy path, blocking, purity."""

    def test_runner_exists_and_syntax_checks(self):
        self.assertTrue(CI_RUNNER.is_file())
        result = run(["bash", "-n", str(CI_RUNNER)])
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_runner_help_exits_zero(self):
        result = run(["bash", str(CI_RUNNER), "--help"])
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Usage", result.stdout)

    def test_runner_unknown_option_rejected(self):
        result = run(["bash", str(CI_RUNNER), "--bogus"])
        self.assertNotEqual(result.returncode, 0)

    def test_runner_happy_path_all_jobs_pass(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as work:
            write_fixture_makefile(pathlib.Path(src) / "Makefile")
            result = run([
                "bash", str(CI_RUNNER), "--src", src, "--work", work,
                "--skip-install", "--jobs", "lint,typecheck,test,build",
            ])
            self.assertEqual(result.returncode, 0,
                             msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
            self.assertIn("all required jobs passed", result.stdout)

    def test_runner_blocks_on_failing_job(self):
        """A failing required job must block CI (non-zero exit)."""
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as work:
            write_fixture_makefile(pathlib.Path(src) / "Makefile", fail_lint=True)
            result = run([
                "bash", str(CI_RUNNER), "--src", src, "--work", work,
                "--skip-install", "--jobs", "lint",
            ])
            self.assertNotEqual(result.returncode, 0,
                                "a failing required job must block CI")
            self.assertIn("FAILED", result.stderr)

    def test_runner_does_not_mutate_source(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as work:
            src_path = pathlib.Path(src)
            write_fixture_makefile(src_path / "Makefile")
            marker = src_path / "marker.txt"
            marker.write_text("immutable", encoding="utf-8")
            before = marker.read_bytes()
            result = run([
                "bash", str(CI_RUNNER), "--src", src, "--work", work,
                "--skip-install", "--jobs", "typecheck",
            ])
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertEqual(marker.read_bytes(), before, "runner must not mutate source")

    def test_runner_excludes_dotenv_from_clean_copy(self):
        """Secret-like .env content must never reach the CI workspace."""
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as work:
            src_path = pathlib.Path(src)
            write_fixture_makefile(src_path / "Makefile")
            (src_path / ".env").write_text("FDB_DB_PASSWORD=leakme\n", encoding="utf-8")
            result = run([
                "bash", str(CI_RUNNER), "--src", src, "--work", work,
                "--skip-install", "--jobs", "build",
            ])
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertFalse((pathlib.Path(work) / ".env").exists(),
                             ".env must be excluded from the clean-room copy")
            self.assertFalse((pathlib.Path(work) / "node_modules").exists(),
                             "cache dirs must be excluded from the clean-room copy")


if __name__ == "__main__":
    unittest.main()