"""R1.13 complete hermetic offline private-beta operator drill."""
import hashlib
import json
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
DRILL = ROOT / "scripts/private-beta-gate.py"


class R113OfflinePrivateBetaGate(unittest.TestCase):
    def test_complete_operator_drill_is_durable_and_hermetic(self):
        with tempfile.TemporaryDirectory(prefix="fdbtrade-r113-test-") as directory:
            output = pathlib.Path(directory) / "report.json"
            result = subprocess.run(
                ["python3", str(DRILL), "--output", str(output)],
                cwd=ROOT, text=True, capture_output=True, timeout=240, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summary = json.loads(result.stdout.strip().splitlines()[-1])
            report = json.loads(output.read_text())
            self.assertEqual(summary, {"status": "pass", "steps": 12, "soakCycles": 3, "output": str(output)})
            self.assertEqual(report["status"], "pass")
            self.assertEqual(
                [step["name"] for step in report["steps"]],
                [
                    "bootstrap", "login", "csv-import", "signal-workbench",
                    "research-validation", "paper-input-resolution",
                    "operator-confirmed-paper", "outcome", "health",
                    "shutdown-restart", "backup", "restore-reopen",
                ],
            )
            self.assertTrue(all(step["status"] == "pass" for step in report["steps"]))
            self.assertEqual(len(report["soak"]["cycles"]), 3)
            self.assertTrue(all(value is False for value in report["safety"].values()))
            restored = report["steps"][-1]["evidence"]
            self.assertEqual(restored["migrationCount"], 12)
            self.assertEqual(restored["foreignKeyViolations"], 0)
            self.assertEqual(restored["restoredArtifacts"], 2)

    def test_progression_preservation_and_scope_contracts(self):
        source = DRILL.read_text()
        for marker in (
            "confirm-paper-run", "paper_input_resolutions", "temporal_validation_results",
            "shutdown-restart", "restore-reopen", "externalNetworkUsed",
        ):
            self.assertIn(marker, source)
        for forbidden in ("requests.", "urllib", "socket.", "0.0.0.0", "git reset"):
            self.assertNotIn(forbidden, source)
        self.assertIn("offline-private-beta-drill:", (ROOT / "Makefile").read_text())
        guide = (ROOT / "docs/rebuild/OFFLINE_PRIVATE_BETA_GUIDE.md").read_text()
        self.assertIn("Honest limitations", guide)
        self.assertIn("Incident recovery", guide)
        nxt = (ROOT / "docs/rebuild/NEXT.md").read_text()
        self.assertIn("Current completed unit: **R1.17", nxt)
        self.assertIn("Next planned unit: **R1.18", nxt)
        self.assertIn("not authorized", nxt)
        migrations = [
            path for path in sorted((ROOT / "backend/db/sqlite-migrations").glob("*.sql"))
            if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", path.name)
        ]
        self.assertEqual(len(migrations), 12)
        preservation = json.loads((ROOT / "artifacts/rebuild/r0.1/preservation.json").read_text())
        for item in preservation["quarantinedWork"]["files"]:
            data = (ROOT / item["path"]).read_bytes()
            self.assertEqual(len(data), item["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])


if __name__ == "__main__":
    unittest.main()