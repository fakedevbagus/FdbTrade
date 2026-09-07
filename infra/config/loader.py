"""Deterministic, typed server-side configuration loading (P00-03).

Reads configuration from environment variables (source of truth) optionally
supplemented by a ``.env`` file. Real ``os.environ`` always wins over the file.

Behaviour:
- ``FDB_APP_ENV`` is always required (explicit environment).
- Non-secret fields have safe defaults; secrets default to ``""`` in
  development/testing and become required in staging/production.
- Malformed or missing *required* input raises ``ConfigError`` aggregating every
  problem; the message never contains a secret value.
- The loader never mutates ``os.environ`` and never writes anything.

Only the Python standard library is used (no dependency changes, per ADR-0001).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping, Optional

from .schema import Config, Field, SCHEMA


class ConfigError(Exception):
    """Raised when configuration cannot be validated. Message is secret-free."""


# Sentinel so a legitimately-empty string is still "present".
_MISSING = object()


def parse_dotenv_text(text: str) -> dict[str, str]:
    """Parse a minimal ``.env`` document into ``{NAME: value}``.

    Supported syntax: blank/comment (``#``) lines, ``export NAME=value``,
    optional surrounding single/double quotes (quotes are stripped and not
    escaped), and no variable substitution. Deterministic for deterministic
    input. Used only to read a git-ignored local file, never for secrets in
    source.
    """
    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if name:
            result[name] = value
    return result


def read_dotenv(path: Optional[os.PathLike[str]] = None) -> dict[str, str]:
    """Read a ``.env`` file if it exists; otherwise return ``{}``."""
    if path is None:
        return {}
    p = Path(path)
    if not p.is_file():
        return {}
    return parse_dotenv_text(p.read_text(encoding="utf-8"))


def _parse_bool(raw: Any) -> bool:
    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"expected a boolean (true/false/yes/no/on/off/1/0), got {str(raw)!r}")


def _parse_int(raw: Any, field: Field) -> int:
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        raise ConfigError(f"expected an integer, got {str(raw)!r}") from None


def _parse_float(raw: Any, field: Field) -> float:
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        raise ConfigError(f"expected a number, got {str(raw)!r}") from None


def _parse_str_list(raw: Any) -> tuple[str, ...]:
    text = str(raw).strip()
    if not text:
        return ()
    return tuple(item.strip() for item in text.split(",") if item.strip())


def _coerce(field: Field, raw: Any) -> Any:
    """Coerce a raw string into the target type. Raises ConfigError on failure."""
    kind = field.kind
    if kind == "str":
        return str(raw)
    if kind == "secret":
        return str(raw)
    if kind == "bool":
        return _parse_bool(raw)
    if kind == "int":
        return _parse_int(raw, field)
    if kind == "float":
        return _parse_float(raw, field)
    if kind == "enum":
        return str(raw)
    if kind == "str_list":
        return _parse_str_list(raw)
def _validate(field: Field, value: Any) -> None:
    """Validate allowed-set and numeric bounds. Raises ConfigError."""
    context = field.env
    if field.allowed and str(value) not in field.allowed:
        allowed = ", ".join(str(item) for item in field.allowed)
        raise ConfigError(f"{context} must be one of {allowed}, got {str(value)!r}")
    if field.kind in ("int", "float"):
        low = field.min_value
        high = field.max_value
        if low is not None and value < low:
            raise ConfigError(f"{context} must be >= {low}, got {value!r}")
        if high is not None and value > high:
            raise ConfigError(f"{context} must be <= {high}, got {value!r}")


def _is_required(field: Field, environment: str) -> bool:
    if field.required:
        return True
    if environment in field.required_in:
        return True
    return False


def _resolve_field(field: Field, raw: Any) -> Any:
    """Coerce + validate a present value. Raises ConfigError on any problem."""
    value = _coerce(field, raw)
    _validate(field, value)
    return value


def load_config(
    dotenv_path: Optional[os.PathLike[str]] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> Config:
    """Load and validate the full configuration.

    ``environ``: explicit mapping (defaults to ``os.environ``). Values here take
    precedence over any ``.env`` file. Never mutated.
    ``dotenv_path``: optional path to a local ``.env`` file (git-ignored).

    Raises ``ConfigError`` listing every problem when required input is missing
    or any value is malformed. The message never includes secret values.
    """
    explicit = dict(os.environ) if environ is None else dict(environ)
    file_vars = read_dotenv(dotenv_path)
    merged: dict[str, str] = {**file_vars, **explicit}

    problems: list[str] = []

    # Resolve the environment first: required and always present after coercion.
    env_field = next(f for f in SCHEMA["app"][1] if f.name == "environment")
    env_raw = merged.get(env_field.env, _MISSING)
    if env_raw is _MISSING:
        raise ConfigError(f"{env_field.env} is required but not set")
    try:
        environment = _resolve_field(env_field, env_raw)
    except ConfigError as exc:
        raise ConfigError(f"{env_field.env}: {exc}") from None

    namespaces: dict[str, Any] = {}
    for namespace, (namespace_type, fields) in SCHEMA.items():
        kwargs: dict[str, Any] = {}
        for field in fields:
            if field.name == "environment":  # already resolved above
                kwargs[field.name] = environment
                continue
            raw = merged.get(field.env, _MISSING)
            if raw is _MISSING:
                if _is_required(field, environment):
                    problems.append(f"{field.env} is required but not set")
                    kwargs[field.name] = field.default
                    continue
                kwargs[field.name] = field.default
                continue
            try:
                kwargs[field.name] = _resolve_field(field, raw)
            except ConfigError as exc:
                problems.append(f"{field.env}: {exc}")
                kwargs[field.name] = field.default
        namespaces[namespace] = namespace_type(**kwargs)

    if problems:
        raise ConfigError(
            "Configuration is invalid:\n  - " + "\n  - ".join(problems)
        )

    return Config(**namespaces)  # type: ignore[arg-type]
    raise ConfigError(f"internal: unknown field kind {kind!r}")