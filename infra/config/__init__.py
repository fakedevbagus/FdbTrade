"""FdbTrade server-side configuration contract (P00-03).

Python presenters (backend workers, quant) import ``load_config`` from here.
The loader is dependency-free (stdlib only), deterministic, validates at the
boundary, redacts secrets, and exposes a public-safe view for the frontend.
"""

from __future__ import annotations

from .loader import ConfigError, load_config, parse_dotenv_text, read_dotenv
from .schema import (
    REDACTED,
    AppConfig,
    BrokerConfig,
    Config,
    DatabaseConfig,
    Env,
    ENV_VALUES,
    Field,
    MarketDataConfig,
    NotificationsConfig,
    ResearchConfig,
    SCHEMA,
    all_field_specs,
)

__all__ = [
    "AppConfig",
    "BrokerConfig",
    "Config",
    "ConfigError",
    "DatabaseConfig",
    "Env",
    "ENV_VALUES",
    "Field",
    "MarketDataConfig",
    "NotificationsConfig",
    "REDACTED",
    "ResearchConfig",
    "SCHEMA",
    "all_field_specs",
    "load_config",
    "parse_dotenv_text",
    "read_dotenv",
]
