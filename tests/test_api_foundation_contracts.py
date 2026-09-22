"""P01-02 API foundation contract tests.

Covers: the backend package manifest (real scripts, approved stack), the API
foundation structure (middleware, HTTP kernel, health/echo/catch-all routes),
server-only and env boundaries, safety contracts (no broker/strategy code, no
secrets, no NEXT_PUBLIC_*, no frontend/quant imports), and a live boot smoke
test against the production build (structured errors, request-ID propagation,
health endpoint, validation fixture).

Pure Python stdlib ``unittest``. Deterministic for deterministic inputs. All
internal timestamps are UTC (ADR-0004).
"""

from __future__ import annotations

import contextlib
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
SRC = BACKEND / "src"

# Pins must match the frontend (ADR-0001 stack). SQLite is provided by Node 24;
# @fdbtrade/contracts workspace dep added in P02-01 (ADR-0009) — workspace
# packages are pinned by the workspace itself, not by a registry version.
EXPECTED_DEPS = {
    "@fdbtrade/contracts": "workspace:*",
    "next": "16.3.4",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.5.4",
}
EXPECTED_DEVDEPS = {
    "typescript": "5.9.3",
    "eslint": "9.39.5",
    "eslint-config-next": "16.3.4",
    "vitest": "4.1.11",
}

TRACE_ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def load_json(path: pathlib.Path):
    """Load JSON, failing loudly on malformed or missing input."""
    return json.loads(path.read_text(encoding="utf-8"))


def iter_backend_source():
    """All backend TypeScript source files (never node_modules/.next).

    Test fixtures under ``__tests__`` are excluded: they intentionally use
    dummy credential-like strings (``pw123456``, ``raw-token-abc``) that are
    documented as fake in the P01-04 contract tests.
    """
    for pattern in ("src/**/*.ts", "*.ts"):
        for path in BACKEND.glob(pattern):
            if "__tests__" in path.parts:
                continue
            yield path


def request_json(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], dict]:
    """Perform an HTTP request; return (status, headers, parsed JSON body)."""
    request = urllib.request.Request(url, data=data, method=method)
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            response_headers = {
                key.lower(): value for key, value in response.headers.items()
            }
            payload = response.read()
    except urllib.error.HTTPError as error:  # 4xx/5xx are expected here
        status = error.code
        response_headers = {
            key.lower(): value for key, value in error.headers.items()
        }
        payload = error.read()
    return status, response_headers, json.loads(payload.decode("utf-8"))


class BackendPackageContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pkg = load_json(BACKEND / "package.json")
        cls.scripts = cls.pkg["scripts"]

    def test_manifest_is_private_scoped_and_versioned(self):
        self.assertEqual(self.pkg["name"], "@fdbtrade/backend")
        self.assertIs(self.pkg["private"], True)
        self.assertEqual(self.pkg["version"], "0.1.0")

    def test_scripts_are_real_and_not_placeholder(self):
        """Regression guard: the P00 placeholder no-op scripts must not return."""
        for name in ("dev", "build", "start", "lint", "typecheck", "test"):
            self.assertIn(name, self.scripts)
            self.assertNotIn("no-op", self.scripts[name])

    def test_canonical_tool_commands(self):
        self.assertEqual(self.scripts["build"], "next build")
        self.assertEqual(self.scripts["start"], "next start -p 3100")
        self.assertEqual(self.scripts["dev"], "next dev -p 3100")
        self.assertEqual(self.scripts["typecheck"], "tsc --noEmit")
        self.assertEqual(self.scripts["test"], "vitest run")
        self.assertEqual(self.scripts["lint"], "eslint .")

    def test_approved_stack_dependencies_pinned_like_frontend(self):
        self.assertEqual(self.pkg["dependencies"], EXPECTED_DEPS)
        dev = self.pkg["devDependencies"]
        for name, version in EXPECTED_DEVDEPS.items():
            self.assertEqual(dev.get(name), version)


class ApiFoundationStructureContract(unittest.TestCase):
    REQUIRED_FILES = (
        "src/middleware.ts",
        "src/server-only.ts",
        "src/clock.ts",
        "src/env.ts",
        "src/http/errors.ts",
        "src/http/responses.ts",
        "src/http/validate.ts",
        "src/http/handler.ts",
        "src/http/request-context.ts",
        "src/app/api/health/route.ts",
        "src/app/api/echo/route.ts",
        "src/app/api/[...slug]/route.ts",
        "tsconfig.json",
        "next.config.ts",
        "eslint.config.mjs",
        "vitest.config.ts",
    )

    def test_required_files_exist(self):
        for rel in self.REQUIRED_FILES:
            with self.subTest(rel=rel):
                self.assertTrue((BACKEND / rel).is_file(), f"missing: {rel}")

    def test_backend_test_files_exist(self):
        for rel in (
            "src/http/__tests__/errors.test.ts",
            "src/http/__tests__/responses.test.ts",
            "src/http/__tests__/validate.test.ts",
            "src/http/__tests__/handler.test.ts",
            "src/http/__tests__/request-context.test.ts",
            "src/app/api/__tests__/routes.test.ts",
            "src/app/api/__tests__/echo.test.ts",
        ):
            with self.subTest(rel=rel):
                self.assertTrue((BACKEND / rel).is_file(), f"missing: {rel}")

    def test_middleware_matches_api_paths_and_sets_trace_headers(self):
        text = (SRC / "middleware.ts").read_text(encoding="utf-8")
        self.assertIn('matcher: ["/api/:path*"]', text)
        for token in (
            "getOrCreateRequestId",
            "getOrCreateCorrelationId",
            "REQUEST_ID_HEADER",
            "CORRELATION_ID_HEADER",
        ):
            self.assertIn(token, text)
        # The concrete header names are defined once in request-context.ts.
        context_text = (SRC / "http/request-context.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn('"x-request-id"', context_text)
        self.assertIn('"x-correlation-id"', context_text)

    def test_health_route_registers_get_and_structured_405(self):
        text = (SRC / "app/api/health/route.ts").read_text(encoding="utf-8")
        self.assertIn("export const GET", text)
        self.assertIn("methodNotAllowed", text)

    def test_structured_error_codes_are_stable(self):
        text = (SRC / "http/errors.ts").read_text(encoding="utf-8")
        for code in (
            "VALIDATION_ERROR",
            "INVALID_JSON",
            "UNSUPPORTED_MEDIA_TYPE",
            "PAYLOAD_TOO_LARGE",
            "NOT_FOUND",
            "METHOD_NOT_ALLOWED",
            "INTERNAL_ERROR",
        ):
            self.assertIn(f'"{code}"', text)

    def test_validation_orders_content_type_size_json_schema(self):
        text = (SRC / "http/validate.ts").read_text(encoding="utf-8")
        positions = [
            text.index("unsupportedMediaType"),
            text.index("payloadTooLarge"),
            text.index("invalidJson"),
            text.index("ApiError.validation"),
        ]
        self.assertEqual(positions, sorted(positions))


class ApiFoundationSafetyContract(unittest.TestCase):
    FORBIDDEN_TOKENS = re.compile(
        r"(?i)(submit\s*order|place\s*order|send\s*order|cancel\s*order"
        r"|metatrader|\bmt5\b|\bbroker\b|order\s*api)"
    )
    FRONTEND_OR_QUANT_IMPORT = re.compile(
        r"""from\s+["'][^"']*\b(frontend|quant)\b[^"']*["']"""
    )
    SECRET_PATTERNS = re.compile(
        r"(?i)(sk-[A-Za-z0-9]{16,}"
        r"|(api[_-]?key|secret|password|passphrase|access[_-]?token)"
        r"""\s*[:=]\s*["'][^"']{4,}["'])"""
    )

    def test_no_trading_or_broker_logic_in_api_source(self):
        for path in iter_backend_source():
            match = self.FORBIDDEN_TOKENS.search(
                path.read_text(encoding="utf-8")
            )
            self.assertIsNone(
                match, f"forbidden trading/broker token in {path}: {match!r}"
            )

    def test_no_imports_from_frontend_or_quant_packages(self):
        for path in iter_backend_source():
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(
                self.FRONTEND_OR_QUANT_IMPORT.search(text),
                f"forbidden cross-package import in {path}",
            )

    def test_no_obvious_secrets_in_backend_source(self):
        for path in iter_backend_source():
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(
                self.SECRET_PATTERNS.search(text),
                f"potential secret literal in {path}",
            )

    def test_no_env_files_inside_backend(self):
        leaks = [str(p) for p in BACKEND.glob(".env*")]
        self.assertEqual(leaks, [], "backend must not carry .env files")

    def test_env_module_is_the_only_process_env_reader_and_is_server_only(self):
        """`process.env` is read only in src/env.ts, guarded server-only."""
        env_text = (SRC / "env.ts").read_text(encoding="utf-8")
        self.assertIn("assertServerOnly()", env_text)
        self.assertIn("process.env", env_text)
        for path in iter_backend_source():
            if path == SRC / "env.ts":
                continue
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(
                "process.env",
                text,
                f"process.env must only be read in src/env.ts (found in {path})",
            )

    def test_no_next_public_variables(self):
        """Nothing may leak into a browser bundle via NEXT_PUBLIC_*."""
        for path in iter_backend_source():
            self.assertNotIn(
                "NEXT_PUBLIC_",
                path.read_text(encoding="utf-8"),
                f"NEXT_PUBLIC_ variable in {path}",
            )

    def test_timestamps_are_utc_iso(self):
        text = (SRC / "clock.ts").read_text(encoding="utf-8")
        self.assertIn("toISOString", text)
        self.assertIn("UTC", text)

    def test_vitest_runs_in_node_with_src_alias(self):
        text = (BACKEND / "vitest.config.ts").read_text(encoding="utf-8")
        self.assertIn('environment: "node"', text)
        self.assertIn('include: ["src/**/*.test.ts"]', text)
        self.assertIn('"@"', text)

    def test_tsconfig_is_strict_with_src_alias(self):
        tsconfig = load_json(BACKEND / "tsconfig.json")
        self.assertIs(tsconfig["compilerOptions"]["strict"], True)
        self.assertEqual(
            tsconfig["compilerOptions"]["paths"], {"@/*": ["./src/*"]}
        )


class LiveBootSmokeTest(unittest.TestCase):
    """Boot source against temporary SQLite and exercise the API end to end."""

    proc: subprocess.Popen | None = None
    port: int = 0

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="fdbtrade-api-")
        cls.env = {
            **os.environ,
            "FDB_APP_ENV": "testing",
            "FDB_DATA_ROOT": cls.temp_dir.name,
        }
        migrated = subprocess.run(
            ["corepack", "pnpm", "--filter", "@fdbtrade/backend", "run", "db:migrate"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
            env=cls.env,
        )
        if migrated.returncode != 0:
            cls.temp_dir.cleanup()
            raise RuntimeError(migrated.stdout + migrated.stderr)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.proc = subprocess.Popen(
            [
                "corepack",
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "exec",
                "next",
                "dev",
                "-p",
                str(cls.port),
            ],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=cls.env,
        )
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if cls.proc.poll() is not None:
                break
            try:
                request_json(f"http://127.0.0.1:{cls.port}/api/health")
                return
            except Exception:
                time.sleep(1)
        cls._shutdown()
        cls.temp_dir.cleanup()
        raise RuntimeError("backend dev server did not become ready")

    @classmethod
    def _shutdown(cls):
        if cls.proc is None:
            return
        try:
            os.killpg(cls.proc.pid, signal.SIGTERM)
            cls.proc.wait(timeout=30)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(cls.proc.pid, signal.SIGKILL)
        cls.proc = None

    @classmethod
    def tearDownClass(cls):
        cls._shutdown()
        cls.temp_dir.cleanup()

    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


    def test_health_endpoint_is_healthy_and_traceable(self):
        status, headers, body = request_json(f"{self.base_url()}/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        # P01-03: overall status is "ok" or "degraded" (no local database in
        # a clean room); it must be consistent with checks.database.
        self.assertIn(body["data"]["status"], ("ok", "degraded"))
        self.assertIn(
            body["data"]["checks"]["database"], ("ok", "unavailable")
        )
        expected = (
            "ok"
            if body["data"]["checks"]["database"] == "ok"
            else "degraded"
        )
        self.assertEqual(body["data"]["status"], expected)
        self.assertEqual(body["data"]["service"], "fdbtrade-api")
        self.assertTrue(body["timestamp"].endswith("Z"))
        request_id = headers.get("x-request-id")
        self.assertTrue(request_id and TRACE_ID_OK.match(request_id))
        self.assertEqual(body["requestId"], request_id)
        self.assertTrue(headers.get("x-correlation-id"))

    def test_incoming_request_id_is_round_tripped(self):
        status, headers, body = request_json(
            f"{self.base_url()}/api/health",
            headers={"X-Request-Id": "py-contract-req-0001"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("x-request-id"), "py-contract-req-0001")
        self.assertEqual(body["requestId"], "py-contract-req-0001")

    def test_malformed_request_id_is_replaced_not_trusted(self):
        _, headers, _ = request_json(
            f"{self.base_url()}/api/health",
            headers={"X-Request-Id": "bad id with spaces!!"},
        )
        incoming = headers.get("x-request-id", "")
        self.assertNotIn("bad id with spaces", incoming)
        self.assertTrue(TRACE_ID_OK.match(incoming))

    def test_unknown_api_path_returns_structured_404_with_id(self):
        status, headers, body = request_json(
            f"{self.base_url()}/api/definitely-not-here"
        )
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "NOT_FOUND")
        self.assertTrue(TRACE_ID_OK.match(headers.get("x-request-id", "")))

    def test_wrong_method_returns_structured_405_with_allow(self):
        status, headers, body = request_json(
            f"{self.base_url()}/api/health",
            method="POST",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 405)
        self.assertEqual(body["error"]["code"], "METHOD_NOT_ALLOWED")
        self.assertIn("GET", headers.get("allow", ""))
        self.assertTrue(TRACE_ID_OK.match(headers.get("x-request-id", "")))


    def test_echo_fixture_accepts_valid_json(self):
        status, _, body = request_json(
            f"{self.base_url()}/api/echo",
            method="POST",
            data=json.dumps({"message": "ping", "count": 2}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["data"]["message"], "ping")
        self.assertEqual(body["data"]["count"], 2)

    def test_echo_fixture_rejects_invalid_json_with_structured_400(self):
        status, _, body = request_json(
            f"{self.base_url()}/api/echo",
            method="POST",
            data=b"{nope",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "INVALID_JSON")

    def test_echo_fixture_rejects_schema_violation_with_field_details(self):
        status, _, body = request_json(
            f"{self.base_url()}/api/echo",
            method="POST",
            data=b"{\"count\": 2}",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "VALIDATION_ERROR")
        details = body["error"]["details"]
        self.assertTrue(details)
        self.assertEqual(details[0]["path"], "message")

    def test_echo_fixture_rejects_wrong_content_type_with_415(self):
        status, _, body = request_json(
            f"{self.base_url()}/api/echo",
            method="POST",
            data=b"plain text",
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(status, 415)
        self.assertEqual(body["error"]["code"], "UNSUPPORTED_MEDIA_TYPE")


if __name__ == "__main__":
    unittest.main()
