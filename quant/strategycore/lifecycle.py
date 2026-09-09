"""Signal lifecycle and expiry — Python mirror (P05-06).

Stdlib-only mirror of ``contracts/src/strategy/lifecycle.ts``: frozen
lifecycle states (active/expired/invalidated/closed), append-only
transitions with deterministic bar-open timestamps, idempotent
application, absorbing terminal states and the expiry/invalidation rules
(expiry checked FIRST — the earlier deterministic death wins). No order
creation (execution belongs to P10+). All timestamps UTC (ADR-0004).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError

from .contract import normalize_reason_codes, parse_signal, signal_id_for

#: Canonical lifecycle states (frozen; extension requires a new ADR).
SIGNAL_LIFECYCLE_STATES = ("active", "expired", "invalidated", "closed")

#: Terminal (absorbing) states.
SIGNAL_TERMINAL_STATES = ("expired", "invalidated", "closed")


def is_expired_at(signal: Mapping[str, object], bar_open_utc: str) -> bool:
    """True when the closed bar's open time is at/after the expiry."""
    return bar_open_utc >= signal["expiresAtUtc"]


def is_invalidated_by_bar(signal: Mapping[str, object], bar: Mapping[str, float]) -> bool:
    """True when a closed bar's high/low range touched the stop level."""
    return bar["high"] >= signal["stopLoss"] and bar["low"] <= signal["stopLoss"]


def open_lifecycle(signal: Mapping[str, object]) -> dict:
    """Start a lifecycle: an emitted signal begins active at its event bar."""
    parsed = parse_signal(signal)
    return {
        "signal": parsed,
        "state": "active",
        "transitions": (),
    }


def next_transition_for_bar(
    lifecycle: Mapping[str, object],
    bar: Mapping[str, object],
) -> dict | None:
    """Deterministic transition check for one closed bar (expiry first)."""
    if lifecycle["state"] != "active":
        return None  # terminal states are absorbing
    signal = lifecycle["signal"]
    open_utc = bar["openTimeUtc"]
    if is_expired_at(signal, open_utc):
        return {
            "signalId": signal["signalId"],
            "from": "active",
            "to": "expired",
            "atUtc": open_utc,
            "reasonCodes": ("expiry_reached",),
        }
    if is_invalidated_by_bar(signal, bar):
        return {
            "signalId": signal["signalId"],
            "from": "active",
            "to": "invalidated",
            "atUtc": open_utc,
            "reasonCodes": ("invalidation_hit",),
        }
    return None


def apply_transition(lifecycle: Mapping[str, object], transition: Mapping[str, object]) -> dict:
    """Idempotent, append-only, fail-closed transition application."""
    if not isinstance(transition, Mapping):
        raise DataError("transition must be a mapping")
    for key in ("signalId", "from", "to", "atUtc", "reasonCodes"):
        if key not in transition:
            raise DataError(f"transition missing key: {key}")
    signal = lifecycle["signal"]
    if transition["signalId"] != signal["signalId"]:
        raise DataError(
            f"transition signalId {transition['signalId']!r} does not match "
            f"lifecycle signal {signal['signalId']!r}"
        )
    to_state = transition["to"]
    if to_state not in SIGNAL_LIFECYCLE_STATES:
        raise DataError(f"unknown lifecycle state: {to_state!r}")
    at_utc = transition["atUtc"]
    transitions = tuple(lifecycle["transitions"])
    # Idempotency FIRST (mirror of the TS ordering): the exact same event
    # (to + atUtc) already applied -> no-op, regardless of the from state.
    if any(t["to"] == to_state and t["atUtc"] == at_utc for t in transitions):
        return dict(lifecycle)
    if transition["from"] != lifecycle["state"]:
        raise DataError(
            f"transition from {transition['from']!r} but lifecycle state is "
            f"{lifecycle['state']!r}"
        )
    if to_state == transition["from"]:
        raise DataError("from and to must differ")
    from_state = transition["from"]
    if from_state in SIGNAL_TERMINAL_STATES:
        raise DataError(f"terminal state {from_state!r} is absorbing")
    reasons = tuple(normalize_reason_codes(transition["reasonCodes"]))
    if transitions and at_utc <= transitions[-1]["atUtc"]:
        raise DataError("transitions must be strictly ascending by atUtc")
    new_transition = {
        "signalId": signal["signalId"],
        "from": from_state,
        "to": to_state,
        "atUtc": at_utc,
        "reasonCodes": reasons,
    }
    return {
        "signal": signal,
        "state": to_state,
        "transitions": transitions + (new_transition,),
    }

