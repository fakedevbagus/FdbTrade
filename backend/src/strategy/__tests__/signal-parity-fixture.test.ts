/**
 * Signal contract cross-layer parity fixture writer (P05-01).
 *
 * Deterministically builds a canonical signal through the backend builder
 * and writes tests/fixtures/signal_parity.json (draft + canonical
 * serialization + snapshotHash). The Python mirror
 * (tests/test_strategy_contract_contracts.py) asserts parse + serialize +
 * hash parity, pinning TS<->Python signal-contract parity. Regenerated
 * only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { serializeSignalCanonical } from "@fdbtrade/contracts";

import { buildSignal, type SignalDraft } from "@/strategy/builder";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "signal_parity.json");

const DRAFT: SignalDraft = {
  instrument: "EURUSD",
  timeframe: "1h",
  eventTimeUtc: "2026-09-08T10:00:00.000Z",
  direction: "long",
  strategyId: "trend-mtf-pullback",
  strategyVersion: "1.0.0",
  configVersion: "1.0.0",
  entryType: "market",
  entryPrice: null,
  referencePrice: 1.105,
  stopLoss: 1.0995,
  takeProfit: 1.112,
  expiresAtUtc: "2026-09-08T14:00:00.000Z",
  confidence: 0.6,
  reasonCodes: ["ema_stack_aligned", "mtf_alignment_confirmed", "signal_emitted"],
  inputs: {
    adx_1h: 27.5,
    ema_fast_1h: 1.1048,
    ema_slow_1h: 1.099,
    pullback_ok: true,
    warmup_null: null,
  },
  signalContractVersion: 1,
};

describe("signal parity fixture (P05-01)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const signal = buildSignal(DRAFT);
    const { snapshotHash: _h, ...content } = signal;
    const fixture = {
      generatedBy: "backend/src/strategy/__tests__/signal-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match parse+serialize+hash exactly (quant/strategycore/contract.py).",
      draft: {
        ...content,
        signalId: signal.signalId,
      },
      canonical: serializeSignalCanonical(content),
      snapshotHash: signal.snapshotHash,
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism: rebuild twice -> byte-identical serialization.
    const again = buildSignal(DRAFT);
    const { snapshotHash: _h2, ...content2 } = again;
    expect(serializeSignalCanonical(content2)).toBe(fixture.canonical);
    expect(again.snapshotHash).toBe(fixture.snapshotHash);
    // A short entry with explicit level + null takeProfit exercises the
    // other serialization branches too.
    const shortSignal = buildSignal({
      ...DRAFT,
      direction: "short",
      entryType: "stop",
      entryPrice: 1.108,
      stopLoss: 1.1115,
      takeProfit: null,
    });
    expect(shortSignal.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
