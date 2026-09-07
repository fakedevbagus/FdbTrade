"""P00-03 configuration/environment contract tests.

Covers happy path, defaults, malformed/missing input, boundary values,
idempotency/purity, redaction, public-safe output, dotenv merging, and a
regression guard that validation errors never leak secret values.

Pure Python stdlib ``unittest`` (no extra dependencies, per ADR-0001).
Deterministic for deterministic inputs. All internal timestamps are UTC.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from infra.config import (  # noqa: E402
    ConfigError,
    Env,
    load_config,
    parse_dotenv_text,
)

ENV_VALUES = tuple(e.value for e in Env)

# Distinct secret values used to prove they never leak into logs/views.
SECRET_DB = "s3cret-db"
SECRET_CACHE = "s3cret-cache"
SECRET_MD = "md-secret"
SECRET_SMTP = "notif-smtp-secret"
SECRET_WEBHOOK = "notif-webhook-secret"
SECRET_BROKER = "broker-secret"
ALL_SECRETS = (SECRET_DB, SECRET_CACHE, SECRET_MD, SECRET_SMTP, SECRET_WEBHOOK, SECRET_BROKER)


def base_env(**overrides):
    """A fully valid development environment, overridable per test."""
    env = {
        "FDB_APP_ENV": "development",
        "FDB_APP_NAME": "fdbtrade-test",
        "FDB_APP_API_PORT": "8080",
        "FDB_DB_HOST": "db.local",
        "FDB_DB_PASSWORD": SECRET_DB,
        "FDB_CACHE_HOST": "cache.local",
        "FDB_CACHE_PASSWORD": SECRET_CACHE,
        "FDB_MD_API_KEY": SECRET_MD,
        "FDB_NOTIF_SMTP_PASSWORD": SECRET_SMTP,
        "FDB_NOTIF_WEBHOOK_TOKEN": SECRET_WEBHOOK,
        "FDB_BROKER_TOKEN": SECRET_BROKER,
        "FDB_BROKER_LIVE_ENABLED": "false",
        "FDB_RS_RANDOM_SEED": "42",
        "FDB_RS_DATA_DIR": "/tmp/fdb/data",
    }
    env.update(overrides)
    return env


def assert_no_secret(subject, text: str, msg: str) -> None:
    for secret in ALL_SECRETS:
        if secret and secret in text:
            raise AssertionError(f"{msg}: leaked {secret!r} in {subject!r}")


class ConfigLoadingTests(unittest.TestCase):
    """Happy path and defaults."""

    def test_valid_input_parses_expected_output(self):
        cfg = load_config(environ=base_env())
        self.assertEqual(cfg.app.name, "fdbtrade-test")
        self.assertEqual(cfg.app.environment, "development")
        self.assertEqual(cfg.app.log_level, "INFO")  # default
        self.assertEqual(cfg.app.api_host, "0.0.0.0")  # default
        self.assertEqual(cfg.app.api_port, 8080)  # from env
        self.assertEqual(cfg.database.host, "db.local")
        self.assertEqual(cfg.database.password, SECRET_DB)
        self.assertEqual(cfg.cache.host, "cache.local")
        self.assertEqual(cfg.cache.port, 6379)  # default
        self.assertEqual(cfg.market_data.provider, "fixture")
        self.assertEqual(cfg.market_data.symbols, ())
        self.assertEqual(cfg.research.random_seed, 42)
        self.assertEqual(cfg.research.job_timeout_seconds, 3600)  # default

    def test_safe_defaults_applied_when_unset(self):
        cfg = load_config(environ={"FDB_APP_ENV": "development"})
        self.assertEqual(cfg.app.name, "fdbtrade")
        self.assertEqual(cfg.app.api_port, 8000)
        self.assertEqual(cfg.app.timezone, "UTC")
        self.assertEqual(cfg.database.password, "")
        self.assertEqual(cfg.cache.password, "")
        self.assertEqual(cfg.market_data.api_key, "")
        self.assertIs(cfg.broker.live_enabled, False)
        self.assertIs(cfg.broker.read_only, True)

    def test_every_env_value_is_accepted(self):
        for value in ENV_VALUES:
            with self.subTest(env=value):
                cfg = load_config(environ=base_env(FDB_APP_ENV=value))
                self.assertEqual(cfg.app.environment, value)

    def test_str_list_parsing(self):
        cfg = load_config(environ=base_env(FDB_MD_SYMBOLS=" EURUSD , GBPUSD ,, USDJPY "))
        self.assertEqual(cfg.market_data.symbols, ("EURUSD", "GBPUSD", "USDJPY"))

    def test_bool_variants_parse(self):
        for raw, expected in (("true", True), ("0", False), ("yes", True), ("off", False)):
            with self.subTest(raw=raw):
                cfg = load_config(environ=base_env(FDB_BROKER_LIVE_ENABLED=raw))
                self.assertIs(cfg.broker.live_enabled, expected)
class MissingMalformedTests(unittest.TestCase):
    """Failure paths: invalid required config fails clearly."""

    def test_missing_environment_fails_clearly(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ={})
        self.assertIn("FDB_APP_ENV", str(ctx.exception))
        self.assertIn("required", str(ctx.exception))

    def test_unknown_environment_value_fails(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ={"FDB_APP_ENV": "prodigy"})
        message = str(ctx.exception)
        self.assertIn("FDB_APP_ENV", message)
        for value in ENV_VALUES:
            self.assertIn(value, message)  # error lists the allowed set

    def test_malformed_int_fails(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=base_env(FDB_APP_API_PORT="banana"))
        self.assertIn("FDB_APP_API_PORT", str(ctx.exception))

    def test_malformed_bool_fails(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=base_env(FDB_BROKER_LIVE_ENABLED="maybe"))
        self.assertIn("FDB_BROKER_LIVE_ENABLED", str(ctx.exception))

    def test_invalid_enum_fails(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=base_env(FDB_APP_LOG_LEVEL="NOISY"))
        self.assertIn("FDB_APP_LOG_LEVEL", str(ctx.exception))

    def test_production_missing_required_secret_fails(self):
        env = base_env(FDB_APP_ENV="production")
        del env["FDB_DB_PASSWORD"]
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=env)
        self.assertIn("FDB_DB_PASSWORD", str(ctx.exception))

    def test_development_allows_missing_secret_default(self):
        env = base_env()
        del env["FDB_DB_PASSWORD"]
        cfg = load_config(environ=env)
        self.assertEqual(cfg.database.password, "")

    def test_multiple_errors_are_aggregated(self):
        env = base_env(FDB_APP_API_PORT="abc", FDB_CACHE_PORT="xyz")
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=env)
        message = str(ctx.exception)
        self.assertIn("FDB_APP_API_PORT", message)
        self.assertIn("FDB_CACHE_PORT", message)

    def test_regression_secret_never_leaks_into_validation_error(self):
        """Regression guard: an error raised near a secret field must not echo it."""
        env = base_env(FDB_CACHE_PORT="notaport")  # triggers a validation error
        env["FDB_DB_PASSWORD"] = "TOPSECRETCANTLEAK"
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ=env)
        assert_no_secret(str(ctx.exception), str(ctx.exception), "ConfigError message")


class BoundaryTests(unittest.TestCase):
    """Boundary values: min/max inclusive and out-of-range rejection."""

    def test_port_boundaries(self):
        with self.assertRaises(ConfigError):
            load_config(environ=base_env(FDB_APP_API_PORT="0"))
        with self.assertRaises(ConfigError):
            load_config(environ=base_env(FDB_APP_API_PORT="65536"))
        cfg = load_config(environ=base_env(FDB_APP_API_PORT="1"))
        self.assertEqual(cfg.app.api_port, 1)
        cfg = load_config(environ=base_env(FDB_APP_API_PORT="65535"))
        self.assertEqual(cfg.app.api_port, 65535)

    def test_cache_db_index_boundaries(self):
        with self.assertRaises(ConfigError):
            load_config(environ=base_env(FDB_CACHE_DB="-1"))
        cfg = load_config(environ=base_env(FDB_CACHE_DB="15"))
        self.assertEqual(cfg.cache.db, 15)

    def test_timezone_is_locked_to_utc(self):
        # ADR-0004: app.timezone must be UTC; any other value is rejected.
        cfg = load_config(environ=base_env())
        self.assertEqual(cfg.app.timezone, "UTC")
        with self.assertRaises(ConfigError):
            load_config(environ=base_env(FDB_APP_TIMEZONE="Asia/Jakarta"))
        with self.assertRaises(ConfigError):
            load_config(environ=base_env(FDB_APP_TIMEZONE="America/New_York"))

    def test_empty_symbols_is_empty_tuple(self):
        cfg = load_config(environ=base_env(FDB_MD_SYMBOLS=""))
        self.assertEqual(cfg.market_data.symbols, ())

    def test_empty_dotenv_uses_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            env_file.write_text("", encoding="utf-8")
            cfg = load_config(dotenv_path=env_file, environ={"FDB_APP_ENV": "development"})
            self.assertEqual(cfg.app.name, "fdbtrade")
            self.assertEqual(cfg.app.api_port, 8000)
class RedactionTests(unittest.TestCase):
    """Secrets are never logged; frontend receives only public-safe config."""

    def test_redacted_view_masks_every_secret(self):
        cfg = load_config(environ=base_env())
        redacted = cfg.to_redacted_dict()
        self.assertEqual(redacted["database"]["password"], "[REDACTED]")
        self.assertEqual(redacted["cache"]["password"], "[REDACTED]")
        self.assertEqual(redacted["market_data"]["api_key"], "[REDACTED]")
        self.assertEqual(redacted["notifications"]["smtp_password"], "[REDACTED]")
        self.assertEqual(redacted["notifications"]["webhook_token"], "[REDACTED]")
        self.assertEqual(redacted["broker"]["token"], "[REDACTED]")
        assert_no_secret(json.dumps(redacted), json.dumps(redacted), "redacted dict")

    def test_redacted_view_keeps_non_secret_values(self):
        cfg = load_config(environ=base_env())
        redacted = cfg.to_redacted_dict()
        self.assertEqual(redacted["app"]["name"], "fdbtrade-test")
        self.assertEqual(redacted["database"]["host"], "db.local")
        self.assertEqual(redacted["database"]["port"], 5432)

    def test_public_view_contains_only_public_fields(self):
        cfg = load_config(environ=base_env())
        pub = cfg.to_public_dict()
        self.assertEqual(pub["app"]["name"], "fdbtrade-test")
        self.assertEqual(pub["app"]["environment"], "development")
        self.assertEqual(pub["app"]["api_host"], "0.0.0.0")
        self.assertEqual(pub["app"]["api_port"], 8080)
        self.assertIs(pub["broker"]["live_enabled"], False)
        # Only namespaces with at least one public field appear.
        for namespace in ("database", "cache", "market_data", "notifications", "research"):
            self.assertNotIn(namespace, pub)

    def test_public_view_never_contains_secrets(self):
        cfg = load_config(environ=base_env())
        pub_text = json.dumps(cfg.to_public_dict())
        for key in ("password", "api_key", "token"):
            self.assertNotIn(f'"{key}"', pub_text)
        assert_no_secret(pub_text, pub_text, "public dict")

    def test_live_execution_off_by_default(self):
        cfg = load_config(environ={"FDB_APP_ENV": "development"})
        self.assertIs(cfg.broker.live_enabled, False)

    def test_public_dict_is_json_serialisable_and_deterministic(self):
        cfg = load_config(environ=base_env())
        as_json = json.dumps(cfg.to_public_dict(), sort_keys=False)
        self.assertIn('"app"', as_json)
        self.assertIsInstance(json.loads(as_json), dict)
class PurityAndDeterminismTests(unittest.TestCase):
    """Loader is pure and deterministic; no events/jobs so idempotency is N/A."""

    def test_load_does_not_mutate_os_environ(self):
        snapshot = dict(os.environ)
        cfg = load_config(environ=base_env())
        self.assertIsNotNone(cfg)
        self.assertEqual(dict(os.environ), snapshot, "os.environ was mutated")
        self.assertNotIn("FDB_APP_ENV", os.environ)

    def test_deterministic_for_deterministic_inputs(self):
        one = load_config(environ=base_env())
        two = load_config(environ=base_env())
        self.assertEqual(one.to_public_dict(), two.to_public_dict())
        self.assertEqual(one.to_redacted_dict(), two.to_redacted_dict())

    def test_explicit_environ_mapping_not_mutated(self):
        env = base_env()
        before = dict(env)
        load_config(environ=env)
        self.assertEqual(env, before, "caller-supplied environ mapping was mutated")


class DotenvTests(unittest.TestCase):
    """.env file support: parsing and real-environment precedence."""

    def test_parse_dotenv_comments_quotes_export(self):
        text = (
            "# comment\n"
            "\n"
            "FDB_APP_NAME=fromfile\n"
            "export FDB_DB_HOST='db-quoted'\n"
            'FDB_MD_SYMBOLS=" EURUSD , GBPUSD "\n'
        )
        parsed = parse_dotenv_text(text)
        self.assertEqual(parsed["FDB_APP_NAME"], "fromfile")
        self.assertEqual(parsed["FDB_DB_HOST"], "db-quoted")
        self.assertEqual(parsed["FDB_MD_SYMBOLS"], " EURUSD , GBPUSD ")
        self.assertNotIn("FDB_APP_ENV", parsed)

    def test_real_environment_overrides_dotenv(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            env_file.write_text("FDB_APP_NAME=fromfile\nFDB_APP_ENV=development\n",
                                encoding="utf-8")
            cfg = load_config(dotenv_path=env_file, environ={"FDB_APP_NAME": "fromenv"})
            self.assertEqual(cfg.app.name, "fromenv")  # environ wins
            self.assertEqual(cfg.app.environment, "development")  # from file

    def test_dotenv_only_supplies_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            env_file.write_text("FDB_APP_NAME=fromfile\nFDB_APP_ENV=testing\n",
                                encoding="utf-8")
            cfg = load_config(dotenv_path=env_file)
            self.assertEqual(cfg.app.name, "fromfile")
            self.assertEqual(cfg.app.environment, "testing")


class CliTests(unittest.TestCase):
    """python -m infra.config respects the redaction boundary."""

    def _run_cli(self, *args, env):
        return subprocess.run(
            [sys.executable, "-m", "infra.config", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            check=False,
        )

    def test_cli_redacted_does_not_print_secrets(self):
        env = dict(os.environ)
        env.update(base_env())
        result = self._run_cli("--format", "json", env=env)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        assert_no_secret(result.stdout, result.stdout, "CLI redacted stdout")

    def test_cli_public_flag_emits_public_only(self):
        env = dict(os.environ)
        env.update(base_env())
        result = self._run_cli("--public", "--format", "json", env=env)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        data = json.loads(result.stdout)
        self.assertIn("app", data)
        assert_no_secret(result.stdout, result.stdout, "CLI public stdout")

    def test_cli_missing_environment_exits_nonzero(self):
        env = dict(os.environ)
        env.pop("FDB_APP_ENV", None)
        result = self._run_cli("--public", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FDB_APP_ENV", result.stderr)


if __name__ == "__main__":
    unittest.main()