"""CLI entry point for the FdbTrade config contract (P00-03).

Usage (from the repository root):

    python -m infra.config                    # redacted JSON (safe to log)
    python -m infra.config --public           # frontend-safe public config only
    python -m infra.config --dotenv .env --format text

Never prints a real secret: the default view redacts secrets and the
``--public`` view only emits public-safe fields.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import ConfigError, load_config


def _print_text(sections: dict[str, dict[str, object]]) -> None:
    for namespace, fields in sections.items():
        for name, value in fields.items():
            print(f"{namespace}.{name} = {value}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FdbTrade config (redacted by default).")
    parser.add_argument("--dotenv", default=None, help="Path to a local .env file.")
    parser.add_argument(
        "--public",
        action="store_true",
        help="Print only the public-safe config (frontend-bound).",
    )
    parser.add_argument("--format", choices=("json", "text"), default="json")
    args = parser.parse_args(argv)

    try:
        config = load_config(dotenv_path=args.dotenv)
    except ConfigError as exc:
        print(f"ConfigError: {exc}", file=sys.stderr)
        return 1

    data = config.to_public_dict() if args.public else config.to_redacted_dict()
    if args.format == "json":
        print(json.dumps(data, indent=2, sort_keys=False))
    else:
        _print_text(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())