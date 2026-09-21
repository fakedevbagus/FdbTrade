#!/usr/bin/env python3
"""Bounded, machine-readable toolchain runner for the FdbTrade rebuild.

This is the single R0.3 entry point for dependency installation and the
lint/typecheck/test/build gate.  It deliberately does not inspect or mutate
product runtime state.  Corepack, pnpm, npm and Python caches live below the
gitignored ``artifacts/toolchain/cache`` directory by default, never below the
operator's home directory.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from typing import Sequence


SCHEMA_VERSION = 1
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_CACHE_ROOT = REPO_ROOT / "artifacts" / "toolchain" / "cache"
DEFAULT_REPORT_ROOT = REPO_ROOT / "artifacts" / "toolchain"
PACKAGE_ORDER = ("contracts", "backend", "frontend")
STAGE_ORDER = ("lint", "typecheck", "test", "build")
DEFAULT_TIMEOUTS = {
    "manager": 60,
    "install": 600,
    "lint": 240,
    "typecheck": 240,
    "test": 600,
    "build": 600,
}
ACTIONABLE_RE = re.compile(
    r"(?:\berror\b|\bfail(?:ed|ure)?\b|fatal|traceback|timed?\s*out|"
    r"permission|\berofs\b|\bts\d{4}\b|assertion)",
    re.IGNORECASE,
)
SKIPPED_RE = re.compile(
    r"(?:\bskipped\s*=\s*([1-9]\d*)\b|\|\s*([1-9]\d*)\s+skipped\b)",
    re.IGNORECASE,
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def cache_root() -> pathlib.Path:
    configured = os.environ.get("FDB_TOOLCHAIN_CACHE_DIR", "").strip()
    return pathlib.Path(configured).expanduser().resolve() if configured else DEFAULT_CACHE_ROOT


def toolchain_env(root: pathlib.Path) -> dict[str, str]:
    """Return an isolated environment without changing the caller's mapping."""
    env = dict(os.environ)
    env.update(
        {
            "COREPACK_HOME": str(root / "corepack"),
            "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "NPM_CONFIG_CACHE": str(root / "npm"),
            "PNPM_HOME": str(root / "pnpm-home"),
            "XDG_CACHE_HOME": str(root / "xdg"),
            "PYTHONDONTWRITEBYTECODE": "1",
            # The rebuild gate may inspect external-state adapters, but R0.3
            # never starts, migrates, provisions or otherwise mutates them.
            "FDB_TOOLCHAIN_EXTERNAL_STATE": "disabled",
        }
    )
    return env


@dataclasses.dataclass(frozen=True)
class CommandSpec:
    stage: str
    name: str
    argv: tuple[str, ...]
    cwd: pathlib.Path
    timeout_seconds: int


def display_path(path: pathlib.Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT)) or "."
    except ValueError:
        return str(path)


def display_command(spec: CommandSpec) -> str:
    return " ".join(spec.argv)


def bounded_tail(value: str | bytes | None, limit: int = 8_000) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    value = value.replace(str(REPO_ROOT), "$REPO_ROOT")
    return value[-limit:]


def first_actionable_failure(stdout: str, stderr: str, fallback: str) -> str:
    lines = [line.strip() for line in (stderr + "\n" + stdout).splitlines() if line.strip()]
    for line in lines:
        if ACTIONABLE_RE.search(line):
            return line[:500]
    return (lines[-1][:500] if lines else fallback)[:500]


def planned_result(spec: CommandSpec) -> dict[str, object]:
    return {
        "stage": spec.stage,
        "name": spec.name,
        "command": list(spec.argv),
        "cwd": display_path(spec.cwd),
        "timeoutSeconds": spec.timeout_seconds,
        "status": "planned",
        "exitCode": None,
        "durationMs": 0,
        "firstActionableFailure": None,
        "stdoutTail": "",
        "stderrTail": "",
    }


def skipped_result(spec: CommandSpec, reason: str) -> dict[str, object]:
    result = planned_result(spec)
    result.update(status="skipped", firstActionableFailure=reason)
    return result


def run_command(spec: CommandSpec, env: dict[str, str], dry_run: bool = False) -> dict[str, object]:
    if dry_run:
        return planned_result(spec)
    started = time.monotonic()
    executable = pathlib.Path(spec.argv[0])
    if (executable.is_absolute() or "/" in spec.argv[0]) and not executable.exists():
        duration_ms = round((time.monotonic() - started) * 1_000)
        result = planned_result(spec)
        result.update(
            status="fail",
            exitCode=127,
            durationMs=duration_ms,
            firstActionableFailure=f"required executable missing: {spec.argv[0]}",
        )
        return result
    try:
        completed = subprocess.run(
            spec.argv,
            cwd=spec.cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=spec.timeout_seconds,
            check=False,
        )
        duration_ms = round((time.monotonic() - started) * 1_000)
        stdout = bounded_tail(completed.stdout)
        stderr = bounded_tail(completed.stderr)
        skipped = SKIPPED_RE.search(stderr + "\n" + stdout)
        if completed.returncode != 0:
            status = "fail"
        elif skipped:
            status = "skipped"
        else:
            status = "pass"
        result = planned_result(spec)
        result.update(
            status=status,
            exitCode=completed.returncode,
            durationMs=duration_ms,
            firstActionableFailure=(
                f"command completed with {next(value for value in skipped.groups() if value)} "
                "skipped test(s); skipped is not pass"
                if skipped
                else (
                    None
                    if completed.returncode == 0
                    else first_actionable_failure(stdout, stderr, "command exited non-zero")
                )
            ),
            stdoutTail=stdout,
            stderrTail=stderr,
        )
        return result
    except subprocess.TimeoutExpired as error:
        duration_ms = round((time.monotonic() - started) * 1_000)
        stdout = bounded_tail(error.stdout)
        stderr = bounded_tail(error.stderr)
        result = planned_result(spec)
        result.update(
            status="timeout",
            exitCode=124,
            durationMs=duration_ms,
            firstActionableFailure=f"timed out after {spec.timeout_seconds}s",
            stdoutTail=stdout,
            stderrTail=stderr,
        )
        return result
    except OSError as error:
        duration_ms = round((time.monotonic() - started) * 1_000)
        result = planned_result(spec)
        result.update(
            status="environment_blocked",
            exitCode=126,
            durationMs=duration_ms,
            firstActionableFailure=f"{error.__class__.__name__}: {error}",
        )
        return result


def package_bin(package: str, command: str) -> str:
    return str(REPO_ROOT / package / "node_modules" / ".bin" / command)


def manager_spec(root: pathlib.Path, offline: bool = False) -> CommandSpec:
    argv = [shutil.which("corepack") or "corepack", "pnpm", "--version"]
    return CommandSpec(
        stage="manager",
        name="pnpm-version-offline" if offline else "pnpm-version",
        argv=tuple(argv),
        cwd=REPO_ROOT,
        timeout_seconds=DEFAULT_TIMEOUTS["manager"],
    )


def install_specs(root: pathlib.Path) -> list[CommandSpec]:
    store = root / "pnpm-store"
    return [
        manager_spec(root),
        CommandSpec(
            stage="install",
            name="pnpm-frozen-install",
            argv=(
                shutil.which("corepack") or "corepack",
                "pnpm",
                "--store-dir",
                str(store),
                "install",
                "--frozen-lockfile",
            ),
            cwd=REPO_ROOT,
            timeout_seconds=DEFAULT_TIMEOUTS["install"],
        ),
    ]


def stage_specs(stage: str) -> list[CommandSpec]:
    if stage not in STAGE_ORDER:
        raise ValueError(f"unknown stage: {stage}")
    specs: list[CommandSpec] = []
    for package in PACKAGE_ORDER:
        cwd = REPO_ROOT / package
        if stage == "lint":
            argv = (package_bin(package, "eslint"), ".")
        elif stage == "typecheck":
            argv = (
                package_bin(package, "tsc"),
                "--noEmit",
                "--pretty",
                "false",
                "--incremental",
                "false",
            )
        elif stage == "test":
            argv = (
                package_bin(package, "vitest"),
                "run",
                "--reporter=default",
                "--no-file-parallelism",
                "--maxWorkers=1",
            )
        elif package == "contracts":
            argv = (
                package_bin(package, "tsc"),
                "--noEmit",
                "--pretty",
                "false",
                "--incremental",
                "false",
            )
        else:
            argv = (package_bin(package, "next"), "build")
        specs.append(
            CommandSpec(
                stage=stage,
                name=f"{package}-{stage}",
                argv=argv,
                cwd=cwd,
                timeout_seconds=DEFAULT_TIMEOUTS[stage],
            )
        )
    if stage == "test":
        specs.append(
            CommandSpec(
                stage="test",
                name="python-unittest",
                argv=(
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "tests",
                    "-p",
                    "test_*.py",
                    "-v",
                ),
                cwd=REPO_ROOT,
                timeout_seconds=DEFAULT_TIMEOUTS["test"],
            )
        )
    return specs


def report_for(command: str, specs: Sequence[CommandSpec], *, dry_run: bool, gate: bool) -> dict[str, object]:
    root = cache_root()
    if not dry_run:
        root.mkdir(parents=True, exist_ok=True)
    env = toolchain_env(root)
    started_at = utc_now()
    started = time.monotonic()
    results: list[dict[str, object]] = []
    install_failed = False
    for spec in specs:
        if gate and install_failed and spec.stage in STAGE_ORDER:
            result = skipped_result(spec, "dependency installation did not pass")
        else:
            result = run_command(spec, env, dry_run=dry_run)
        results.append(result)
        if spec.stage in {"manager", "install"} and result["status"] not in {"pass", "planned"}:
            install_failed = True
    counts = {status: 0 for status in ("pass", "fail", "timeout", "environment_blocked", "skipped", "planned")}
    for result in results:
        counts[str(result["status"])] += 1
    if dry_run:
        status = "planned"
    elif any(counts[key] for key in ("fail", "timeout", "environment_blocked", "skipped")):
        status = "fail"
    else:
        status = "pass"
    first_failure = next(
        (result for result in results if result["status"] in {"fail", "timeout", "environment_blocked", "skipped"}),
        None,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "command": command,
        "status": status,
        "startedAtUtc": started_at,
        "finishedAtUtc": utc_now(),
        "durationMs": round((time.monotonic() - started) * 1_000),
        "repository": str(REPO_ROOT),
        "packageManager": json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))[
            "packageManager"
        ],
        "cache": {
            "root": str(root),
            "corepackHome": env["COREPACK_HOME"],
            "pnpmHome": env["PNPM_HOME"],
            "pnpmStore": str(root / "pnpm-store"),
            "npmCache": env["NPM_CONFIG_CACHE"],
            "dependsOnOperatorHome": False,
        },
        "summary": {**counts, "total": len(results)},
        "firstActionableFailure": (
            None
            if first_failure is None
            else {
                "name": first_failure["name"],
                "status": first_failure["status"],
                "detail": first_failure["firstActionableFailure"],
            }
        ),
        "results": results,
        "safety": {
            "liveExecutionEnabled": False,
            "providerOrderTransportEnabled": False,
            "m48RuntimeAuthority": False,
        },
    }


def write_report(path: pathlib.Path, report: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def emit(report: dict[str, object], *, as_json: bool, output: pathlib.Path | None) -> int:
    if output is not None:
        write_report(output, report)
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"[toolchain] {report['command']}: {report['status']}")
        for result in report["results"]:
            print(
                f"[{result['status']}] {result['name']} "
                f"exit={result['exitCode']} duration={result['durationMs']}ms "
                f"timeout={result['timeoutSeconds']}s"
            )
            if result["stdoutTail"]:
                print(result["stdoutTail"], end="" if str(result["stdoutTail"]).endswith("\n") else "\n")
            if result["stderrTail"]:
                print(result["stderrTail"], file=sys.stderr, end="" if str(result["stderrTail"]).endswith("\n") else "\n")
            if result["firstActionableFailure"]:
                print(f"[actionable] {result['firstActionableFailure']}", file=sys.stderr)
    return 0 if report["status"] in {"pass", "planned"} else 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="FdbTrade R0.3 reproducible toolchain")
    root.add_argument("--json", action="store_true", help="emit only the JSON report on stdout")
    root.add_argument("--output", type=pathlib.Path, help="atomically write the JSON report")
    root.add_argument("--dry-run", action="store_true", help="report the bounded plan without execution")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("manager-version", help="resolve the pinned pnpm through isolated Corepack")
    commands.add_parser("install", help="run the frozen dependency installation")
    stage = commands.add_parser("stage", help="run one verification stage")
    stage.add_argument("stage", choices=STAGE_ORDER)
    commands.add_parser("check", help="run lint, typecheck, test and build")
    commands.add_parser("gate", help="run frozen install followed by the full check")
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "manager-version":
        specs = [manager_spec(cache_root())]
        gate = False
    elif args.command == "install":
        specs = install_specs(cache_root())
        gate = False
    elif args.command == "stage":
        specs = stage_specs(args.stage)
        gate = False
    elif args.command == "check":
        specs = [spec for stage in STAGE_ORDER for spec in stage_specs(stage)]
        gate = False
    else:
        specs = install_specs(cache_root()) + [
            spec for stage in STAGE_ORDER for spec in stage_specs(stage)
        ]
        gate = True
    report = report_for(args.command, specs, dry_run=args.dry_run, gate=gate)
    return emit(report, as_json=args.json, output=args.output)


if __name__ == "__main__":
    raise SystemExit(main())
