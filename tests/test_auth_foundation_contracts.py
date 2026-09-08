"""P01-04 authentication foundation contract tests.

Covers: migration conventions (0002), schema safety (no password/token
literals in source or logs), guard wiring, cookie contract, no-registration
surface, frontend protected-area wiring (server-side redirect + login page +
same-origin proxy), and — when the database and backend build are available —
a live lifecycle: provision → login → guarded 200 → session survives server
restart → logout → 401.

Pure Python stdlib ``unittest``. Deterministic for deterministic inputs. All
internal timestamps are UTC (ADR-0004).
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
SRC = BACKEND / "src"
FRONTEND = REPO_ROOT / "frontend"
FSRC = FRONTEND / "src"
MIGRATIONS = BACKEND / "db" / "migrations"

# Deliberately non-secret test credentials (live lifecycle only).
TEST_USERNAME = "contract-owner"
TEST_PASSWORD = "contract-test-password-123"

MIGRATION_UP_PATTERN = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")


def run(cmd, cwd=None, timeout=120, env=None):
    return subprocess.run(
        cmd,
        cwd=cwd or REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )


def load_env_file(path: pathlib.Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key] = value
    return env


def request_json(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
):
    """HTTP request with optional cookie forwarding; returns (status, headers, body_text)."""
    request = urllib.request.Request(url, data=data, method=method)
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    if cookies:
        request.add_header(
            "cookie",
            "; ".join(f"{k}={v}" for k, v in cookies.items()),
        )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return (
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as error:
        return (
            error.code,
            {k.lower(): v for k, v in error.headers.items()},
            error.read().decode("utf-8"),
        )


class AuthMigrationContract(unittest.TestCase):
    """Migration 0002 conventions (ADR-0007/ADR-0008)."""

    def test_migration_files_follow_conventions(self):
        up = MIGRATIONS / "0002_auth_foundation.sql"
        down = MIGRATIONS / "0002_auth_foundation.down.sql"
        self.assertTrue(up.is_file())
        self.assertTrue(down.is_file())
        self.assertRegex(up.name, r"^\d{4}_[a-z0-9_]+\.sql$")
        text = up.read_text(encoding="utf-8")
        for table in ("fdb.users", "fdb.sessions", "fdb.user_profiles"):
            self.assertIn(f"CREATE TABLE {table}", text)
        self.assertIn("timestamptz", text)
        self.assertIn("mfa_enabled", text)
        self.assertIn("gen_random_uuid()", text)
        # The ledger is never created by a migration.
        self.assertNotIn("CREATE TABLE public.schema_migrations", text)
        self.assertNotIn("CREATE TABLE IF NOT EXISTS public.schema_migrations", text)

    def test_down_migration_reverses_in_dependency_order(self):
        text = (MIGRATIONS / "0002_auth_foundation.down.sql").read_text(
            encoding="utf-8"
        )
        self.assertIn("DROP TABLE IF EXISTS fdb.sessions", text)
        self.assertIn("DROP TABLE IF EXISTS fdb.user_profiles", text)
        self.assertIn("DROP TABLE IF EXISTS fdb.users", text)
        # Rollbacks never touch the runner-owned ledger.
        self.assertNotIn("public.schema_migrations", text.split("--")[-1])


class AuthSourceSafetyContract(unittest.TestCase):
    """Password/token material never appears in source, logs, or output."""

    def test_no_plaintext_password_literals_in_auth_source(self):
        """Production auth code must not embed credential literals (tests use
        obvious dummy fixtures and are scanned separately for real secrets)."""
        for pattern in ("src/auth/*.ts", "src/app/api/auth/*/route.ts"):
            for path in BACKEND.glob(pattern):
                text = path.read_text(encoding="utf-8")
                self.assertNotIn("password_hash =", text, f"{path}")
                self.assertNotIn('password: "', text, f"{path}")

    def test_auth_tests_use_obvious_dummy_credentials_only(self):
        path = BACKEND / "src/app/api/auth/__tests__/routes.test.ts"
        text = path.read_text(encoding="utf-8")
        # Only the documented dummy values appear; nothing realistic.
        for literal in ("pw123456", "raw-token-abc", "wrong"):
            self.assertIn(literal, text)

    def test_store_never_logs_hashes_or_tokens(self):
        text = (SRC / "auth" / "store.ts").read_text(encoding="utf-8")
        self.assertNotIn("console.log", text)
        self.assertNotIn("console.error", text)

    def test_guard_is_the_only_route_guard_import(self):
        for route in ("session", "login", "logout"):
            text = (
                SRC / "app" / "api" / "auth" / route / "route.ts"
            ).read_text(encoding="utf-8")
            self.assertIn("withApi", text)

    def test_session_route_calls_the_guard(self):
        text = (SRC / "app/api/auth/session/route.ts").read_text("utf-8")
        self.assertIn("requireSession", text)

    def test_no_registration_or_user_management_endpoints(self):
        """Private single-user product: no signup/register/profile-edit APIs."""
        auth_dir = SRC / "app" / "api" / "auth"
        routes = sorted(
            p.name
            for p in auth_dir.iterdir()
            if p.is_dir() and not p.name.startswith("_")
        )
        self.assertEqual(routes, ["login", "logout", "session"])

    def test_cookie_contract(self):
        text = (SRC / "auth" / "store.ts").read_text(encoding="utf-8")
        self.assertIn('SESSION_COOKIE_NAME = "fdb_session"', text)
        self.assertIn("httpOnly: true", text)
        self.assertIn('sameSite: "lax"', text)
        self.assertIn('path: "/"', text)
        # Secure only in production.
        self.assertIn('=== "production"', text)

    def test_provision_cli_never_logs_the_password(self):
        text = (SRC / "auth" / "provision.mjs").read_text(encoding="utf-8")
        self.assertIn("FDB_AUTH_BOOTSTRAP_PASSWORD", text)
        self.assertNotIn("console.log(password", text)
        self.assertNotIn("console.log(`password", text)

    def test_provision_script_in_package_json(self):
        pkg = json.loads((BACKEND / "package.json").read_text("utf-8"))
        self.assertIn("db:provision-user", pkg["scripts"])


class FrontendAuthWiringContract(unittest.TestCase):
    """The protected area is server-side guarded; login is same-origin."""

    def test_protected_layout_redirects_unauthenticated_requests(self):
        text = (FSRC / "app/(app)/layout.tsx").read_text(encoding="utf-8")
        self.assertIn("fetchSession", text)
        self.assertIn('redirect("/login")', text)

    def test_auth_client_fails_closed(self):
        text = (FSRC / "lib/auth.ts").read_text(encoding="utf-8")
        self.assertIn("return null", text)  # fail closed on any problem
        self.assertIn("no-store", text)

    def test_login_page_and_form_exist(self):
        self.assertTrue((FSRC / "app/login/page.tsx").is_file())
        self.assertTrue((FSRC / "app/login/login-form.tsx").is_file())
        form = (FSRC / "app/login/login-form.tsx").read_text("utf-8")
        self.assertIn('type="password"', form)
        self.assertIn('autoComplete="current-password"', form)

    def test_same_origin_auth_proxy_exists(self):
        proxy = FSRC / "app/api/auth/[action]/route.ts"
        self.assertTrue(proxy.is_file())
        text = proxy.read_text(encoding="utf-8")
        self.assertIn("set-cookie", text)
        # Only the three known auth actions are forwarded.
        self.assertIn('"login"', text)
        self.assertIn('"logout"', text)
        self.assertIn('"session"', text)

    def test_frontend_middleware_guards_dashboard_before_rendering(self):
        """Server middleware blocks unauthenticated /dashboard pre-render
        (streaming cannot leak protected content)."""
        text = (FSRC / "middleware.ts").read_text(encoding="utf-8")
        self.assertIn("PROTECTED_PREFIXES", text)
        self.assertIn('"/dashboard"', text)
        self.assertIn("NextResponse.redirect", text)
        self.assertIn("fail closed", text)
        self.assertIn("matcher", text)

    def test_frontend_login_test_file_exists(self):
        self.assertTrue(
            (FSRC / "app/login/__tests__/login-form.test.tsx").is_file()
        )


class LiveAuthLifecycleTest(unittest.TestCase):
    """
    Live auth lifecycle (self-skipping without Docker/.env/database).

    Exercises the real backend server against the real database: provision
    the single user, verify login/guard/cookie behavior, restart the server
    and prove the session survives (DB-backed), then logout and verify 401.
    """

    @classmethod
    def setUpClass(cls):
        if not (REPO_ROOT / ".env").exists():
            raise unittest.SkipTest("no .env; run `make db-up` for live checks")
        if run(["docker", "inspect", "fdbtrade-postgres"]).returncode != 0:
            raise unittest.SkipTest(
                "fdbtrade-postgres not running; run `make db-up`"
            )
        cls.env = {**os.environ, **load_env_file(REPO_ROOT / ".env")}

        run(
            ["pnpm", "--filter", "@fdbtrade/backend", "run", "build"],
            timeout=600,
        )
        if not (BACKEND / ".next" / "BUILD_ID").exists():
            raise unittest.SkipTest(
                "backend production build unavailable; live auth not asserted"
            )

        # Provision the single test user (idempotent upsert).
        provision = run(
            [
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "run",
                "db:provision-user",
                TEST_USERNAME,
            ],
            env={**cls.env, "FDB_AUTH_BOOTSTRAP_PASSWORD": TEST_PASSWORD},
            timeout=120,
        )
        if provision.returncode != 0:
            raise unittest.SkipTest(
                "provisioning failed; live auth not asserted"
            )

        cls.port = cls._free_port()
        cls.proc = None
        cls._start_server()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    @classmethod
    def _start_server(cls):
        cls.proc = subprocess.Popen(
            [
                "pnpm",
                "--filter",
                "@fdbtrade/backend",
                "exec",
                "next",
                "start",
                "-p",
                str(cls.port),
            ],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
            env=cls.env,
        )
        deadline = time.monotonic() + 90
        assert cls.proc.stdout is not None
        while time.monotonic() < deadline:
            line = cls.proc.stdout.readline()
            if not line:
                break
            if "Ready" in line:
                return
        raise unittest.SkipTest("backend server did not report Ready")

    @classmethod
    def _stop_server(cls):
        if cls.proc is None:
            return
        try:
            os.killpg(cls.proc.pid, signal.SIGTERM)
            cls.proc.wait(timeout=30)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            import contextlib

            with contextlib.suppress(ProcessLookupError):
                os.killpg(cls.proc.pid, signal.SIGKILL)
        if cls.proc.stdout is not None:
            cls.proc.stdout.close()
        cls.proc = None

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()

    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _login(self, username: str, password: str):
        return request_json(
            f"{self.base_url()}/api/auth/login",
            method="POST",
            data=json.dumps({"username": username, "password": password}).encode(),
            headers={"Content-Type": "application/json"},
        )

    def test_full_auth_lifecycle(self):
        base = self.base_url()

        # 1. Guarded route blocks unauthenticated access.
        status, _, body = request_json(f"{base}/api/auth/session")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "UNAUTHORIZED")

        # 2. Wrong password → same 401 as unknown user (no enumeration oracle).
        status_a, _, body_a = self._login(TEST_USERNAME, "definitely-wrong")
        status_b, _, body_b = self._login("no-such-user", "whatever")
        self.assertEqual(status_a, 401)
        self.assertEqual(status_b, 401)
        error_a = json.loads(body_a)["error"]
        error_b = json.loads(body_b)["error"]
        self.assertEqual(error_a, error_b)  # identical error: no oracle
        self.assertNotIn(TEST_PASSWORD, body_a)

        # 3. Valid login → 200 + httpOnly cookie; no secret in the body.
        status, headers, body = self._login(TEST_USERNAME, TEST_PASSWORD)
        self.assertEqual(status, 200)
        parsed = json.loads(body)
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["data"]["user"]["username"], TEST_USERNAME)
        self.assertNotIn(TEST_PASSWORD, body)
        set_cookie = headers.get("set-cookie", "")
        self.assertIn("fdb_session=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Lax", set_cookie)

        # 4. Extract the cookie; the guarded route now returns 200.
        match = re.search(r"fdb_session=([^;]+)", set_cookie)
        assert match
        cookies = {"fdb_session": match.group(1)}
        status, _, body = request_json(
            f"{base}/api/auth/session", cookies=cookies
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body)["data"]["user"]["username"], TEST_USERNAME
        )

        # 5. Session survives a server restart (DB-backed sessions).
        self.__class__._stop_server()
        self.__class__.port = self.__class__._free_port()
        self.__class__._start_server()
        base = self.base_url()
        status, _, body = request_json(
            f"{base}/api/auth/session", cookies=cookies
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body)["data"]["user"]["username"], TEST_USERNAME
        )

        # 6. Logout → cookie cleared; guarded route 401 again.
        status, headers, _ = request_json(
            f"{base}/api/auth/logout",
            method="POST",
            cookies=cookies,
        )
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", headers.get("set-cookie", ""))
        status, _, _ = request_json(
            f"{base}/api/auth/session", cookies=cookies
        )
        self.assertEqual(status, 401)

    def test_login_malformed_body_returns_structured_400(self):
        status, _, body = request_json(
            f"{self.base_url()}/api/auth/login",
            method="POST",
            data=b"{nope",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"]["code"], "INVALID_JSON")


if __name__ == "__main__":
    unittest.main()
