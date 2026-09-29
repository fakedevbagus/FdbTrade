"""M47 seven-major runtime coverage contracts."""
from __future__ import annotations

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend" / "src"
RUNTIME = BACKEND / "runtime"
FRONTEND = ROOT / "frontend" / "src"

REQUIRED_PAIRS = [
    "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
]


class M47SevenMajorContracts(unittest.TestCase):
    def test_required_modules_and_ui_surface_exist(self):
        for path in (
            RUNTIME / "sevenMajors.ts",
            RUNTIME / "__tests__" / "sevenMajors.test.ts",
            BACKEND / "app" / "api" / "dashboard" / "route.ts",
            FRONTEND / "app" / "(app)" / "dashboard" / "page.tsx",
        ):
            self.assertTrue(path.is_file(), path)

    def test_exactly_the_seven_configured_pairs_are_declared(self):
        text = (RUNTIME / "sevenMajors.ts").read_text(encoding="utf-8")
        for pair in REQUIRED_PAIRS:
            self.assertIn(f'"{pair}"', text, pair)
        for foreign in ("XAU_USD", "XAUUSD"):
            self.assertNotIn(foreign, text)

    def test_pair_isolation_measured_quarantine_and_bounded_shedding(self):
        text = (RUNTIME / "sevenMajors.ts").read_text(encoding="utf-8")
        for marker in (
            "SEVEN_MAJOR_CACHED_RANGES_PER_PAIR",
            "SEVEN_MAJOR_SHED_REASONS",
            "cycle_not_admitted:suspended",
            "load_shed:observation_only",
            "fault_injected_pair_unavailable",
            "admitCycle",
            "outcome.quarantined.length",
        ):
            self.assertIn(marker, text)
        # Monotone admission: explicit levels raise degradation, never lower it.
        self.assertIn("DEGRADATION_SEVERITY[explicit] >= DEGRADATION_SEVERITY[derived]", text)
        # Deterministic projection: no wall clock, no randomness.
        for forbidden in ("Date.now(", "Math.random("):
            self.assertNotIn(forbidden, text)
        # The runtime slice imports no execution/risk authority.
        for forbidden in ('from "@/execution', 'from "@/risk', 'from "@/paper'):
            self.assertNotIn(forbidden, text)

    def test_quality_gate_quarantine_is_measured_not_invented(self):
        worker = (BACKEND / "data" / "ingestion" / "worker.ts").read_text(encoding="utf-8")
        self.assertIn("quarantined: report.quarantined", worker)
        self.assertIn("quarantined: []", worker)

    def test_dashboard_fixture_projection_is_retired(self):
        route = (BACKEND / "app" / "api" / "dashboard" / "route.ts").read_text(encoding="utf-8")
        self.assertIn("rejectRetiredSurface", route)
        self.assertNotIn("buildDashboardSnapshot", route)

    def test_pipeline_never_improvises_universe_and_labels_provenance(self):
        pipeline = (BACKEND / "signals" / "pipeline.ts").read_text(encoding="utf-8")
        self.assertIn("outside the configured seven-major runtime", pipeline)
        self.assertIn('provenance: "fixture"', pipeline)
        self.assertIn("SEVEN_MAJOR_CONFIG.map", pipeline)
        self.assertNotIn("INSTRUMENTS.keys()", pipeline)

    def test_ui_no_longer_projects_fixture_pair_provenance(self):
        page = (FRONTEND / "app" / "(app)" / "dashboard" / "page.tsx").read_text(encoding="utf-8")
        self.assertIn("Legacy dashboard retired", page)
        self.assertIn("/signals/workbench", page)
        self.assertNotIn("DashboardContent", page)

    def test_no_live_or_provider_order_authority_added(self):
        for path in list(RUNTIME.glob("*.ts")) + [BACKEND / "signals" / "pipeline.ts"]:
            text = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("live_execution_enabled=true", text)
            self.assertNotIn("provider_order_transport_enabled=true", text)


if __name__ == "__main__":
    unittest.main()
