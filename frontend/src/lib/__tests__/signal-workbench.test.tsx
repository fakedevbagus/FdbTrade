import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignalEvaluationForm } from "@/components/signals/SignalEvaluationForm";
import {
  fetchSignalEvaluation,
  fetchSignalWorkbench,
  signalWorkbenchListSchema,
} from "@/lib/signal-workbench";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const DATASET = {
  datasetId: "dataset-authoritative-1",
  providerId: "operator-csv",
  instrument: "EURUSD",
  timeframe: "1h",
  periodStartUtc: "2026-09-01T00:00:00.000Z",
  periodEndUtc: "2026-09-04T18:00:00.000Z",
  recordCount: 90,
  checksum: "a".repeat(64),
  mode: "historical",
  quality: { accepted: 90, quarantined: 0, gaps: 0, duplicates: 0, mode: "historical" },
  qualityState: "accepted",
  freshnessState: "fresh",
  latestBarCloseUtc: "2026-09-04T18:00:00.000Z",
  assessedAtUtc: "2026-09-04T18:00:00.000Z",
  createdAtUtc: "2026-09-04T18:00:00.000Z",
} as const;

const EMPTY_LIST = {
  schemaVersion: 1,
  authority: "sqlite",
  datasets: [DATASET],
  evaluations: { total: 0, limit: 100, runs: [] },
  ordering: "assessedAtUtc desc, createdAtUtc desc, runId desc",
  safety: {
    uiAuthority: false,
    legacyScannerAuthoritative: false,
    researchAuthorityInvoked: false,
    riskPaperAuthorityInvoked: false,
    liveExecutionEnabled: false,
    providerOrderTransportEnabled: false,
  },
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("signal workbench boundary", () => {
  it("accepts the authoritative empty state and rejects unsafe flags", () => {
    expect(signalWorkbenchListSchema.safeParse(EMPTY_LIST).success).toBe(true);
    expect(signalWorkbenchListSchema.safeParse({
      ...EMPTY_LIST,
      safety: { ...EMPTY_LIST.safety, liveExecutionEnabled: true },
    }).success).toBe(false);
  });

  it("fetches and validates the list without fixture fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: EMPTY_LIST,
    }), { status: 200 })));
    const result = await fetchSignalWorkbench("fdb_session=session");
    expect(result).toEqual({ ok: true, data: EMPTY_LIST });
  });

  it("fails closed on malformed list and invalid detail identity", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { ...EMPTY_LIST, authority: "browser" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const malformed = await fetchSignalWorkbench();
    expect(malformed.ok).toBe(false);
    const invalid = await fetchSignalEvaluation("not-a-run");
    expect(invalid).toEqual({ ok: false, error: "Signal evaluation id is invalid." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SignalEvaluationForm", () => {
  it("renders a truthful empty state with submission disabled", () => {
    render(<SignalEvaluationForm datasets={[]} />);
    expect(screen.getByRole("button", { name: /Evaluate selected dataset/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("option", { name: "No datasets available" })).toBeDefined();
  });

  it("submits exactly dataset identity plus the registered assessment instant", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: {
        result: {
          runId: `sir_${"b".repeat(32)}`,
          status: "succeeded",
          executed: true,
          outcome: "candidate",
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SignalEvaluationForm datasets={[DATASET]} />);
    fireEvent.click(screen.getByRole("button", { name: /Evaluate selected dataset/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      datasetId: DATASET.datasetId,
      assessedAtUtc: DATASET.assessedAtUtc,
    });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/signals/workbench?runId=sir_${"b".repeat(32)}`);
      expect(screen.getByRole("status").textContent).toContain("candidate");
    });
  });

  it("surfaces duplicate replay and backend failure states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          result: {
            runId: `sir_${"c".repeat(32)}`,
            status: "succeeded",
            executed: false,
            outcome: "wait",
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Signal authority recovery failed closed." },
      }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SignalEvaluationForm datasets={[DATASET]} />);
    fireEvent.click(screen.getByRole("button", { name: /Evaluate selected dataset/i }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("existing durable evaluation"));
    fireEvent.click(screen.getByRole("button", { name: /Evaluate selected dataset/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("recovery failed closed"));
  });
});
