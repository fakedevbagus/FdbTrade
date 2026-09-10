"""P07-01 private command-center contracts (static source checks).

Verifies the P07-01 surfaces exist and respect the repo's hard invariants:
- the backend exposes the deterministic read-only signal pipeline + the
  authenticated /api/dashboard route (GET only, validated query),
- the frontend command center renders the validated snapshot with explicit
  loading/error/stale surfaces and no trading/execution logic,
- no forbidden tokens (execution/broker references) in the new sources,
- weight-table placeholder versioning discipline (documented, not tuned).

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import re
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND_SRC = REPO_ROOT / "backend" / "src"
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"

PIPELINE = BACKEND_SRC / "signals" / "pipeline.ts"
WEIGHTS = BACKEND_SRC / "signals" / "weights.ts"
ROUTE = BACKEND_SRC / "app" / "api" / "dashboard" / "route.ts"
DASH_CONTENT = FRONTEND_SRC / "components" / "dashboard" / "DashboardContent.tsx"
DASH_PAGE = FRONTEND_SRC / "app" / "(app)" / "dashboard" / "page.tsx"
DASH_LIB = FRONTEND_SRC / "lib" / "dashboard.ts"


class SignalPipelineContract(unittest.TestCase):
    def test_pipeline_exists_and_is_read_only(self):
        text = PIPELINE.read_text(encoding="utf-8")
        # Deterministic request: explicit asOf, no wall clock in the module.
        self.assertIn("asOfUtc", text)
        self.assertNotIn("Date.now()", text)
        self.assertNotIn("Math.random", text)
        # P6 layers reused, not re-implemented.
        for symbol in ("evaluateEnsemble", "gateDecision", "stampCalibration", "rankDecisions"):
            self.assertIn(symbol, text)
        # Fail-closed per instrument.
        self.assertIn("insufficient closed history", text)
        self.assertIn("session gap or weekend", text)

    def test_weight_table_is_versioned_and_fail_closed(self):
        text = WEIGHTS.read_text(encoding="utf-8")
        self.assertIn("DASHBOARD_WEIGHT_TABLE_VERSION", text)
        self.assertRegex(text, r"unknown:\s*\{\s*\}")
        # Placeholder discipline documented (no tuning before P8/P9).
        self.assertRegex(text, r"PLACEHOLDER")

    def test_route_is_get_only_with_validated_query(self):
        text = ROUTE.read_text(encoding="utf-8")
        self.assertIn("requireSession", text)
        self.assertIn("dashboardQuerySchema", text)
        self.assertIn('ApiError.methodNotAllowed(["GET"])', text)
        self.assertIn("asOfUtc", text)


class DashboardUiContract(unittest.TestCase):
    def test_content_renders_the_six_surfaces(self):
        text = DASH_CONTENT.read_text(encoding="utf-8")
        for surface in (
            "Market overview",
            "Active signals",
            "Regime summary",
            "Data freshness",
            "Portfolio heat",
            "Top opportunities",
        ):
            self.assertIn(surface, text)
        # Stale and error states are explicit.
        self.assertIn("Stale", text)
        self.assertIn("errors", text)
        # Heat is a labeled placeholder, never a fabricated number.
        self.assertRegex(text, r"Placeholder")

    def test_page_validates_at_the_boundary_and_fails_closed(self):
        text = DASH_PAGE.read_text(encoding="utf-8")
        self.assertIn("fetchLatestDashboardSnapshot", text)
        self.assertIn("ErrorState", text)
        # No client-side pipeline re-implementation.
        self.assertNotIn("evaluateEnsemble", text)

    def test_client_schema_validates_snapshot(self):
        text = DASH_LIB.read_text(encoding="utf-8")
        self.assertIn("dashboardSnapshotSchema", text)
        self.assertIn("safeParse", text)
        self.assertRegex(text, r"ok:\s*false")

    def test_no_execution_logic_in_new_ui_sources(self):
        forbidden = re.compile(
            r"(?i)(submit\s*order|place\s*order|send\s*order|metatrader|\bmt5\b"
            r"|\bbroker\b|order\s*api)"
        )
        for path in (DASH_CONTENT, DASH_PAGE, DASH_LIB):
            self.assertIsNone(
                forbidden.search(path.read_text(encoding="utf-8")),
                f"forbidden trading token in {path}",
            )


class DeterminismContract(unittest.TestCase):
    def test_pipeline_tests_cover_required_cases(self):
        test = (
            BACKEND_SRC
            / "signals"
            / "__tests__"
            / "pipeline.test.ts"
        ).read_text(encoding="utf-8")
        for required in (
            "deterministic",  # happy path determinism
            "weekend",  # boundary/stale
            "misaligned",  # malformed input
            "idempotency",  # repeated builds
            "placeholder",  # honesty: no fake heat
        ):
            self.assertIn(required, test)


if __name__ == "__main__":
    unittest.main()
