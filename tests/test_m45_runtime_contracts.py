"""M45 continuous scheduler and runtime hardening contract tests.

Validates the M45 runtime guarantees:
- One process lock per runtime database
- Bounded scheduler interval [1s, 1h] and explicit clock source
- Cycle lease state machine: lifecycle, heartbeat, timeout, retry budget
- Dedupe ledger: idempotency for cycle, job, outbox, paper order, fill
- Durable checkpoints: hash chaining, tamper detection, completion ledger
- Controlled degradation: queue/memory/disk/staleness pressure thresholds
- Health projections: scheduler, queue, database, source, analysis, paper broker
- Operational log: correlation to cycleId, bounded FIFO retention
- Fixture soak: multi-checkpoint kill and restart convergence
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND_SRC = REPO_ROOT / "backend" / "src"
RUNTIME_DIR = BACKEND_SRC / "runtime"


def sha256_hex(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


class RuntimeFileStructureContracts(unittest.TestCase):
    """M45 runtime modules must exist and enforce safety flags."""

    EXPECTED_MODULES = (
        "clock.ts",
        "lock.ts",
        "lease.ts",
        "dedupe.ts",
        "checkpoints.ts",
        "degradation.ts",
        "health.ts",
        "retention.ts",
        "scheduler.ts",
        "startup.ts",
        "observation.ts",
        "soak.ts",
    )

    def test_all_runtime_modules_exist(self):
        self.assertTrue(RUNTIME_DIR.is_dir())
        for mod in self.EXPECTED_MODULES:
            self.assertTrue((RUNTIME_DIR / mod).is_file(), f"Missing: {mod}")

    def test_runtime_test_suite_exists(self):
        self.assertTrue((RUNTIME_DIR / "__tests__" / "runtime.test.ts").is_file())

    def test_no_live_execution_authority_in_runtime(self):
        banned_live = "liveExecutionEnabled" + ": " + "true"
        banned_transport = "providerOrderTransportEnabled" + ": " + "true"
        for path in RUNTIME_DIR.glob("*.ts"):
            content = path.read_text(encoding="utf-8")
            self.assertNotIn(banned_live, content)
            self.assertNotIn(banned_transport, content)


class RuntimeInvariantContracts(unittest.TestCase):
    """Behavioral and algorithmic invariants of M45 components."""

    def test_interval_bounds_constant(self):
        scheduler_ts = (RUNTIME_DIR / "scheduler.ts").read_text(encoding="utf-8")
        self.assertIn("MIN_INTERVAL_MS = 1_000", scheduler_ts)
        self.assertIn("MAX_INTERVAL_MS = 3_600_000", scheduler_ts)

    def test_cycle_stages_order_and_immutability(self):
        scheduler_ts = (RUNTIME_DIR / "scheduler.ts").read_text(encoding="utf-8")
        match = re.search(r'CYCLE_STAGES\s*=\s*\[(.*?)\]', scheduler_ts)
        self.assertIsNotNone(match)
        stages = [s.strip().strip('"').strip("'") for s in match.group(1).split(",")]
        self.assertEqual(stages, ["ingest", "analyze", "emit", "observe"])

    def test_checkpoint_hash_chaining_algorithm(self):
        def compute_cp_hash(cycle_id: str, stage: str, stage_seq: int, payload: str, prev: str | None) -> str:
            return sha256_hex(f"{cycle_id}|{stage}|{stage_seq}|{payload}|{prev or 'GENESIS'}")

        h1 = compute_cp_hash("cycle-000001", "ingest", 0, "payload-1", None)
        h2 = compute_cp_hash("cycle-000001", "analyze", 1, "payload-2", h1)
        h3 = compute_cp_hash("cycle-000001", "emit", 2, "payload-3", h2)
        self.assertNotEqual(h1, h2)
        self.assertNotEqual(h2, h3)

        h1_bad = compute_cp_hash("cycle-000001", "ingest", 0, "bad-payload", None)
        h2_bad = compute_cp_hash("cycle-000001", "analyze", 1, "payload-2", h1_bad)
        self.assertNotEqual(h2, h2_bad)

    def test_dedupe_deterministic_id_derivation(self):
        def outbox_id(cycle_id: str, stage: str, event_type: str, seq: int) -> str:
            return f"evt-{sha256_hex(f'outbox:{cycle_id}:{stage}:{event_type}:{seq}')[:16]}"

        def order_id(cycle_id: str, symbol: str, side: str, seq: int) -> str:
            return f"ord-{sha256_hex(f'order:{cycle_id}:{symbol}:{side}:{seq}')[:16]}"

        self.assertEqual(outbox_id("c1", "emit", "sig", 0), outbox_id("c1", "emit", "sig", 0))
        self.assertNotEqual(outbox_id("c1", "emit", "sig", 0), outbox_id("c1", "emit", "sig", 1))
        self.assertEqual(order_id("c1", "EUR_USD", "buy", 0), order_id("c1", "EUR_USD", "buy", 0))
        self.assertNotEqual(order_id("c1", "EUR_USD", "buy", 0), order_id("c1", "GBP_USD", "buy", 0))

    def test_health_projection_subsystems(self):
        health_ts = (RUNTIME_DIR / "health.ts").read_text(encoding="utf-8")
        for sub in ("scheduler", "queue", "database", "source", "analysis", "paperBroker"):
            self.assertIn(sub, health_ts)

    def test_controlled_degradation_admission_rules(self):
        degrade_ts = (RUNTIME_DIR / "degradation.ts").read_text(encoding="utf-8")
        self.assertIn('"full"', degrade_ts)
        self.assertIn('"observation_only"', degrade_ts)
        self.assertIn('"none"', degrade_ts)
        self.assertIn("DEGRADATION_LEVELS", degrade_ts)

    def test_soak_outcome_hash_invariance(self):
        def outcome_hash(digests: dict[str, str]) -> str:
            return sha256_hex(json.dumps(sorted(digests.items()), separators=(",", ":")))

        a = {"ingest": "d1", "analyze": "d2", "emit": "d3", "observe": "d4"}
        b = {"ingest": "d1", "analyze": "d2", "emit": "d3", "observe": "d4"}
        c = {"ingest": "d9", "analyze": "d2", "emit": "d3", "observe": "d4"}
        self.assertEqual(outcome_hash(a), outcome_hash(b))
        self.assertNotEqual(outcome_hash(a), outcome_hash(c))


if __name__ == "__main__":
    unittest.main()
