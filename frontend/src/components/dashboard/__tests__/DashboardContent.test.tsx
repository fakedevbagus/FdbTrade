/**
 * DashboardContent rendering tests (P07-01).
 *
 * Covers: full snapshot renders all six command-center surfaces, stale
 * rows visibly marked, empty-signal/empty-opportunity honesty states,
 * portfolio-heat placeholder text, and error rows surfaced.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DashboardContent } from "@/components/dashboard/DashboardContent";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import type { DashboardSnapshotView } from "@/lib/dashboard";

const snapshot: DashboardSnapshotView = {
  asOfUtc: "2026-09-09T10:00:00.000Z",
  pipelineId: "private-signal-pipeline",
  pipelineVersion: "1.0.0",
  providerId: "fixture",
  generatedFrom: "fixture",
  overview: [
    {
      instrument: "EURUSD",
      eventTimeUtc: "2026-09-09T09:00:00.000Z",
      quote: {
        instrument: "EURUSD",
        timestamp: "2026-09-09T10:00:00.000Z",
        bid: 1.1043,
        ask: 1.1045,
        isSynthetic: true,
      },
      changePips: -1.2,
      regimeState: "trend",
      regimeConfidence: 0.8,
      regimeDegraded: false,
      configuredPair: "EUR_USD",
      provenance: "fixture",
      stale: false,
      barsBehind: 0,
    },
    {
      instrument: "USDJPY",
      eventTimeUtc: "2026-09-09T08:00:00.000Z",
      quote: null,
      changePips: null,
      regimeState: "unknown",
      regimeConfidence: 0,
      regimeDegraded: true,
      configuredPair: "USD_JPY",
      provenance: "fixture",
      stale: true,
      barsBehind: 2,
    },
  ],
  activeSignals: [
    {
      signalId: "sig_test_EURUSD_1h_x_long",
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: "2026-09-09T09:00:00.000Z",
      expiresAtUtc: "2026-09-09T12:00:00.000Z",
      direction: "long",
      strategyId: "mtf-momentum",
      referencePrice: 1.105,
      stopLoss: 1.0995,
      takeProfit: 1.112,
      confidence: 0.5,
      reasonCodes: ["signal_emitted"],
      snapshotHash: "a".repeat(64),
      decisionId: "ens_EURUSD_1h_t",
      action: "enter_long",
    },
  ],
  topOpportunities: [
    {
      rank: 1,
      instrument: "EURUSD",
      action: "enter_long",
      score: 0.9,
      netEdgePips: 6.4,
      confidence: 0.5,
      reasonCodes: ["vote_weighting_applied"],
      decisionId: "ens_EURUSD_1h_t",
    },
  ],
  freshness: {
    asOfUtc: "2026-09-09T10:00:00.000Z",
    freshInstruments: 1,
    staleInstruments: 1,
    totalInstruments: 2,
  },
  portfolioHeat: { heatPct: null, capPct: null, placeholder: true },
  errors: [{ instrument: "USDJPY", error: "insufficient closed history (2 bars)" }],
};

afterEach(cleanup);

describe("DashboardContent", () => {
  it("renders all six command-center surfaces", () => {
    render(<DashboardContent snapshot={snapshot} />);
    for (const heading of [
      "Market overview",
      "Active signals",
      "Regime summary",
      "Data freshness",
      "Portfolio heat",
      "Top opportunities",
    ]) {
      expect(screen.getByText(heading)).toBeDefined();
    }
  });

  it("renders instrument rows with pair-level provenance", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(screen.getAllByText(/EUR_USD \/ EURUSD/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/USD_JPY \/ USDJPY/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1.10440/).length).toBeGreaterThan(0);
    // One provenance cell per pair row — pair-level, never a blanket claim.
    expect(screen.getAllByText("fixture").length).toBe(snapshot.overview.length);
  });

  it("labels fixture provenance for the configured pairs", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(
      screen.getByText(/every row carries its configured provider pair and fixture provenance/i),
    ).toBeDefined();
  });

  it("marks stale rows visibly", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(screen.getByText("Stale (2 bars behind)")).toBeDefined();
    expect(screen.getByText("Fresh")).toBeDefined();
  });

  it("renders the active signal with its levels and expiry", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(screen.getAllByText("BUY (long)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("mtf-momentum").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-09-09T12:00:00.000Z").length).toBeGreaterThan(0);
  });

  it("renders empty-state honesty when no signals/opportunities exist", () => {
    const empty = {
      ...snapshot,
      activeSignals: [],
      topOpportunities: [],
    };
    render(<DashboardContent snapshot={empty} />);
    expect(
      screen.getByText(/No active signals at this bar/i),
    ).toBeDefined();
    expect(
      screen.getByText(/No enter decisions cleared the ensemble gates/i),
    ).toBeDefined();
  });

  it("portfolio heat shows an explicit placeholder, never a number", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(screen.getByText(/Placeholder — the risk engine/i)).toBeDefined();
  });

  it("surfaces per-instrument errors from the snapshot", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(
      screen.getByText(/insufficient closed history \(2 bars\)/i),
    ).toBeDefined();
  });

  it("freshness summary counts fresh and stale instruments", () => {
    render(<DashboardContent snapshot={snapshot} />);
    expect(screen.getByText(/1 fresh \/ 1 stale of 2 instruments/i)).toBeDefined();
  });
});

describe("FreshnessBadge", () => {
  it("renders Fresh for current rows", () => {
    render(<FreshnessBadge stale={false} barsBehind={0} />);
    expect(screen.getByText("Fresh")).toBeDefined();
  });

  it("renders Stale with bar count behind", () => {
    render(<FreshnessBadge stale={true} barsBehind={3} />);
    expect(screen.getByText("Stale (3 bars behind)")).toBeDefined();
  });
});
