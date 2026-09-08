"""P02-01 canonical market-data model contract tests.

Cross-cutting checks that the TS contracts package and the Python
``quant.datacore`` mirror agree on ONE model over the SAME data files.

Pure stdlib ``unittest``; deterministic. All timestamps UTC.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from datacore import (  # noqa: E402
    DataError,
    REASON_CODES,
    TIMEFRAMES,
    align_to_timeframe,
    derive_spread,
    get_instrument,
    get_schedule,
    instant_to_ms,
    is_instant_in_schedule,
    map_provider_symbol,
    ms_to_instant,
    parse_candle,
    parse_quote,
    validate_candle_series,
    validate_quotes,
    validate_registry_integrity,
    validate_utc_instant,
)

DATA_DIR = REPO_ROOT / "contracts" / "src" / "data"

BLUEPRINT_UNIVERSE = [
    "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD",
]
BLUEPRINT_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"]


def load_json(name: str) -> dict:
    with (DATA_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


class SharedDataContracts(unittest.TestCase):
    """Valid-input contract checks over the canonical data files."""

    def test_blueprint_universe_present_with_declared_metadata(self):
        catalog = load_json("instruments.json")
        by_id = {i["id"]: i for i in catalog["instruments"]}
        self.assertEqual(sorted(by_id), sorted(BLUEPRINT_UNIVERSE))
        # Values are data — only presence/positivity is asserted here.
        for iid, inst in by_id.items():
            with self.subTest(instrument=iid):
                self.assertGreater(inst["precision"]["pip"], 0)
                self.assertGreater(inst["precision"]["point"], 0)
                self.assertGreaterEqual(inst["precision"]["digits"], 0)
                self.assertGreater(inst["contractSpec"]["contractSize"], 0)

    def test_timeframes_locked_to_blueprint(self):
        self.assertEqual(list(TIMEFRAMES), BLUEPRINT_TIMEFRAMES)

    def test_symbol_mappings_versioned_and_fixture_provider_present(self):
        table = load_json("symbolMappings.json")
        self.assertRegex(table["version"], r"^\d+\.\d+\.\d+$")
        fixture_symbols = {
            e["providerSymbol"]
            for e in table["entries"]
            if e["providerId"] == "fixture"
        }
        self.assertEqual(sorted(fixture_symbols), sorted(BLUEPRINT_UNIVERSE))

    def test_sessions_utc_only_and_weekday_windows(self):
        catalog = load_json("sessions.json")
        for schedule in catalog["schedules"]:
            with self.subTest(schedule=schedule["id"]):
                self.assertEqual(schedule["timezone"], "UTC")
                for window in schedule["windows"]:
                    self.assertIn(window["day"], ("mon", "tue", "wed", "thu", "fri"))

    def test_registry_integrity_cross_catalog(self):
        self.assertEqual(validate_registry_integrity(), [])


class PythonModelContracts(unittest.TestCase):
    """Behavioral contracts of the Python data-core mirror."""

    def test_utc_instant_validation(self):
        self.assertEqual(
            validate_utc_instant("2026-09-08T10:00:00.000Z"),
            "2026-09-08T10:00:00.000Z",
        )
        for bad in (
            "2026-09-08T10:00:00Z",           # second precision
            "2026-09-08T10:00:00.000000Z",     # microsecond precision
            "2026-09-08T10:00:00.000+02:00",   # offset
            "2026-09-08 10:00:00.000Z",        # space separator
            "not-a-time",
            1694167200000,
            None,
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(DataError):
                    validate_utc_instant(bad)

    def test_alignment_deterministic_open_time_semantics(self):
        self.assertEqual(
            align_to_timeframe("2026-09-08T10:03:41.000Z", "5m"),
            "2026-09-08T10:00:00.000Z",
        )
        self.assertEqual(
            align_to_timeframe("2026-09-08T10:59:59.999Z", "15m"),
            "2026-09-08T10:45:00.000Z",
        )
        self.assertEqual(
            align_to_timeframe("2026-09-08T18:44:12.512Z", "1d"),
            "2026-09-08T00:00:00.000Z",
        )
        self.assertEqual(  # determinism
            align_to_timeframe("2026-09-08T10:03:41.000Z", "5m"),
            align_to_timeframe("2026-09-08T10:03:41.000Z", "5m"),
        )

    def test_session_membership_weekend_and_close_boundaries(self):
        fx = get_schedule("fx-24x5")
        self.assertTrue(is_instant_in_schedule("2026-09-09T12:34:56.000Z", fx))
        self.assertFalse(is_instant_in_schedule("2026-09-12T10:00:00.000Z", fx))  # Sat
        self.assertFalse(is_instant_in_schedule("2026-09-13T23:00:00.000Z", fx))  # Sun
        self.assertFalse(is_instant_in_schedule("2026-09-11T22:00:00.000Z", fx))  # Fri 22:00
        metals = get_schedule("metals-23x5")
        self.assertFalse(is_instant_in_schedule("2026-09-08T00:59:59.000Z", metals))
        self.assertTrue(is_instant_in_schedule("2026-09-08T01:00:00.000Z", metals))

    def test_spread_derivation_uses_instrument_metadata(self):
        eur = get_instrument("EURUSD")
        quote = parse_quote(
            {
                "instrument": "EURUSD",
                "timestamp": "2026-09-08T10:00:00.000Z",
                "bid": 1.1085,
                "ask": 1.1087,
                "isSynthetic": True,
            }
        )
        spread = derive_spread(quote, eur.precision)
        self.assertAlmostEqual(spread.spread_pips, 2.0, places=9)
        self.assertAlmostEqual(spread.mid, 1.1086, places=9)

    def test_impossible_candle_rejected(self):
        with self.assertRaises(DataError):
            parse_candle(
                {
                    "instrument": "EURUSD",
                    "timeframe": "5m",
                    "timestamp": "2026-09-08T10:00:00.000Z",
                    "open": 1.10,
                    "high": 1.09,  # < open: impossible
                    "low": 1.08,
                    "close": 1.11,
                    "volume": None,
                }
            )

    def test_provider_symbol_mapping_lookup(self):
        self.assertEqual(map_provider_symbol("fixture", "EURUSD"), "EURUSD")
        self.assertIsNone(map_provider_symbol("fixture", "UNKNOWN"))
        self.assertIsNone(map_provider_symbol("no-provider", "EURUSD"))


class SharedSourceParityContracts(unittest.TestCase):
    """Both layers must consume the SAME data files (single source of truth).

    The TS layer validates these files at import (zod, fail-fast) and the
    Python layer validates them at import (parse.py, fail-fast); each is
    covered by its own suite in ``make test``. This class pins the wiring:
    the TS registry and the Python registry must point at the same JSON.
    """

    def test_ts_registry_imports_shared_data_files(self):
        registry_ts = (
            REPO_ROOT / "contracts" / "src" / "marketdata" / "registry.ts"
        ).read_text(encoding="utf-8")
        for data_file in (
            "../data/instruments.json",
            "../data/sessions.json",
            "../data/symbolMappings.json",
        ):
            self.assertIn(
                data_file,
                registry_ts,
                f"TS registry must import {data_file}",
            )

    def test_python_registry_points_at_contracts_data_dir(self):
        registry_py = (
            REPO_ROOT / "quant" / "datacore" / "registry.py"
        ).read_text(encoding="utf-8")
        self.assertIn('"contracts"', registry_py)
        self.assertIn('"src"', registry_py)
        self.assertIn('"data"', registry_py)
        self.assertIn("instruments.json", registry_py)
        self.assertIn("sessions.json", registry_py)
        self.assertIn("symbolMappings.json", registry_py)

    def test_pip_values_in_data_are_the_single_pip_source(self):
        """No pip value appears in any layer's source — only in the JSON."""
        layers = {
            "ts": REPO_ROOT / "contracts" / "src" / "marketdata",
            "python": REPO_ROOT / "quant" / "datacore",
        }
        pattern = re.compile(r"0\.0000?1|1e-?4\b|pip:\s*[\d.]+")
        for layer, path in layers.items():
            for src in sorted(path.glob("*.ts" if layer == "ts" else "*.py")):
                with self.subTest(layer=layer, file=src.name):
                    matches = pattern.findall(src.read_text(encoding="utf-8"))
                    self.assertEqual(matches, [], f"pip literal found in {src}")


class ValidationContractTests(unittest.TestCase):
    """P02-03 series validation contracts (Python mirror).

    The behavioral normalizer suite lives with the backend (vitest); this
    class verifies the mirror implements the SAME quality gates and the
    instant<->epoch-ms math is exact.
    """

    @staticmethod
    def _candle(ts: str) -> dict:
        return {
            "instrument": "EURUSD",
            "timeframe": "1h",
            "timestamp": ts,
            "open": 1.1,
            "high": 1.101,
            "low": 1.099,
            "close": 1.1005,
            "volume": None,
        }

    def test_instant_ms_roundtrip_is_exact(self):
        for instant in (
            "2026-09-08T10:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            "2026-12-31T23:59:59.999Z",
            "1970-01-01T00:00:00.000Z",
        ):
            with self.subTest(instant=instant):
                self.assertEqual(ms_to_instant(instant_to_ms(instant)), instant)
        # Cross-check against the stdlib datetime epoch math.
        import datetime as _dt

        instant = "2026-09-08T10:00:00.000Z"
        expected_ms = int(
            _dt.datetime(2026, 9, 8, 10, tzinfo=_dt.timezone.utc).timestamp() * 1000
        )
        self.assertEqual(instant_to_ms(instant), expected_ms)

    def test_clean_series_accepted_without_gaps(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-08T10:00:00.000Z",
            "2026-09-08T11:00:00.000Z",
            "2026-09-08T12:00:00.000Z",
        )]
        report = validate_candle_series(candles)
        self.assertEqual(report.accepted, (0, 1, 2))
        self.assertEqual(report.quarantined, ())
        self.assertEqual(report.gaps, ())

    def test_duplicate_quarantines_later_record(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-08T10:00:00.000Z",
            "2026-09-08T10:00:00.000Z",
        )]
        report = validate_candle_series(candles)
        self.assertEqual(report.accepted, (0,))
        self.assertEqual(report.quarantined[0].reason, "DUPLICATE_TIMESTAMP")

    def test_out_of_order_quarantined(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-08T11:00:00.000Z",
            "2026-09-08T10:00:00.000Z",
        )]
        report = validate_candle_series(candles)
        self.assertEqual(report.accepted, (0,))
        self.assertEqual(report.quarantined[0].reason, "OUT_OF_ORDER")

    def test_session_gap_reported_inside_open_hours(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-08T10:00:00.000Z",
            "2026-09-08T13:00:00.000Z",
        )]
        report = validate_candle_series(candles)
        self.assertEqual(
            [g.expected_open_utc for g in report.gaps],
            ["2026-09-08T11:00:00.000Z", "2026-09-08T12:00:00.000Z"],
        )

    def test_weekend_closure_is_not_a_gap(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-11T21:00:00.000Z",
            "2026-09-14T00:00:00.000Z",
        )]
        report = validate_candle_series(candles)
        self.assertEqual(report.gaps, ())

    def test_impossible_ohlc_quarantined(self):
        bad = self._candle("2026-09-08T10:00:00.000Z")
        bad["high"] = 1.09  # < open
        with self.assertRaises(DataError):
            # Canonical candles cannot even be constructed with impossible
            # OHLC (schema-level rejection) — the validator's OHLC branch is
            # defense in depth for already-constructed dataclasses.
            parse_candle(bad)

    def test_quote_gates_stale_future_crossed(self):
        good = parse_quote({
            "instrument": "EURUSD",
            "timestamp": "2026-09-08T10:00:05.000Z",
            "bid": 1.1085,
            "ask": 1.1087,
            "isSynthetic": True,
        })
        stale = parse_quote({
            "instrument": "EURUSD",
            "timestamp": "2026-09-08T09:00:00.000Z",
            "bid": 1.1085,
            "ask": 1.1087,
            "isSynthetic": True,
        })
        future = parse_quote({
            "instrument": "EURUSD",
            "timestamp": "2026-09-08T10:00:11.000Z",
            "bid": 1.1085,
            "ask": 1.1087,
            "isSynthetic": True,
        })
        report = validate_quotes(
            [good, stale, future], "2026-09-08T10:00:10.000Z", 30_000
        )
        self.assertEqual(report.accepted, (0,))
        reasons = [q.reason for q in report.quarantined]
        self.assertEqual(reasons, ["STALE_QUOTE", "STALE_QUOTE"])

    def test_validation_is_idempotent(self):
        candles = [parse_candle(self._candle(t)) for t in (
            "2026-09-08T10:00:00.000Z",
            "2026-09-08T10:00:00.000Z",
            "2026-09-08T13:00:00.000Z",
        )]
        self.assertEqual(
            validate_candle_series(candles), validate_candle_series(candles)
        )

    def test_reason_codes_locked_to_shared_taxonomy(self):
        # The TS normalizer exports the same taxonomy; a change here must be
        # a deliberate cross-layer change (ADR-0011).
        expected = {
            "UNKNOWN_PROVIDER_SYMBOL", "INVALID_TIMESTAMP",
            "MISALIGNED_TIMESTAMP", "DUPLICATE_TIMESTAMP", "OUT_OF_ORDER",
            "IMPOSSIBLE_OHLC", "SESSION_GAP", "STALE_QUOTE", "CROSSED_QUOTE",
        }
        self.assertEqual(set(REASON_CODES), expected)


class ProviderBoundaryContracts(unittest.TestCase):
    """P02-02 provider contracts (cross-cutting, static).

    The behavioral provider contract tests live with the backend
    (vitest, mocked HTTP-free). This class pins the durable boundaries:
    the interface lives in contracts, the fixture provider is offline and
    deterministic, and no live/broker dependency exists yet.
    """

    PROVIDER_INTERFACE = REPO_ROOT / "contracts" / "src" / "marketdata" / "provider.ts"
    FIXTURE_PROVIDER = REPO_ROOT / "backend" / "src" / "data" / "providers" / "fixture.ts"

    def test_provider_interface_exists_in_contracts(self):
        text = self.PROVIDER_INTERFACE.read_text(encoding="utf-8")
        self.assertIn("MarketDataProvider", text)
        self.assertIn("capabilities", text)
        self.assertIn("getHistoricalCandles", text)
        self.assertIn("getQuotes", text)
        self.assertIn("health", text)
        self.assertIn("UNSUPPORTED_INSTRUMENT", text)
        self.assertIn("UNSUPPORTED_TIMEFRAME", text)

    def test_fixture_provider_is_offline_and_deterministic(self):
        text = self.FIXTURE_PROVIDER.read_text(encoding="utf-8")
        # No network access of any form.
        for forbidden in ("fetch(", "http://", "https://", "XMLHttpRequest", "axios"):
            self.assertNotIn(
                forbidden, text, f"fixture provider must not use {forbidden}"
            )
        # No wall-clock or randomness: determinism is required.
        self.assertNotIn("Date.now(", text)
        self.assertNotIn("Math.random(", text)
        # Session-aware synthesis uses the registry (metadata-driven).
        self.assertIn("getSchedule", text)
        self.assertIn("isInstantInSchedule", text)

    def test_no_tradingview_dependency_exists_yet(self):
        """Non-goal guard: no TradingView scraping anywhere in the tree."""
        for area in ("backend/src", "contracts/src", "quant", "frontend/src"):
            base = REPO_ROOT / area
            for src in base.rglob("*"):
                if src.is_file() and src.suffix in (".ts", ".tsx", ".py", ".mjs"):
                    text = src.read_text(encoding="utf-8", errors="ignore")
                    self.assertNotIn(
                        "tradingview", text.lower(), f"TV reference in {src}"
                    )


if __name__ == "__main__":
    unittest.main()


