"""R0.11 crash-consistent backup/restore behavior and filesystem boundaries."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "scripts/operational-data.mjs"


def run(*args: str, env: dict[str, str] | None = None, timeout: int = 180):
    return subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def canonical_digest(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def add_artifact(
    source: pathlib.Path,
    authority: str,
    content: bytes,
) -> tuple[str, pathlib.Path]:
    digest = hashlib.sha256(content).hexdigest()
    relative = pathlib.Path("sha256") / digest[:2] / f"{digest}.evidence"
    if authority == "market-data":
        base = pathlib.Path("artifacts/market-data")
        table = "market_data_artifacts"
        insert = f"""INSERT INTO {table}
            (digest, relative_path, byte_count, media_type, created_at_utc)
            VALUES (?, ?, ?, 'application/vnd.fdbtrade.candles', ?)"""
    else:
        base = pathlib.Path("artifacts/research-backtests")
        table = "research_backtest_artifacts"
        insert = f"""INSERT INTO {table}
            (digest, relative_path, byte_count, created_at_utc)
            VALUES (?, ?, ?, ?)"""
    artifact = source / base / relative
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(content)
    with sqlite3.connect(source / "fdbtrade.sqlite3") as database:
        database.execute(
            insert,
            (digest, str(relative), len(content), "2026-09-23T00:00:00.000Z"),
        )
        database.commit()
    return digest, base / relative


def fixture(root: pathlib.Path) -> tuple[pathlib.Path, dict[str, pathlib.Path]]:
    source = root / "source"
    initialized = run(
        "node", str(CLI), "init-drill-fixture", "--data-root", str(source)
    )
    if initialized.returncode != 0:
        raise AssertionError(initialized.stdout + initialized.stderr)
    _, market_path = add_artifact(
        source, "market-data", b"r0.6 immutable market evidence\n"
    )
    _, research_path = add_artifact(
        source, "research-backtest", b"r0.8 immutable research evidence\n"
    )
    return source, {"market-data": market_path, "research-backtest": research_path}


def backup(source: pathlib.Path, output: pathlib.Path, env=None):
    return run(
        "node",
        str(CLI),
        "backup",
        "--data-root",
        str(source),
        "--output-root",
        str(output),
        env=env,
    )


class R011PublicationBehavior(unittest.TestCase):
    def test_backup_verifies_and_fsyncs_both_authorities_before_atomic_rename(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r011-order-") as temporary:
            root = pathlib.Path(temporary)
            source, expected = fixture(root)
            output = root / "backups"
            trace = root / "backup.trace"
            environment = os.environ.copy()
            environment["FDB_OPERATIONAL_TRACE_FILE"] = str(trace)
            result = backup(source, output, environment)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            details = json.loads(result.stdout.strip().splitlines()[-1])
            published = pathlib.Path(details["backupDirectory"])
            manifest = json.loads((published / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertEqual(manifest["workUnit"], "R0.11")
            self.assertEqual(
                {item["authority"] for item in manifest["artifacts"]}, set(expected)
            )
            for relative in expected.values():
                self.assertEqual((published / relative).read_bytes(), (source / relative).read_bytes())

            steps = trace.read_text("utf-8").splitlines()
            verified = steps.index("staging-verified")
            renamed = steps.index("backup-renamed")
            event = steps.index("backup-event-recorded")
            self.assertLess(verified, renamed)
            self.assertLess(steps.index("file-fsynced:fdbtrade.sqlite3"), renamed)
            self.assertLess(steps.index("file-fsynced:manifest.json"), renamed)
            self.assertLess(steps.index("directory-fsynced:output-parent-before-rename"), renamed)
            self.assertLess(renamed, event)
            for authority in expected:
                artifact = next(item for item in manifest["artifacts"] if item["authority"] == authority)
                self.assertLess(steps.index(f"file-fsynced:{artifact['relativePath']}"), renamed)

    def test_faults_before_backup_publication_leave_no_final_path(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r011-faults-") as temporary:
            root = pathlib.Path(temporary)
            source, _ = fixture(root)
            for stage in ("snapshot", "artifact-copy", "manifest", "verification", "pre-rename"):
                output = root / f"backups-{stage}"
                environment = os.environ.copy()
                environment["FDB_OPERATIONAL_FAULT_STAGE"] = stage
                result = backup(source, output, environment)
                self.assertNotEqual(result.returncode, 0, stage)
                self.assertIn(f"injected operational fault: {stage}", result.stderr)
                self.assertEqual(list(output.iterdir()), [], stage)

    def test_post_rename_crash_leaves_valid_unclaimed_backup(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r011-unclaimed-") as temporary:
            root = pathlib.Path(temporary)
            source, _ = fixture(root)
            output = root / "backups"
            environment = os.environ.copy()
            environment["FDB_OPERATIONAL_FAULT_STAGE"] = "post-rename-pre-event"
            result = backup(source, output, environment)
            self.assertNotEqual(result.returncode, 0)
            published = [item for item in output.iterdir() if not item.name.startswith(".")]
            self.assertEqual(len(published), 1)
            manifest = json.loads((published[0] / "manifest.json").read_text("utf-8"))
            with sqlite3.connect(source / "fdbtrade.sqlite3") as database:
                claimed = database.execute(
                    "SELECT COUNT(*) FROM operational_events WHERE event_type = 'backup_created' AND artifact_digest = ?",
                    (manifest["backupDigest"],),
                ).fetchone()[0]
            self.assertEqual(claimed, 0)
            restored = root / "restored"
            recovery = run(
                "node", str(CLI), "restore", "--backup", str(published[0]),
                "--target-data-root", str(restored),
            )
            self.assertEqual(recovery.returncode, 0, recovery.stdout + recovery.stderr)

    def test_restore_is_staged_fsynced_and_atomically_published(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r011-restore-") as temporary:
            root = pathlib.Path(temporary)
            source, expected = fixture(root)
            created = backup(source, root / "backups")
            self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
            backup_dir = pathlib.Path(json.loads(created.stdout.strip().splitlines()[-1])["backupDirectory"])
            target = root / "restored"
            target.mkdir()
            trace = root / "restore.trace"
            environment = os.environ.copy()
            environment["FDB_OPERATIONAL_TRACE_FILE"] = str(trace)
            result = run(
                "node", str(CLI), "restore", "--backup", str(backup_dir),
                "--target-data-root", str(target), env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            steps = trace.read_text("utf-8").splitlines()
            self.assertLess(steps.index("restore-backup-verified"), steps.index("restore-staging-verified"))
            self.assertLess(steps.index("restore-staging-verified"), steps.index("restore-renamed"))
            self.assertLess(steps.index("directory-fsynced:restore-parent-before-rename"), steps.index("restore-renamed"))
            for relative in expected.values():
                self.assertEqual((target / relative).read_bytes(), (source / relative).read_bytes())
            with sqlite3.connect(target / "fdbtrade.sqlite3") as database:
                self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(database.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(
                    database.execute(
                        "SELECT event_type FROM operational_events ORDER BY sequence_no DESC LIMIT 1"
                    ).fetchone()[0],
                    "restore_verified",
                )

    def test_restore_publication_fault_never_exposes_partial_target(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r011-restore-fault-") as temporary:
            root = pathlib.Path(temporary)
            source, _ = fixture(root)
            created = backup(source, root / "backups")
            backup_dir = pathlib.Path(json.loads(created.stdout.strip().splitlines()[-1])["backupDirectory"])
            for existing in (False, True):
                target = root / ("absent-target" if not existing else "empty-target")
                if existing:
                    target.mkdir()
                environment = os.environ.copy()
                environment["FDB_OPERATIONAL_FAULT_STAGE"] = "restore-publication"
                result = run(
                    "node", str(CLI), "restore", "--backup", str(backup_dir),
                    "--target-data-root", str(target), env=environment,
                )
                self.assertNotEqual(result.returncode, 0)
                if existing:
                    self.assertTrue(target.is_dir())
                    self.assertEqual(list(target.iterdir()), [])
                else:
                    self.assertFalse(target.exists())


class R011ManifestAndFilesystemBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fdbtrade-r011-boundary-")
        self.root = pathlib.Path(self.temporary.name)
        self.source, _ = fixture(self.root)
        created = backup(self.source, self.root / "backups")
        if created.returncode != 0:
            raise AssertionError(created.stdout + created.stderr)
        self.backup_dir = pathlib.Path(
            json.loads(created.stdout.strip().splitlines()[-1])["backupDirectory"]
        )

    def tearDown(self):
        self.temporary.cleanup()

    def restore(self, target_name="restored"):
        return run(
            "node", str(CLI), "restore", "--backup", str(self.backup_dir),
            "--target-data-root", str(self.root / target_name),
        )

    def test_rejects_malformed_manifest_unknown_fields_and_true_safety(self):
        manifest_file = self.backup_dir / "manifest.json"
        original = manifest_file.read_text("utf-8")
        for mutation, message in (
            ("{", "malformed JSON"),
            (None, "unsupported fields"),
            (False, "literal false"),
        ):
            if mutation == "{":
                manifest_file.write_text("{", "utf-8")
            else:
                manifest = json.loads(original)
                if mutation is None:
                    manifest["unexpected"] = "field"
                else:
                    manifest["safety"]["liveExecutionEnabled"] = True
                manifest_file.write_text(json.dumps(manifest), "utf-8")
            result = self.restore(f"target-{str(mutation)}")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
            manifest_file.write_text(original, "utf-8")

    def test_rejects_absolute_escaping_and_symlink_artifact_paths(self):
        manifest_file = self.backup_dir / "manifest.json"
        original = manifest_file.read_text("utf-8")
        for unsafe in ("/tmp/outside", "artifacts/market-data/../../outside"):
            manifest = json.loads(original)
            manifest["artifacts"][0]["relativePath"] = unsafe
            manifest_file.write_text(json.dumps(manifest), "utf-8")
            result = self.restore(f"target-{hashlib.sha256(unsafe.encode()).hexdigest()[:6]}")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("path", result.stderr)
        manifest_file.write_text(original, "utf-8")
        manifest = json.loads(original)
        artifact = self.backup_dir / manifest["artifacts"][0]["relativePath"]
        artifact.unlink()
        artifact.symlink_to(self.root / "outside")
        result = self.restore("symlink-target")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symbolic link", result.stderr)

    def test_rejects_unlisted_and_nonregular_filesystem_entries(self):
        extra = self.backup_dir / "unlisted.txt"
        extra.write_text("not in manifest", "utf-8")
        unlisted = self.restore("unlisted-target")
        self.assertNotEqual(unlisted.returncode, 0)
        self.assertIn("exactly match the manifest", unlisted.stderr)
        extra.unlink()

        fifo = self.backup_dir / "unsafe-fifo"
        os.mkfifo(fifo)
        nonregular = self.restore("nonregular-target")
        self.assertNotEqual(nonregular.returncode, 0)
        self.assertIn("non-regular", nonregular.stderr)

    def test_rejects_nonempty_target_migration_drift_and_symlink_parent(self):
        nonempty = self.root / "nonempty"
        nonempty.mkdir()
        (nonempty / "keep").write_text("operator data", "utf-8")
        result = self.restore("nonempty")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restore target must be empty", result.stderr)
        self.assertEqual((nonempty / "keep").read_text("utf-8"), "operator data")

        manifest_file = self.backup_dir / "manifest.json"
        manifest = json.loads(manifest_file.read_text("utf-8"))
        database_file = self.backup_dir / "fdbtrade.sqlite3"
        with sqlite3.connect(database_file) as database:
            database.execute(
                "DELETE FROM schema_migrations WHERE id = '0010_temporal_validation_authority'"
            )
            database.commit()
        manifest["database"]["sha256"] = hashlib.sha256(database_file.read_bytes()).hexdigest()
        manifest["database"]["byteCount"] = database_file.stat().st_size
        manifest["database"]["migrations"] = manifest["database"]["migrations"][:-1]
        manifest["backupDigest"] = canonical_digest(
            {
                "database": manifest["database"],
                "artifacts": manifest["artifacts"],
                "safety": manifest["safety"],
            }
        )
        manifest_file.write_text(json.dumps(manifest), "utf-8")
        drift = self.restore("drift-target")
        self.assertNotEqual(drift.returncode, 0)
        self.assertIn("migration ledger", drift.stderr)

        real_output = self.root / "real-output"
        real_output.mkdir()
        linked_output = self.root / "linked-output"
        linked_output.symlink_to(real_output, target_is_directory=True)
        symlink_result = backup(self.source, linked_output)
        self.assertNotEqual(symlink_result.returncode, 0)
        self.assertIn("symbolic-link component", symlink_result.stderr)

    def test_strictly_accepts_r010_manifest_format_as_legacy_integrity_evidence(self):
        manifest_file = self.backup_dir / "manifest.json"
        manifest = json.loads(manifest_file.read_text("utf-8"))
        manifest["schemaVersion"] = 1
        manifest["workUnit"] = "R0.10"
        manifest["backupId"] = manifest["backupId"].replace("r011-", "r010-", 1)
        manifest.pop("integrityClaim")
        manifest_file.write_text(json.dumps(manifest), "utf-8")
        # R0.10 verification could leave these unlisted SQLite engine sidecars.
        # Compatibility recognizes but never copies or trusts them.
        (self.backup_dir / "fdbtrade.sqlite3-wal").write_bytes(b"")
        (self.backup_dir / "fdbtrade.sqlite3-shm").write_bytes(b"legacy-engine-residue")
        result = self.restore("legacy-restored")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
