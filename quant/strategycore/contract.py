"""Strategy interface and canonical signal contract v2 — Python mirror (P05-01).

Stdlib-only mirror of ``contracts/src/strategy/contract.ts`` and ``interface.ts``:
directions, entry types, reason codes, fail-closed signal parsing, deterministic
signal ids, canonical serialization for hashing, and the pure-evaluation
envelope. Deterministic for deterministic inputs; all timestamps UTC
(ADR-0004). No third-party dependencies (ADR-0001). A strategy NEVER calls a
broker (ADR-0003); live execution stays OFF (ADR-0005).
"""

from __future__ import annotations

import re
from typing import Mapping, Sequence

from datacore import (
    DataError,
    TIMEFRAMES,
    TIMEFRAME_MS,
    validate_instrument_id,
    validate_semver,
    validate_utc_instant,
)

#: Tradeable signal directions (a signal is an entry intent, never a hold).
SIGNAL_DIRECTIONS = ("long", "short")

#: Entry styles: market at next bar, or a resting stop/limit level.
SIGNAL_ENTRY_TYPES = ("market", "stop", "limit")

#: Machine-readable evidence/rejection reason codes (sorted on the wire).
SIGNAL_REASON_CODES = (
    "adx_filter_passed",
    "adx_filter_rejected",
    "confirmation_passed",
    "confirmation_rejected",
    "edge_above_costs",
    "edge_below_costs",
    "ema_stack_aligned",
    "ema_stack_misaligned",
    "exhaustion_detected",
    "expiry_reached",
    "insufficient_history",
    "invalidation_hit",
    "missing_input",
    "mtf_alignment_confirmed",
    "mtf_alignment_rejected",
    "no_setup",
    "pullback_confirmed",
    "range_breakout",
    "regime_filter_passed",
    "regime_filter_rejected",
    "reversion_confirmed",
    "signal_closed",
    "signal_emitted",
    "volatility_filter_passed",
    "volatility_filter_rejected",
    "zscore_overextension",
)

_STRATEGY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def strategy_id_ok(value: str) -> bool:
    """Kebab-case strategy identity check (mirror of ``strategyIdSchema``)."""
    return isinstance(value, str) and 2 <= len(value) <= 64 and bool(_STRATEGY_ID_RE.match(value))


def normalize_reason_codes(codes: object, what: str = "reasonCodes") -> list[str]:
    """Validate, dedupe and sort reason codes (deterministic wire form).

    Unsorted or duplicated input is a contract violation (mirror of the
    strict zod refinement) — callers sort before construction.
    """
    if not isinstance(codes, (list, tuple)):
        raise DataError(f"{what} must be a list of reason codes")
    if sorted(set(codes)) != list(codes):
        raise DataError(f"{what} must be sorted and unique")
    seen: list[str] = []
    for code in codes:
        if code not in SIGNAL_REASON_CODES:
            raise DataError(f"{what} contains an unknown reason code: {code!r}")
        if code not in seen:
            seen.append(code)
    if not seen:
        raise DataError(f"{what} must contain at least one reason code")
    return list(seen)


def signal_id_for(
    strategy_id: str,
    instrument: str,
    timeframe: str,
    event_time_utc: str,
    direction: str,
) -> str:
    """Deterministic signal identity (one strategy, one bar, one direction)."""
    return "_".join(("sig", strategy_id, instrument, timeframe, event_time_utc, direction))


def _require_number(value: object, what: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise DataError(f"{what} must be a number: {value!r}")
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise DataError(f"{what} must be finite: {value}")
    return value


def _require_positive_price(value: object, what: str) -> float:
    price = _require_number(value, what)
    if price <= 0:
        raise DataError(f"{what} must be a positive price: {price}")
    return price


def _to_ms(instant: str) -> int:
    from datacore.validate import instant_to_ms

    return instant_to_ms(instant)



def parse_signal(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of a signal (mirror of the zod ``signalSchema``)."""
    if not isinstance(value, Mapping):
        raise DataError("signal must be a mapping")
    allowed = {
        "signalId", "instrument", "timeframe", "eventTimeUtc", "direction",
        "strategyId", "strategyVersion", "configVersion", "entryType",
        "entryPrice", "referencePrice", "stopLoss", "takeProfit",
        "expiresAtUtc", "confidence", "reasonCodes", "inputs",
        "snapshotHash", "signalContractVersion",
    }
    required = (
        "signalId", "instrument", "timeframe", "eventTimeUtc", "direction",
        "strategyId", "strategyVersion", "configVersion", "entryType",
        "entryPrice", "referencePrice", "stopLoss", "takeProfit",
        "expiresAtUtc", "confidence", "reasonCodes", "inputs",
        "snapshotHash", "signalContractVersion",
    )
    missing = [k for k in required if k not in value]
    if missing:
        raise DataError(f"signal missing keys: {missing}")
    extra = sorted(k for k in value if k not in allowed)
    if extra:
        raise DataError(f"signal has unknown keys: {extra}")

    instrument = validate_instrument_id(value["instrument"])
    timeframe = value["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"timeframe must be one of {TIMEFRAMES}: {timeframe!r}")
    event_time = validate_utc_instant(value["eventTimeUtc"])
    expires_at = validate_utc_instant(value["expiresAtUtc"])

    direction = value["direction"]
    if direction not in SIGNAL_DIRECTIONS:
        raise DataError(f"direction must be one of {SIGNAL_DIRECTIONS}: {direction!r}")
    entry_type = value["entryType"]
    if entry_type not in SIGNAL_ENTRY_TYPES:
        raise DataError(f"entryType must be one of {SIGNAL_ENTRY_TYPES}: {entry_type!r}")

    strategy_id = value["strategyId"]
    if not strategy_id_ok(strategy_id):
        raise DataError(f"strategyId must be kebab-case: {strategy_id!r}")
    strategy_version = validate_semver(value["strategyVersion"])
    config_version = validate_semver(value["configVersion"])

    contract_version = value["signalContractVersion"]
    if contract_version != 1:
        raise DataError(f"signalContractVersion must be 1: {contract_version!r}")

    entry_price = (
        None if value["entryPrice"] is None
        else _require_positive_price(value["entryPrice"], "entryPrice")
    )
    reference_price = _require_positive_price(value["referencePrice"], "referencePrice")
    stop_loss = _require_positive_price(value["stopLoss"], "stopLoss")
    take_profit = (
        None if value["takeProfit"] is None
        else _require_positive_price(value["takeProfit"], "takeProfit")
    )

    confidence = _require_number(value["confidence"], "confidence")
    if not 0.0 <= confidence <= 1.0:
        raise DataError(f"confidence must be in [0,1]: {confidence}")

    reason_codes = normalize_reason_codes(value["reasonCodes"])

    inputs = value["inputs"]
    if not isinstance(inputs, Mapping) or not inputs:
        raise DataError("inputs must be a non-empty mapping")
    parsed_inputs: dict[str, float | bool | None] = {}
    for key, val in inputs.items():
        if not isinstance(key, str) or not key:
            raise DataError(f"inputs keys must be non-empty strings: {key!r}")
        if val is None:
            parsed_inputs[key] = None
        elif isinstance(val, bool):
            parsed_inputs[key] = val
        elif isinstance(val, (int, float)):
            parsed_inputs[key] = float(val)
        else:
            raise DataError(f"inputs[{key}] must be a number, boolean or null: {val!r}")

    snapshot_hash = value["snapshotHash"]
    if not isinstance(snapshot_hash, str) or not re.fullmatch(
        r"[0-9a-f]{64}", snapshot_hash
    ):
        raise DataError(f"snapshotHash must be lowercase sha256 hex: {snapshot_hash!r}")

    signal_id = value["signalId"]
    expected_id = signal_id_for(strategy_id, instrument, timeframe, event_time, direction)
    if signal_id != expected_id:
        raise DataError(f"signalId must be the deterministic id {expected_id!r}: {signal_id!r}")

        raise DataError(f"signalContractVersion must be 1: {contract_version!r}")



    frame_ms = TIMEFRAME_MS[timeframe]
    if _to_ms(event_time) % frame_ms != 0:
        raise DataError(f"eventTimeUtc must be aligned to the {timeframe} grid")
    delta = _to_ms(expires_at) - _to_ms(event_time)
    if delta <= 0 or delta % frame_ms != 0:
        raise DataError("expiresAtUtc must be after eventTimeUtc and timeframe-aligned")

    if entry_type != "market" and entry_price is None:
        raise DataError("stop/limit entries require an entryPrice")

    ref = reference_price if entry_price is None else entry_price
    if stop_loss == ref:
        raise DataError("stopLoss must differ from the effective reference price")
    if take_profit is not None and take_profit == stop_loss:
        raise DataError("takeProfit must differ from stopLoss")
    if direction == "long":
        if not stop_loss < ref:
            raise DataError("long requires stopLoss below the reference price")
        if take_profit is not None and not take_profit > ref:
            raise DataError("long requires takeProfit above the reference price")
    else:
        if not stop_loss > ref:
            raise DataError("short requires stopLoss above the reference price")
        if take_profit is not None and not take_profit < ref:
            raise DataError("short requires takeProfit below the reference price")

    return {
        "signalId": signal_id,
        "instrument": instrument,
        "timeframe": timeframe,
        "eventTimeUtc": event_time,
        "direction": direction,
        "strategyId": strategy_id,
        "strategyVersion": strategy_version,
        "configVersion": config_version,
        "entryType": entry_type,
        "entryPrice": entry_price,
        "referencePrice": reference_price,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "expiresAtUtc": expires_at,
        "confidence": confidence,
        "reasonCodes": reason_codes,
        "inputs": parsed_inputs,
        "snapshotHash": snapshot_hash,
        "signalContractVersion": 1,
    }


def _value_str(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        from datacore.manifest import js_number_str

        return js_number_str(float(value))
    raise DataError(f"signal input must be number|boolean|null: {value!r}")


def serialize_signal_canonical(signal: Mapping[str, object]) -> str:
    """Canonical serialization for hashing (mirror of the TS function).

    Byte-identical with the TS form for the same signal content (excluding
    ``snapshotHash``). Changing this form is a breaking change.
    """
    inputs = signal["inputs"]
    if not isinstance(inputs, Mapping):
        raise DataError("inputs must be a mapping")
    input_str = ";".join(f"{key}={_value_str(inputs[key])}" for key in sorted(inputs))

    def lvl(v: object) -> str:
        return "-" if v is None else _value_str(v)

    return "|".join(
        (
            "signal",
            str(signal["signalId"]),
            str(signal["instrument"]),
            str(signal["timeframe"]),
            str(signal["eventTimeUtc"]),
            str(signal["direction"]),
            str(signal["strategyId"]),
            str(signal["strategyVersion"]),
            str(signal["configVersion"]),
            str(signal["entryType"]),
            lvl(signal["entryPrice"]),
            _value_str(signal["referencePrice"]),
            _value_str(signal["stopLoss"]),
            lvl(signal["takeProfit"]),
            str(signal["expiresAtUtc"]),
            _value_str(signal["confidence"]),
            ";".join(str(c) for c in signal["reasonCodes"]),
            input_str,
            _value_str(signal["signalContractVersion"]),
        )
    )

