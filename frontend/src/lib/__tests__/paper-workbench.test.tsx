import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaperConfirmationForm } from "@/components/paper/PaperConfirmationForm";
import { fetchPaperRun, fetchPaperWorkbench, paperWorkbenchSchema, type ActivePaperCandidate } from "@/lib/paper-workbench";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const RESOLUTION_ID = `pir_${"a".repeat(32)}`;
const RUN_ID = `rpr_${"b".repeat(32)}`;
const D = "c".repeat(64);
const candidate: ActivePaperCandidate = {
  signal: {
    signalId: "signal-1", instrument: "EURUSD", timeframe: "1h", eventTimeUtc: "2026-09-04T16:00:00.000Z",
    direction: "long", strategyId: "momentum", strategyVersion: "1.0.0", configVersion: "1.0.0", entryType: "market",
    entryPrice: null, referencePrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, expiresAtUtc: "2026-09-04T19:00:00.000Z",
    confidence: 0.5, reasonCodes: ["baseline"], inputs: { close: 1.1 }, snapshotHash: D, signalContractVersion: 1,
  },
  lifecycleState: "identified",
  resolution: {
    schemaVersion: 1, resolutionId: RESOLUTION_ID, signalId: "signal-1", instrument: "EURUSD", timeframe: "1h",
    eventTimeUtc: "2026-09-04T16:00:00.000Z", checkedAtUtc: "2026-09-04T16:00:00.000Z",
    signalDataset: { datasetId: "signal-data", artifactDigest: D, providerId: "operator-csv" },
    executionDataset: { datasetId: "execution-data", artifactDigest: D, providerId: "operator-csv" },
    config: { configId: "registered-baseline-paper-inputs", configVersion: "1.0.0", configDigest: D },
    costs: { observedSpreadPips: 0.6, estimatedSlippagePips: 0.1, source: "registered-baseline-assumption-no-provider-observation", providerObservation: false },
    conversion: { quoteCurrency: "USD", accountCurrency: "USD", conversionRate: 1, rateAtUtc: "2026-09-04T16:00:00.000Z", rateSource: "r1.6:identity:execution-data:bar", method: "identity", sourceInstrument: "EURUSD", sourceDatasetId: "execution-data", sourceArtifactDigest: D, sourceBarDigest: D, crossInstruments: [] },
    resolutionDigest: D,
  },
};

const safety = {
  paperOnly: true, explicitOperatorConfirmationRequired: true, automaticPaperExecutionEnabled: false,
  liveExecutionEnabled: false, demoExecutionEnabled: false, providerOrderTransportEnabled: false,
  externalProviderNetworkCallsEnabled: false, callerSuppliedCostOrConversionAccepted: false,
  approvedRiskRequired: true, projectionOnly: true,
} as const;
const EMPTY = {
  schemaVersion: 1, authority: "sqlite-risk-paper-authority", recovery: {}, activeCandidate: candidate,
  riskState: { eventId: "risk-event-1", sequenceNo: 1, state: "green", overrideId: null, effectiveAtUtc: "2026-09-01T00:00:00.000Z" },
  runs: [], ordering: "createdAtUtc desc, runId desc", safety,
} as const;

function submission(executed = true) {
  return { ok: true, data: { schemaVersion: 1, authority: "sqlite-risk-paper-authority", confirmation: { explicit: true, action: "confirm-paper-run" }, recovery: {}, run: { runId: RUN_ID, status: "succeeded", operatorState: "succeeded", executed }, safety: { ...safety, projectionOnly: undefined } } };
}

function validSubmission(executed = true) {
  const value = submission(executed);
  delete (value.data.safety as Record<string, unknown>).projectionOnly;
  return value;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("R1.8 paper workbench boundary", () => {
  it("accepts loading/empty durable state and rejects unsafe or unknown success state", () => {
    expect(paperWorkbenchSchema.safeParse(EMPTY).success).toBe(true);
    expect(paperWorkbenchSchema.safeParse({ ...EMPTY, safety: { ...safety, liveExecutionEnabled: true } }).success).toBe(false);
    expect(paperWorkbenchSchema.safeParse({ ...EMPTY, runs: [{ operatorState: "mystery" }] }).success).toBe(false);
  });

  it("uses authenticated no-store GET for initial render/refresh and never POSTs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: EMPTY }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchPaperWorkbench("fdb_session=private")).ok).toBe(true);
    expect((await fetchPaperWorkbench("fdb_session=private")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].method).toBeUndefined();
    }
  });

  it("fails closed for authentication, backend outage, malformed JSON and invalid run identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 })).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("not-json", { status: 200 })));
    expect((await fetchPaperWorkbench()).ok).toBe(false);
    expect(await fetchPaperWorkbench()).toEqual({ ok: false, error: "Paper backend is unavailable." });
    expect(await fetchPaperWorkbench()).toEqual({ ok: false, error: "Paper backend returned malformed JSON." });
    expect(await fetchPaperRun("not-a-run")).toEqual({ ok: false, error: "Paper run id is invalid." });
  });
});

describe("PaperConfirmationForm", () => {
  it("requires explicit confirmation and performs no POST on render or field changes", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<PaperConfirmationForm candidate={candidate} riskState="green" />);
    const button = screen.getByRole("button", { name: "Confirm paper-only run" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Requested quantity (units)"), { target: { value: "20000" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits exactly the strict R1.7 payload without cost or conversion authority", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(validSubmission()), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    render(<PaperConfirmationForm candidate={candidate} riskState="green" />);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm paper-only run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ inputResolutionId: RESOLUTION_ID, requestedQuantityUnits: 10_000, confirmation: "confirm-paper-run" });
    expect(String(init.body)).not.toMatch(/spread|slippage|conversion|dataset|riskDecision/u);
  });

  it("locks double-submit to one request and reports durable replay", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify(validSubmission(false)), { status: 200 })); })); vi.stubGlobal("fetch", fetchMock);
    render(<PaperConfirmationForm candidate={candidate} riskState="green" />);
    fireEvent.click(screen.getByRole("checkbox")); const button = screen.getByRole("button", { name: "Confirm paper-only run" });
    fireEvent.click(button); fireEvent.click(button); expect(fetchMock).toHaveBeenCalledTimes(1); release();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no duplicate run"));
  });

  it("disables submission without an authoritative candidate and surfaces backend failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { message: "durable authority unavailable" } }), { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PaperConfirmationForm candidate={null} riskState="red" />);
    expect(screen.getByRole("button")).toHaveProperty("disabled", true);
    rerender(<PaperConfirmationForm candidate={candidate} riskState="red" />); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("durable authority unavailable"));
  });
});
