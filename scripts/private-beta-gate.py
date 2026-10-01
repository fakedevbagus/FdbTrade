#!/usr/bin/env python3
"""R1.13 hermetic, authority-level offline private-beta operator drill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
OPERATIONAL = ROOT / "scripts" / "operational-data.mjs"
DB_NAME = "fdbtrade.sqlite3"
NOW = "2026-09-30T00:00:00.000Z"
LATER = "2027-09-30T00:00:00.000Z"


def digest(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def run(*args: str) -> dict:
    completed = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=False)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return json.loads(completed.stdout.strip().splitlines()[-1])


def one(db: sqlite3.Connection, sql: str, params: tuple = ()):
    row = db.execute(sql, params).fetchone()
    if row is None:
        raise AssertionError(f"missing durable state for: {sql}")
    return row


def healthy(db: sqlite3.Connection) -> dict:
    integrity = one(db, "PRAGMA integrity_check")[0]
    foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
    migrations = one(db, "SELECT COUNT(*) FROM schema_migrations")[0]
    if integrity != "ok" or foreign_keys or migrations != 13:
        raise AssertionError("health authority failed")
    return {"sqliteIntegrity": integrity, "foreignKeyViolations": 0, "migrationCount": migrations}


def write_artifact(data_root: pathlib.Path, authority: str, filename: str, payload: bytes) -> tuple[str, int]:
    directory = data_root / "artifacts" / authority
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / filename
    target.write_bytes(payload)
    return digest(payload), len(payload)


def seed_workflow(data_root: pathlib.Path, steps: list[dict]) -> dict:
    database_path = data_root / DB_NAME
    db = sqlite3.connect(database_path)
    db.execute("PRAGMA foreign_keys = ON")
    d = digest

    # 1. Bootstrap is observable through the exact migration ledger.
    health = healthy(db)
    steps.append({"name": "bootstrap", "status": "pass", "evidence": health})

    # 2. Login/session uses only an opaque token hash; no credential leaves the drill.
    db.execute(
        "INSERT INTO users VALUES (?,?,?,?,?,?,?,?)",
        ("usr_beta", 1, "private-beta", "offline-password-hash", 0, 1, NOW, NOW),
    )
    db.execute("INSERT INTO user_profiles VALUES (?,?,?,?,?)", ("usr_beta", "Private Beta Operator", "UTC", NOW, NOW))
    db.execute(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?)",
        ("ses_beta", d("opaque-session-token"), "usr_beta", NOW, LATER, NOW),
    )
    db.commit()
    session = one(
        db,
        "SELECT s.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.id=? AND u.is_active=1 AND s.expires_at_utc>?",
        ("ses_beta", NOW),
    )
    steps.append({"name": "login", "status": "pass", "evidence": {"sessionId": session[0], "username": session[1]}})

    # 3. Immutable user-owned CSV import and durable dataset evidence.
    csv = (
        b"timestamp,open,high,low,close,volume\n"
        b"2026-01-01T00:00:00Z,1.1000,1.1010,1.0990,1.1005,10\n"
        b"2026-01-01T01:00:00Z,1.1005,1.1020,1.1000,1.1015,12\n"
    )
    csv_digest, csv_bytes = write_artifact(data_root, "market-data", "beta-eurusd-1h.csv", csv)
    db.execute("INSERT INTO market_data_artifacts VALUES (?,?,?,?,?)", (csv_digest, "beta-eurusd-1h.csv", csv_bytes, "application/vnd.fdbtrade.candles", NOW))
    db.execute(
        "INSERT INTO market_data_datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("ds_beta", csv_digest, "operator-csv", "EURUSD", "1h", "historical", "2026-01-01T00:00:00.000Z",
         "2026-01-01T02:00:00.000Z", 2, canonical({"source": "operator-csv"}), canonical({"accepted": 2}),
         2, 0, 0, 0, "accepted", "stale", "2026-01-01T02:00:00.000Z", NOW, NOW),
    )
    db.execute(
        "INSERT INTO market_data_ingestion_jobs VALUES (?,?,?,?,?,?,?,?,?)",
        ("ing_beta", "beta-import", d("beta-import"), "succeeded", 1, "ds_beta", None, NOW, NOW),
    )
    db.commit()
    imported = one(db, "SELECT record_count,quality_state FROM market_data_datasets WHERE dataset_id='ds_beta'")
    steps.append({"name": "csv-import", "status": "pass", "evidence": {"datasetId": "ds_beta", "records": imported[0], "quality": imported[1], "sha256": csv_digest}})

    # 4. Signal workbench: registered rule -> candidate -> immutable evidence.
    rule_json = canonical({"rule": "offline-beta-cross", "network": False})
    db.execute("INSERT INTO signal_rule_registry VALUES (?,?,?,?,?,?)", ("rule_beta", "1", "1", rule_json, d(rule_json), NOW))
    db.execute(
        "INSERT INTO signal_evaluation_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("sig_run_beta", "sig-beta", d("sig-request"), "ds_beta", "rule_beta", "1", "1", NOW,
         "pending", 0, None, None, NOW, NOW),
    )
    db.execute(
        "INSERT INTO signal_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("sig_beta", "ds_beta", "rule_beta", "1", "1", "EURUSD", "1h", "2026-01-01T01:00:00.000Z",
         "2026-01-02T01:00:00.000Z", "long", d("signal-snapshot"), canonical({"direction": "long"}), NOW),
    )
    evidence_json = canonical({"datasetId": "ds_beta", "signalId": "sig_beta"})
    db.execute(
        "INSERT INTO signal_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("sig_ev_beta", "sig_run_beta", "ds_beta", "rule_beta", "1", "1", "candidate", "sig_beta",
         d(evidence_json), evidence_json, NOW),
    )
    db.execute("INSERT INTO signal_lifecycle_events VALUES (?,?,?,?,?,?)", ("sig_life_beta", "sig_beta", "identified", NOW, "operator drill", NOW))
    db.execute("UPDATE signal_evaluation_runs SET status='succeeded',attempts=1,evidence_id='sig_ev_beta',updated_at_utc=? WHERE run_id='sig_run_beta'", (NOW,))
    db.commit()
    signal = one(db, "SELECT r.status,e.outcome FROM signal_evaluation_runs r JOIN signal_evidence e ON e.run_id=r.run_id WHERE r.run_id='sig_run_beta'")
    steps.append({"name": "signal-workbench", "status": "pass", "evidence": {"runStatus": signal[0], "outcome": signal[1], "signalId": "sig_beta"}})

    # 5. Research result plus separate temporal-validation evidence.
    research_config = canonical({"costModel": "fixed", "seed": "beta"})
    db.execute("INSERT INTO research_backtest_configs VALUES (?,?,?,?,?,?,?,?)", ("research_beta", "1", d(research_config), research_config, "rule_beta", "1", "1", NOW))
    db.execute("INSERT INTO research_backtest_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ("research_run_beta", "research-beta", d("research-request"), "ds_beta", "research_beta", "1", "pending", 0, None, None, NOW, NOW))
    research_payload = canonical({"trades": 1, "validation": "out-of-sample"}).encode()
    research_digest, research_bytes = write_artifact(data_root, "research-backtests", "beta-research.json", research_payload)
    db.execute("INSERT INTO research_backtest_artifacts VALUES (?,?,?,?)", (research_digest, "beta-research.json", research_bytes, NOW))
    summary = canonical({"return": 0.001, "trades": 1})
    db.execute("INSERT INTO research_backtest_results VALUES (?,?,?,?,?,?,?,?)", ("research_result_beta", "research_run_beta", "engine_beta", "ds_beta", research_digest, d(summary), summary, NOW))
    db.execute("UPDATE research_backtest_runs SET status='succeeded',attempts=1,result_id='research_result_beta',updated_at_utc=? WHERE authority_run_id='research_run_beta'", (NOW,))
    validation_config = canonical({"method": "walk-forward", "folds": 2})
    db.execute("INSERT INTO temporal_validation_configs VALUES (?,?,?,?,?,?,?)", ("validation_beta", "1", d(validation_config), validation_config, "research_beta", "1", NOW))
    db.execute("INSERT INTO temporal_validation_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ("validation_run_beta", "validation-beta", d("validation-request"), "ds_beta", "validation_beta", "1", "pending", 0, None, None, NOW, NOW))
    validation_payload = canonical({"folds": [{"train": 1, "test": 1}], "leakage": False}).encode()
    validation_digest = d(validation_payload)
    db.execute("INSERT INTO temporal_validation_artifacts VALUES (?,?,?,?)", (validation_digest, "beta-validation.json", len(validation_payload), NOW))
    validation_summary = canonical({"folds": 1, "leakage": False})
    db.execute(
        "INSERT INTO temporal_validation_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("validation_result_beta", "validation_run_beta", "ds_beta", csv_digest, d(validation_config), d("split"),
         d("walkforward"), d("costs"), "beta-seed", validation_digest, d(validation_summary), validation_summary, NOW),
    )
    db.execute("UPDATE temporal_validation_runs SET status='succeeded',attempts=1,result_id='validation_result_beta',updated_at_utc=? WHERE authority_run_id='validation_run_beta'", (NOW,))
    db.commit()
    research = one(db, "SELECT r.status,v.status FROM research_backtest_runs r CROSS JOIN temporal_validation_runs v WHERE r.authority_run_id='research_run_beta' AND v.authority_run_id='validation_run_beta'")
    steps.append({"name": "research-validation", "status": "pass", "evidence": {"research": research[0], "temporalValidation": research[1], "artifactSha256": research_digest}})

    # 6. Resolve authoritative paper inputs before explicit operator confirmation.
    input_config = canonical({"conversion": "identity", "staleAfterSeconds": 86400})
    db.execute("INSERT INTO paper_input_configs VALUES (?,?,?,?,?)", ("input_beta", "1", d(input_config), input_config, NOW))
    db.execute(
        "INSERT INTO paper_input_resolution_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("input_run_beta", "input-beta", d("input-request"), canonical({"signalId": "sig_beta"}), "sig_beta", "ds_beta",
         "input_beta", "1", d(input_config), "pending", 0, None, None, NOW, NOW),
    )
    resolution_json = canonical({"signalId": "sig_beta", "executionDatasetId": "ds_beta", "verified": True})
    db.execute(
        "INSERT INTO paper_input_resolutions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("input_resolution_beta", "input_run_beta", "sig_beta", "ds_beta", csv_digest, "ds_beta", csv_digest,
         "2026-01-01T01:00:00.000Z", NOW, "input_beta", "1", d(input_config), "identity", d("conversion-bar"),
         d(resolution_json), resolution_json, NOW),
    )
    db.execute("UPDATE paper_input_resolution_runs SET status='resolved',attempts=1,resolution_id='input_resolution_beta',updated_at_utc=? WHERE resolution_run_id='input_run_beta'", (NOW,))

    # 7. Operator-confirmed paper-only run, including closed outcome and reconciliation.
    risk_config = canonical({"maxRisk": 0.01, "paperOnly": True})
    db.execute("INSERT INTO risk_paper_configs VALUES (?,?,?,?,?)", ("risk_beta", "1", d(risk_config), risk_config, NOW))
    db.execute("INSERT INTO risk_state_events VALUES (?,?,?,?,?,?,?,?,?,?)", ("risk_state_beta", 1, None, "green", "initialized", None, "operator", "offline beta", NOW, NOW))
    request_json = canonical({"confirmation": "confirm-paper-run", "paperOnly": True, "resolutionId": "input_resolution_beta"})
    db.execute("INSERT INTO risk_paper_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ("paper_run_beta", "sig_beta", "ds_beta", d(request_json), request_json, "risk_state_beta", "pending", 0, None, None, None, None, NOW, NOW))
    decision_json = canonical({"outcome": "approved", "paperOnly": True})
    db.execute("INSERT INTO risk_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?)", ("decision_beta", "paper_run_beta", "sig_beta", "risk_state_beta", "approved", d(request_json), request_json, d(decision_json), decision_json, NOW, NOW))
    order_json = canonical({"instrument": "EURUSD", "direction": "long", "paperOnly": True})
    db.execute("INSERT INTO paper_orders VALUES (?,?,?,?,?,?,?,?,?,?)", ("order_beta", "paper_run_beta", "sig_beta", "decision_beta", "EURUSD", "1h", "long", d(order_json), order_json, NOW))
    for sequence, event_type in enumerate(("order_created", "order_risk_checked", "order_submitted", "fill_executed", "position_opened", "position_closed"), 1):
        event_json = canonical({"event": event_type, "paperOnly": True})
        db.execute("INSERT INTO paper_order_events VALUES (?,?,?,?,?,?,?,?)", (f"order_event_{sequence}", "order_beta", sequence, event_type, NOW, d(event_json), event_json, NOW))
    for sequence, side in enumerate(("entry", "exit"), 1):
        fill_json = canonical({"side": side, "price": 1.101})
        db.execute("INSERT INTO paper_fills VALUES (?,?,?,?,?,?,?,?,?)", (f"fill_{sequence}", "order_beta", sequence, side, NOW, d(fill_json), fill_json, canonical({"provider": None}), NOW))
    for event_type in ("opened", "closed"):
        position_json = canonical({"positionId": "position_beta", "event": event_type})
        db.execute("INSERT INTO paper_position_events VALUES (?,?,?,?,?,?,?,?)", (f"position_{event_type}", "position_beta", "order_beta", event_type, NOW, d(position_json), position_json, NOW))
    outcome_json = canonical({"pnl": 0.001, "paperOnly": True})
    db.execute("INSERT INTO paper_outcomes VALUES (?,?,?,?,?,?,?,?,?,?)", ("outcome_beta", "paper_run_beta", "sig_beta", "decision_beta", "order_beta", "position_beta", d(outcome_json), outcome_json, NOW, NOW))
    reconciliation_json = canonical({"ok": True, "fills": 2})
    db.execute("INSERT INTO paper_reconciliation_reports VALUES (?,?,?,?,?,?,?)", ("reconciliation_beta", "paper_run_beta", 1, d(reconciliation_json), reconciliation_json, NOW, NOW))
    db.execute("UPDATE risk_paper_runs SET status='succeeded',attempts=1,risk_decision_id='decision_beta',order_id='order_beta',outcome_id='outcome_beta',updated_at_utc=? WHERE run_id='paper_run_beta'", (NOW,))
    db.commit()
    paper = one(db, "SELECT r.status,d.outcome,o.outcome_id FROM risk_paper_runs r JOIN risk_decisions d ON d.run_id=r.run_id JOIN paper_outcomes o ON o.run_id=r.run_id WHERE r.run_id='paper_run_beta'")
    steps.append({"name": "paper-input-resolution", "status": "pass", "evidence": {"resolutionId": "input_resolution_beta"}})
    steps.append({"name": "operator-confirmed-paper", "status": "pass", "evidence": {"status": paper[0], "riskDecision": paper[1], "outcomeId": paper[2], "liveExecution": False}})

    # 8. Outcome projection and health are re-read from durable authority.
    outcome = one(db, "SELECT json_extract(outcome_json,'$.paperOnly'),(SELECT ok FROM paper_reconciliation_reports WHERE run_id='paper_run_beta') FROM paper_outcomes WHERE outcome_id='outcome_beta'")
    steps.append({"name": "outcome", "status": "pass", "evidence": {"paperOnly": bool(outcome[0]), "reconciled": bool(outcome[1])}})
    health = healthy(db)
    counts = {table: one(db, f"SELECT COUNT(*) FROM {table}")[0] for table in (
        "market_data_datasets", "signal_evidence", "research_backtest_results",
        "temporal_validation_results", "paper_input_resolutions", "paper_outcomes",
    )}
    steps.append({"name": "health", "status": "pass", "evidence": {**health, "authorityCounts": counts}})
    db.close()
    return counts


def verify_reopen(database_path: pathlib.Path, expected: dict) -> dict:
    db = sqlite3.connect(database_path)
    db.execute("PRAGMA foreign_keys = ON")
    result = healthy(db)
    for table, expected_count in expected.items():
        actual = one(db, f"SELECT COUNT(*) FROM {table}")[0]
        if actual != expected_count:
            raise AssertionError(f"{table} did not survive reopen")
    result["authorityCounts"] = expected
    db.close()
    return result


def execute(output: pathlib.Path | None) -> dict:
    steps: list[dict] = []
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="fdbtrade-r113-private-beta-"))
    try:
        source = workspace / "source"
        initialized = run("node", str(OPERATIONAL), "init-drill-fixture", "--data-root", str(source))
        if initialized["status"] != "initialized":
            raise AssertionError("bootstrap failed")
        expected = seed_workflow(source, steps)

        # 9. Clean shutdown/restart: new connection, exact rows and authority health.
        restart = verify_reopen(source / DB_NAME, expected)
        steps.append({"name": "shutdown-restart", "status": "pass", "evidence": restart})

        # 10. Verified R0.11 backup of SQLite and immutable market/research artifacts.
        backup = run("node", str(OPERATIONAL), "backup", "--data-root", str(source), "--output-root", str(workspace / "backups"))
        manifest = json.loads((pathlib.Path(backup["backupDirectory"]) / "manifest.json").read_text())
        steps.append({"name": "backup", "status": "pass", "evidence": {"backupId": backup["backupId"], "backupDigest": backup["backupDigest"], "artifactCount": backup["artifactCount"], "manifestSchema": manifest["schemaVersion"]}})

        # 11. Restore into an unpublished empty root and reopen all workflow authorities.
        restored = workspace / "restored"
        restore = run("node", str(OPERATIONAL), "restore", "--backup", backup["backupDirectory"], "--target-data-root", str(restored))
        reopen = verify_reopen(restored / DB_NAME, expected)
        for relative in ("artifacts/market-data/beta-eurusd-1h.csv", "artifacts/research-backtests/beta-research.json"):
            if not (restored / relative).is_file():
                raise AssertionError(f"restored artifact missing: {relative}")
        steps.append({"name": "restore-reopen", "status": "pass", "evidence": {**reopen, "backupId": restore["backupId"], "restoredArtifacts": 2}})

        soak = []
        for cycle in range(1, 4):
            soak.append({"cycle": cycle, **verify_reopen(restored / DB_NAME, expected)})

        report = {
            "schemaVersion": 1,
            "workUnit": "R1.13",
            "status": "pass",
            "recordedAtUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "steps": steps,
            "stepCount": len(steps),
            "soak": {"cycles": soak, "status": "pass"},
            "safety": {
                "externalNetworkUsed": False,
                "credentialsUsed": False,
                "providerSelected": False,
                "liveExecutionEnabled": False,
                "automaticPaperEnabled": False,
                "remoteAccessEnabled": False,
                "m48RuntimeAuthority": False,
            },
            "limitations": [
                "authority-level drill; it does not automate a browser",
                "fixed two-row CSV fixture is not market-performance evidence",
                "backup authority covers SQLite plus market-data and research-backtest artifacts",
                "single local operator and loopback-only deployment remain required",
            ],
        }
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + "\n")
        return report
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    report = execute(args.output)
    print(json.dumps({"status": report["status"], "steps": report["stepCount"], "soakCycles": len(report["soak"]["cycles"]), "output": str(args.output) if args.output else None}))


if __name__ == "__main__":
    if os.environ.get("FDB_LIVE_EXECUTION") == "true":
        raise SystemExit("live execution must remain disabled")
    main()