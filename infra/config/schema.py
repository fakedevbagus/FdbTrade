"""Typed config schema and namespace contracts for FdbTrade (P00-03).

This module is the single source of truth for the server-side configuration
contract: namespace names, environment variable names, types, safe defaults,
required/secret/public flags, and the redaction + public-safe views.

Design rules honoured here (per the FdbTrade constitution / ADR-0002):
- All internal timestamps are UTC (``app.timezone`` is locked to ``"UTC"``).
- Secrets are marked ``secret=True`` and are replaced by ``REDACTED`` in any
  serialized/logged view; they are never emitted by ``to_public_dict``.
- Live execution is OFF by default: ``broker.live_enabled`` defaults False and
  ``broker.adapter`` is locked to ``"paper"``.
- Deterministic output: fields iterate in declaration order; no timestamps or
  non-deterministic sources here.
- Safe defaults in development/testing; secrets become required only in
  ``staging``/``production``.
"""

from __future__ import annotations

import dataclasses
import enum
from typing import Any, Final, Mapping, TypeAlias

REDACTED: Final[str] = "[REDACTED]"


class Env(enum.Enum):
    """Explicit deployment environments supported by the config contract."""

    DEVELOPMENT = "development"
    TESTING = "testing"
    STAGING = "staging"
    PRODUCTION = "production"


ENV_VALUES: Final[tuple[str, ...]] = tuple(e.value for e in Env)

# Secret-bearing credentials become required only in these environments.
SECRET_REQUIRED_IN: Final[tuple[str, ...]] = (Env.STAGING.value, Env.PRODUCTION.value)


@dataclasses.dataclass(frozen=True)
class Field:
    """Declarative contract for a single configuration setting."""

    name: str
    env: str
    kind: str = "str"  # str | int | float | bool | enum | secret | str_list
    default: Any = None
    required: bool = False
    required_in: tuple[str, ...] = ()
    secret: bool = False
    public: bool = False
    allowed: tuple[Any, ...] = ()
    min_value: int | float | None = None
    max_value: int | float | None = None
    description: str = ""


# --------------------------------------------------------------------------- #
# Namespace dataclasses (typed at the boundary).
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class AppConfig:
    name: str
    environment: str
    log_level: str
    timezone: str
    api_host: str
    api_port: int


@dataclasses.dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    name: str
    user: str
    password: str
    pool_size: int
    ssl_mode: str


@dataclasses.dataclass(frozen=True)
class CacheConfig:
    host: str
    port: int
    db: int
    password: str
    ttl_seconds: int
    prefix: str


@dataclasses.dataclass(frozen=True)
class MarketDataConfig:
    provider: str
    base_url: str
    api_key: str
    symbols: tuple[str, ...]
    rate_limit_per_min: int
    timeout_seconds: int


@dataclasses.dataclass(frozen=True)
class NotificationsConfig:
    provider: str
    from_address: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    webhook_url: str
    webhook_token: str


@dataclasses.dataclass(frozen=True)
class BrokerConfig:
    adapter: str
    live_enabled: bool
    read_only: bool
    account_id: str
    endpoint: str
    token: str


@dataclasses.dataclass(frozen=True)
class ResearchConfig:
    data_dir: str
    results_dir: str
    random_seed: int
    job_timeout_seconds: int


@dataclasses.dataclass(frozen=True)
class Config:
    """Fully validated, loaded configuration (server-side)."""

    app: AppConfig
    database: DatabaseConfig
    cache: CacheConfig
    market_data: MarketDataConfig
    notifications: NotificationsConfig
    broker: BrokerConfig
    research: ResearchConfig

    def to_redacted_dict(self) -> dict[str, dict[str, Any]]:
        """Full config as a JSON-safe dict with every secret replaced.

        Safe for logging / debugging; never contains a real secret value.
        Iteration order follows the schema, so output is deterministic.
        """
        return _redacted_dict(self)

    def to_public_dict(self) -> dict[str, dict[str, Any]]:
        """Public-safe view for the frontend.

        Contains only fields marked ``public`` and never any secret. This is the
        only config shape that may cross the server->browser boundary.
        """
        return _public_dict(self)


# --------------------------------------------------------------------------- #
# Schema table (declaration order is the canonical, deterministic order).
# --------------------------------------------------------------------------- #

_APP_FIELDS: tuple[Field, ...] = (
    Field(
        "name", "FDB_APP_NAME", kind="str", default="fdbtrade", public=True,
        description="Service/application display name.",
    ),
    Field(
        "environment", "FDB_APP_ENV", kind="enum", required=True,
        allowed=ENV_VALUES, public=True,
        description="Explicit deployment environment (development, testing, staging, production).",
    ),
    Field(
        "log_level", "FDB_APP_LOG_LEVEL", kind="enum", default="INFO",
        allowed=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"),
        description="Logging verbosity; secrets are never logged.",
    ),
    Field(
        "timezone", "FDB_APP_TIMEZONE", kind="enum", default="UTC",
        allowed=("UTC",),
        description="Internal timezone locked to UTC (constitution rule).",
    ),
    Field(
        "api_host", "FDB_APP_API_HOST", kind="str", default="0.0.0.0", public=True,
        description="BFF/API bind host.",
    ),
    Field(
        "api_port", "FDB_APP_API_PORT", kind="int", default=8000,
        min_value=1, max_value=65535, public=True,
        description="BFF/API bind port.",
    ),
)

_DATABASE_FIELDS: tuple[Field, ...] = (
    Field("host", "FDB_DB_HOST", kind="str", default="localhost"),
    Field("port", "FDB_DB_PORT", kind="int", default=5432, min_value=1, max_value=65535),
    Field("name", "FDB_DB_NAME", kind="str", default="fdbtrade"),
    Field("user", "FDB_DB_USER", kind="str", default="fdbtrade"),
    Field(
        "password", "FDB_DB_PASSWORD", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="PostgreSQL password (secret).",
    ),
    Field("pool_size", "FDB_DB_POOL_SIZE", kind="int", default=10, min_value=1, max_value=100),
    Field("ssl_mode", "FDB_DB_SSL_MODE", kind="enum", default="disable",
          allowed=("disable", "prefer", "require")),
)

_CACHE_FIELDS: tuple[Field, ...] = (
    Field("host", "FDB_CACHE_HOST", kind="str", default="localhost"),
    Field("port", "FDB_CACHE_PORT", kind="int", default=6379, min_value=1, max_value=65535),
    Field("db", "FDB_CACHE_DB", kind="int", default=0, min_value=0, max_value=15),
    Field(
        "password", "FDB_CACHE_PASSWORD", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="Redis password (secret).",
    ),
    Field("ttl_seconds", "FDB_CACHE_TTL_SECONDS", kind="int", default=300,
          min_value=0, max_value=86400),
    Field("prefix", "FDB_CACHE_PREFIX", kind="str", default="fdbtrade"),
)

_MARKET_DATA_FIELDS: tuple[Field, ...] = (
    Field(
        "provider", "FDB_MD_PROVIDER", kind="enum", default="fixture",
        allowed=("fixture",),
        description="Market-data source adapter (fixture until P02).",
    ),
    Field("base_url", "FDB_MD_BASE_URL", kind="str", default=""),
    Field(
        "api_key", "FDB_MD_API_KEY", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="Market-data API key (secret).",
    ),
    Field("symbols", "FDB_MD_SYMBOLS", kind="str_list", default=()),
    Field("rate_limit_per_min", "FDB_MD_RATE_LIMIT_PER_MIN", kind="int", default=60,
          min_value=1, max_value=3600),
    Field("timeout_seconds", "FDB_MD_TIMEOUT_SECONDS", kind="int", default=10,
          min_value=1, max_value=300),
)
_NOTIFICATIONS_FIELDS: tuple[Field, ...] = (
    Field("provider", "FDB_NOTIF_PROVIDER", kind="enum", default="log",
          allowed=("log", "smtp", "webhook")),
    Field("from_address", "FDB_NOTIF_FROM_ADDRESS", kind="str", default=""),
    Field("smtp_host", "FDB_NOTIF_SMTP_HOST", kind="str", default=""),
    Field("smtp_port", "FDB_NOTIF_SMTP_PORT", kind="int", default=587,
          min_value=1, max_value=65535),
    Field("smtp_user", "FDB_NOTIF_SMTP_USER", kind="str", default=""),
    Field(
        "smtp_password", "FDB_NOTIF_SMTP_PASSWORD", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="SMTP password (secret).",
    ),
    Field("webhook_url", "FDB_NOTIF_WEBHOOK_URL", kind="str", default=""),
    Field(
        "webhook_token", "FDB_NOTIF_WEBHOOK_TOKEN", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="Webhook bearer token (secret).",
    ),
)

_BROKER_FIELDS: tuple[Field, ...] = (
    Field(
        "adapter", "FDB_BROKER_ADAPTER", kind="enum", default="paper",
        allowed=("paper",),
        description="Broker bridge adapter; paper = no live orders.",
    ),
    Field(
        "live_enabled", "FDB_BROKER_LIVE_ENABLED", kind="bool", default=False,
        public=True,
        description="Live execution is OFF unless explicitly enabled (safety boundary).",
    ),
    Field("read_only", "FDB_BROKER_READ_ONLY", kind="bool", default=True),
    Field("account_id", "FDB_BROKER_ACCOUNT_ID", kind="str", default=""),
    Field("endpoint", "FDB_BROKER_ENDPOINT", kind="str", default=""),
    Field(
        "token", "FDB_BROKER_TOKEN", kind="secret", default="",
        required_in=SECRET_REQUIRED_IN,
        description="Broker access token (secret).",
    ),
)

_RESEARCH_FIELDS: tuple[Field, ...] = (
    Field("data_dir", "FDB_RS_DATA_DIR", kind="str", default="artifacts/data"),
    Field("results_dir", "FDB_RS_RESULTS_DIR", kind="str", default="artifacts/results"),
    Field(
        "random_seed", "FDB_RS_RANDOM_SEED", kind="int", default=42,
        min_value=0, max_value=4294967295,
        description="Deterministic seed for reproducible research.",
    ),
    Field("job_timeout_seconds", "FDB_RS_JOB_TIMEOUT_SECONDS", kind="int", default=3600,
          min_value=1),
)

NamespaceType: TypeAlias = type[Any]

SCHEMA: dict[str, tuple[NamespaceType, tuple[Field, ...]]] = {
    "app": (AppConfig, _APP_FIELDS),
    "database": (DatabaseConfig, _DATABASE_FIELDS),
    "cache": (CacheConfig, _CACHE_FIELDS),
    "market_data": (MarketDataConfig, _MARKET_DATA_FIELDS),
    "notifications": (NotificationsConfig, _NOTIFICATIONS_FIELDS),
    "broker": (BrokerConfig, _BROKER_FIELDS),
    "research": (ResearchConfig, _RESEARCH_FIELDS),
}
# --------------------------------------------------------------------------- #
# JSON-safe normalisation + redaction / public-view helpers.
# --------------------------------------------------------------------------- #


def _jsonable(value: Any) -> Any:
    """Normalise values to plain JSON-serialisable Python types."""
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    return value


def _is_secret(field: Field) -> bool:
    """A field is secret when flagged or when its kind is ``secret``.

    This guarantees redaction boundaries hold even if a secret field is not
    redundantly flagged, so a real secret can never leak through a view.
    """
    return field.secret or field.kind == "secret"


def _redacted_dict(config: Config) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for namespace, (_, fields) in SCHEMA.items():
        section: dict[str, Any] = {}
        obj = getattr(config, namespace)
        for field in fields:
            value = getattr(obj, field.name)
            section[field.name] = REDACTED if _is_secret(field) else _jsonable(value)
        result[namespace] = section
    return result


def _public_dict(config: Config) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for namespace, (_, fields) in SCHEMA.items():
        section: dict[str, Any] = {}
        obj = getattr(config, namespace)
        for field in fields:
            if field.public and not _is_secret(field):
                section[field.name] = _jsonable(getattr(obj, field.name))
        if section:
            result[namespace] = section
    return result


def all_field_specs() -> list[Field]:
    """Flattened, ordered list of every Field in the schema (for docs/tests)."""
    return [field for _, fields in SCHEMA.values() for field in fields]