"""P01-01 web application shell contract tests.

Covers: the frontend package manifest (real scripts, approved stack), the
shell structure (routes, layout, loading/error/empty primitives, protected
app-area placeholder), route/nav consistency, UI safety (no trading logic,
no broker references, no secrets), and the styling/test tooling contracts.

Pure Python stdlib ``unittest`` (no extra dependencies). Deterministic for
deterministic inputs. All internal timestamps are UTC.
"""

from __future__ import annotations

import json
import pathlib
import re
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO_ROOT / "frontend"
SRC = FRONTEND / "src"
APP = SRC / "app"


def load_json(path: pathlib.Path):
    """Load JSON, failing loudly on malformed or missing input."""
    return json.loads(path.read_text(encoding="utf-8"))


def iter_source_files():
    """All frontend TypeScript/CSS source files (never node_modules/.next)."""
    for pattern in ("src/**/*.ts", "src/**/*.tsx", "src/**/*.css", "*.ts"):
        yield from FRONTEND.glob(pattern)


class JsonHelperContract(unittest.TestCase):
    """The harness helper itself: malformed/missing input fails loudly."""

    def test_malformed_json_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = pathlib.Path(tmp) / "broken.json"
            bad.write_text("{ not json", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                load_json(bad)

    def test_missing_file_is_rejected(self):
        with self.assertRaises(FileNotFoundError):
            load_json(FRONTEND / "does-not-exist.json")


class FrontendPackageContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pkg = load_json(FRONTEND / "package.json")
        cls.scripts = cls.pkg["scripts"]

    def test_scripts_are_real_and_not_placeholder(self):
        """Regression guard: the P00 placeholder no-op scripts must not return."""
        for name in ("dev", "build", "start", "lint", "typecheck", "test"):
            self.assertIn(name, self.scripts)
            self.assertNotIn("no-op", self.scripts[name])

    def test_canonical_tool_commands(self):
        self.assertEqual(self.scripts["build"], "next build")
        self.assertEqual(self.scripts["start"], "next start -H 127.0.0.1 -p 3000")
        self.assertEqual(self.scripts["typecheck"], "tsc --noEmit")
        self.assertEqual(self.scripts["test"], "vitest run")
        self.assertEqual(self.scripts["lint"], "eslint .")

    def test_approved_stack_dependencies_present(self):
        deps = self.pkg["dependencies"]
        for dep in ("next", "react", "react-dom", "zod"):
            self.assertIn(dep, deps)
        dev = self.pkg["devDependencies"]
        for dep in ("typescript", "eslint", "eslint-config-next", "vitest", "jsdom"):
            self.assertIn(dep, dev)


class ShellStructureContract(unittest.TestCase):
    REQUIRED_FILES = (
        "src/app/layout.tsx",
        "src/app/page.tsx",
        "src/app/loading.tsx",
        "src/app/error.tsx",
        "src/app/not-found.tsx",
        "src/app/globals.css",
        "src/app/(app)/layout.tsx",
        "src/app/(app)/loading.tsx",
        "src/app/(app)/error.tsx",
        "src/app/(app)/dashboard/page.tsx",
        "src/components/ui/Loading.tsx",
        "src/components/ui/EmptyState.tsx",
        "src/components/ui/ErrorState.tsx",
        "src/components/ui/index.ts",
        "src/lib/site-config.ts",
        "vitest.config.ts",
    )

    def test_required_files_exist(self):
        for rel in self.REQUIRED_FILES:
            self.assertTrue((FRONTEND / rel).is_file(), f"missing: {rel}")

    def test_tsconfig_is_strict(self):
        tsconfig = load_json(FRONTEND / "tsconfig.json")
        self.assertIs(tsconfig["compilerOptions"]["strict"], True)
        # Next 15+ rewrites "preserve" to "react-jsx" (automatic runtime);
        # both values are accepted so the gate is stable across that rewrite.
        self.assertIn(
            tsconfig["compilerOptions"]["jsx"], ("preserve", "react-jsx")
        )

    def test_root_layout_contract(self):
        text = (APP / "layout.tsx").read_text(encoding="utf-8")
        self.assertIn("fdb-header", text)
        self.assertIn("fdb-footer", text)
        self.assertIn("fdb-skip-link", text)
        self.assertIn("siteConfig.nav", text)
        self.assertIn("All timestamps are", text)
        self.assertIn("executionStatusLabel", text)

    def test_loading_pages_use_the_loading_primitive(self):
        for rel in ("src/app/loading.tsx", "src/app/(app)/loading.tsx"):
            text = (FRONTEND / rel).read_text(encoding="utf-8")
            self.assertIn("<Loading", text, rel)

    def test_error_pages_are_client_boundaries_with_reset(self):
        for rel in ("src/app/error.tsx", "src/app/(app)/error.tsx"):
            text = (FRONTEND / rel).read_text(encoding="utf-8")
            self.assertIn('"use client"', text, rel)
            self.assertIn("reset", text, rel)
            self.assertIn("<ErrorState", text, rel)

    def test_not_found_uses_the_empty_state_primitive(self):
        text = (APP / "not-found.tsx").read_text(encoding="utf-8")
        self.assertIn("<EmptyState", text)

    def test_protected_area_is_explicit_placeholder_pending_p01_04(self):
        text = (APP / "(app)" / "layout.tsx").read_text(encoding="utf-8")
        self.assertIn("P01-04", text)
        self.assertIn('role="note"', text)

    def test_dashboard_renders_honest_empty_states(self):
        text = (APP / "(app)" / "dashboard" / "page.tsx").read_text(
            encoding="utf-8"
        )
        self.assertIn("<EmptyState", text)

    def test_ui_primitives_are_typed_and_exported(self):
        for name in ("Loading", "EmptyState", "ErrorState"):
            text = (SRC / "components" / "ui" / f"{name}.tsx").read_text(
                encoding="utf-8"
            )
            self.assertIn(f"export type {name}Props", text)
            self.assertIn(f"export function {name}", text)


class RouteContract(unittest.TestCase):
    @staticmethod
    def collect_routes():
        """Map every page.tsx under src/app to its URL route."""
        routes = set()
        for page in APP.rglob("page.tsx"):
            rel = page.parent.relative_to(APP)
            parts = [p for p in rel.parts if not p.startswith("(")]
            routes.add("/" + "/".join(parts) if parts else "/")
        return routes

    def test_expected_routes_render(self):
        routes = self.collect_routes()
        self.assertIn("/", routes)
        self.assertIn("/dashboard", routes)

    def test_every_nav_link_resolves_to_a_route(self):
        config_text = (SRC / "lib" / "site-config.ts").read_text(
            encoding="utf-8"
        )
        hrefs = set(re.findall(r'href:\s*"([^"]+)"', config_text))
        self.assertTrue(hrefs)
        routes = self.collect_routes()
        for href in hrefs:
            self.assertIn(href, routes, f"nav href {href} has no page route")


class UiSafetyContract(unittest.TestCase):
    FORBIDDEN_TOKENS = re.compile(
        r"(?i)(submit\s*order|place\s*order|send\s*order|cancel\s*order"
        r"|metatrader|\bmt5\b|\bbroker\b|order\s*api)"
    )
    BACKEND_IMPORT = re.compile(
        r"""from\s+["'][^"']*\b(backend|quant)\b[^"']*["']"""
    )
    SECRET_PATTERNS = re.compile(
        r"(?i)(sk-[A-Za-z0-9]{16,}"
        r"|(api[_-]?key|secret|password|passphrase|access[_-]?token)"
        r'\s*[:=]\s*["\'][^"\']{4,}["\'])'
    )

    def test_no_trading_or_broker_logic_in_ui_source(self):
        for path in iter_source_files():
            text = path.read_text(encoding="utf-8")
            match = self.FORBIDDEN_TOKENS.search(text)
            self.assertIsNone(
                match, f"forbidden trading token in {path}: {match!r}"
            )

    def test_no_imports_from_backend_or_quant_packages(self):
        for path in iter_source_files():
            if path.suffix == ".css":
                continue
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(
                self.BACKEND_IMPORT.search(text),
                f"forbidden cross-package import in {path}",
            )

    def test_no_obvious_secrets_in_frontend_source(self):
        for path in iter_source_files():
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(
                self.SECRET_PATTERNS.search(text),
                f"potential secret literal in {path}",
            )

    def test_no_env_files_inside_frontend(self):
        leaks = [str(p) for p in FRONTEND.glob(".env*")]
        self.assertEqual(leaks, [], "frontend must not carry .env files")

    def test_live_execution_invariant_is_enforced_in_site_config(self):
        text = (SRC / "lib" / "site-config.ts").read_text(encoding="utf-8")
        self.assertIn("liveExecutionEnabled: z.literal(false)", text)
        self.assertIn("liveExecutionEnabled: false", text)


class StylingAndTestToolingContract(unittest.TestCase):
    def test_grid_and_typography_tokens_exist(self):
        css = (APP / "globals.css").read_text(encoding="utf-8")
        self.assertIn(".fdb-grid", css)
        self.assertIn("--fdb-step-", css)
        self.assertIn("--fdb-font-sans", css)
        self.assertIn("prefers-color-scheme", css)

    def test_vitest_runs_in_jsdom_with_src_alias(self):
        text = (FRONTEND / "vitest.config.ts").read_text(encoding="utf-8")
        self.assertIn('environment: "jsdom"', text)
        self.assertIn('include: ["src/**/*.test.{ts,tsx}"]', text)
        self.assertIn('"@"', text)

    def test_frontend_test_files_exist(self):
        for rel in (
            "src/components/ui/__tests__/ui.test.tsx",
            "src/app/__tests__/error-boundaries.test.tsx",
            "src/lib/__tests__/site-config.test.ts",
        ):
            self.assertTrue((FRONTEND / rel).is_file(), f"missing: {rel}")


if __name__ == "__main__":
    unittest.main()
