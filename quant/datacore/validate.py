"""Series validation for the Python data core (P02-03).

Mirrors ``backend/src/data/quality/validator.ts`` so research/backtests apply
the SAME quality gates: duplicates, out-of-order, session-aware gaps
(closure gaps are expected and NOT reported), impossible OHLC and stale/
future/crossed quotes. STRICT no-repair policy: accept or quarantine with a
reason code; never invent data.

Deterministic for deterministic inputs. Stdlib only.
"""

from __future__ import annotations

from dataclasses import dataclass

from .model import TIMEFRAME_MS, Candle, Quote, epoch_days
from .registry import get_instrument, get_schedule, is_instant_in_schedule

REASON_CODES = (
    "UNKNOWN_PROVIDER_SYMBOL",
    "INVALID_TIMESTAMP",
    "MISALIGNED_TIMESTAMP",
    "DUPLICATE_TIMESTAMP",
    "OUT_OF_ORDER",
    "IMPOSSIBLE_OHLC",
    "SESSION_GAP",
    "STALE_QUOTE",
    "CROSSED_QUOTE",
)


@dataclass(frozen=True)
class QuarantineEntry:
    index: int
    reason: str
    detail: str


@dataclass(frozen=True)
class GapEntry:
    expected_open_utc: str
    after_index: int


@dataclass(frozen=True)
class CandleSeriesReport:
    accepted: tuple[int, ...]
    quarantined: tuple[QuarantineEntry, ...]
    gaps: tuple[GapEntry, ...]


# ---------------------------------------------------------------------------
# Canonical-instant <-> epoch-ms math (reuses model.epoch_days; no datetime)
# ---------------------------------------------------------------------------


def instant_to_ms(instant: str) -> int:
    """Epoch milliseconds of a canonical UTC instant (digit math)."""
    h = int(instant[11:13])
    m = int(instant[14:16])
    s = int(instant[17:19])
    ms = int(instant[20:23])
    return epoch_days(instant) * 86_400_000 + (h * 3_600_000 + m * 60_000 + s * 1000 + ms)


def ms_to_instant(total_ms: int) -> str:
    """Canonical UTC instant from epoch milliseconds (civil-from-days)."""
    days, rem = divmod(total_ms, 86_400_000)
    h, rem = divmod(rem, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    mo = mp + (3 if mp < 10 else -9)
    y += 1 if mo <= 2 else 0
    return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{m:02d}:{s:02d}.{ms:03d}Z"


# ---------------------------------------------------------------------------
# Series validation (mirror of backend/src/data/quality/validator.ts)
# ---------------------------------------------------------------------------


def validate_candle_series(candles: list[Candle]) -> CandleSeriesReport:
    """Mirror of TS ``validateCandleSeries``: accept / quarantine / report gaps.

    A "gap" is a missing bar whose open AND close instants both fall inside
    the session schedule — closure gaps are expected and never reported.
    Duplicates/out-of-order quarantine the LATER record.
    """
    accepted: list[int] = []
    quarantined: list[QuarantineEntry] = []
    gaps: list[GapEntry] = []

    first_accepted: dict[str, int] = {}
    prev: Candle | None = None
    prev_index = -1

    for i, candle in enumerate(candles):
        if prev is not None and (
            prev.instrument != candle.instrument or prev.timeframe != candle.timeframe
        ):
            raise ValueError(
                "validate_candle_series: mixed series; validate one "
                f"(instrument, timeframe) batch (index {i})"
            )

        if (
            candle.high < candle.open
            or candle.high < candle.close
            or candle.low > candle.open
            or candle.low > candle.close
            or candle.high < candle.low
        ):
            quarantined.append(
                QuarantineEntry(
                    i,
                    "IMPOSSIBLE_OHLC",
                    f"open={candle.open} high={candle.high} "
                    f"low={candle.low} close={candle.close}",
                )
            )
            continue

        if candle.timestamp in first_accepted:
            quarantined.append(
                QuarantineEntry(
                    i,
                    "DUPLICATE_TIMESTAMP",
                    f"duplicate open time {candle.timestamp} "
                    f"(first accepted at index {first_accepted[candle.timestamp]})",
                )
            )
            continue

        open_ms = instant_to_ms(candle.timestamp)
        if prev is not None and open_ms <= instant_to_ms(prev.timestamp):
            quarantined.append(
                QuarantineEntry(
                    i,
                    "OUT_OF_ORDER",
                    f"{candle.timestamp} <= previous accepted {prev.timestamp}",
                )
            )
            continue

        if prev is not None:
            schedule = get_schedule(get_instrument(candle.instrument).sessions_ref)
            frame_ms = TIMEFRAME_MS[candle.timeframe]
            cursor = instant_to_ms(prev.timestamp) + frame_ms
            while cursor < open_ms:
                open_i = ms_to_instant(cursor)
                close_i = ms_to_instant(cursor + frame_ms)
                if is_instant_in_schedule(open_i, schedule) and is_instant_in_schedule(
                    close_i, schedule
                ):
                    gaps.append(GapEntry(open_i, prev_index))
                cursor += frame_ms

        first_accepted[candle.timestamp] = i
        accepted.append(i)
        prev = candle
        prev_index = i

    return CandleSeriesReport(tuple(accepted), tuple(quarantined), tuple(gaps))


@dataclass(frozen=True)
class QuoteValidationReport:
    accepted: tuple[int, ...]
    quarantined: tuple[QuarantineEntry, ...]


def validate_quotes(
    quotes: list[Quote], as_of_utc: str, max_age_ms: int
) -> QuoteValidationReport:
    """Mirror of TS ``validateQuotes`` (crossed / future / stale)."""
    accepted: list[int] = []
    quarantined: list[QuarantineEntry] = []
    as_of_ms = instant_to_ms(as_of_utc)

    for i, quote in enumerate(quotes):
        if quote.ask < quote.bid:
            quarantined.append(
                QuarantineEntry(i, "CROSSED_QUOTE", f"bid={quote.bid} ask={quote.ask}")
            )
            continue
        age = as_of_ms - instant_to_ms(quote.timestamp)
        if age < 0:
            quarantined.append(
                QuarantineEntry(
                    i, "STALE_QUOTE", f"quote is in the future relative to {as_of_utc}"
                )
            )
            continue
        if age > max_age_ms:
            quarantined.append(
                QuarantineEntry(
                    i,
                    "STALE_QUOTE",
                    f"quote age {age}ms exceeds max {max_age_ms}ms at {as_of_utc}",
                )
            )
            continue
        accepted.append(i)

    return QuoteValidationReport(tuple(accepted), tuple(quarantined))

