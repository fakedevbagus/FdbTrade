/**
 * Observability service + admin route tests (P13-01).
 *
 * Covers: record happy path, redaction fail-closed through the service,
 * bounded ring, span idempotency, end-to-end trace assembly via the API
 * (`/api/admin/traces/[signalId]`), log query API (`/api/admin/logs`) with
 * correlation filter + malformed filter rejection, session guard (401), and
 * method guards. Session lookup stubbed at the auth-store boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import { buildSignalPipelineSpans, type ObsTraceSpan } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-obs";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-1",
    userId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-1", username: "owner", isActive: true, mfaEnabled: false },
};

vi.mock("@/auth/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/store")>();
  return {
    ...actual,
    getSessionByToken: vi.fn(async (token: string) =>
      token === SESSION_TOKEN ? AUTH_RESULT : null,
    ),
  };
});

import { obsService, ObsService } from "@/obs/service";
import { GET as getLogs, POST as postLogs } from "@/app/api/admin/logs/route";
import {
  GET as getTrace,
  POST as postTrace,
} from "@/app/api/admin/traces/[signalId]/route";


function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

/** Strip spanId to get a recordable input. */
function spanContent(span: ObsTraceSpan) {
  const { spanId: _spanId, ...content } = span;
  return content;
}

const T0 = "2026-09-11T10:00:00.000Z";
const T1 = "2026-09-11T10:00:01.000Z";
const T2 = "2026-09-11T10:00:02.000Z";
const T3 = "2026-09-11T10:00:03.000Z";

describe("ObsService", () => {
  let service: ObsService;

  beforeEach(() => {
    service = new ObsService();
  });

  it("records a redacted log line with a deterministic id", () => {
    const record = service.info("market", "candle_range_served", {
      correlationId: "req-1",
      entities: ["ens_EURUSD_1"],
      attributes: { instrument: "EURUSD", bars: 50 },
      message: "served range",
    });
    expect(record.recordId).toMatch(/^obslog_[0-9a-f]{16}$/);
    expect(record.attributes).toEqual({ instrument: "EURUSD", bars: 50 });
    expect(service.recordsForCorrelation("req-1")).toHaveLength(1);
  });

  it("fails closed when a secret-shaped attribute key crosses record()", () => {
    expect(() =>
      service.info("market", "provider_call", {
        correlationId: "req-1",
        attributes: { api_key: "sk-123" },
      }),
    ).toThrow(/secret-shaped/);
    expect(service.records()).toHaveLength(0);
  });

  it("bounds the in-memory ring", () => {
    const small = new ObsService({ maxRecords: 3 });
    for (let i = 0; i < 6; i += 1) {
      small.info("market", "e", {
        correlationId: `req-${i}`,
        attributes: { i },
      });
    }
    expect(small.records()).toHaveLength(3);
    expect(small.records()[0].attributes).toEqual({ i: 3 });
  });

  it("records spans idempotently and assembles a full trace", () => {
    const spans = buildSignalPipelineSpansFixture();
    for (const span of spans) {
      const recorded = service.recordSpan(spanContent(span));
      expect(recorded.spanId).toBe(span.spanId);
    }
    // Duplicate append is a no-op.
    service.recordSpan(spanContent(spans[0]));
    expect(service.spansFor("ens_EURUSD_1")).toHaveLength(4);
    const trace = service.traceFor("ens_EURUSD_1");
    expect(trace?.complete).toBe(true);
    expect(trace?.steps.map((s) => s.stage)).toEqual([
      "signal",
      "risk",
      "execution",
      "analytics",
    ]);
  });

  it("traceFor returns null for an unknown signal (never fabricated)", () => {
    expect(service.traceFor("ens_UNKNOWN_1")).toBeNull();
  });
});

describe("GET /api/admin/logs", () => {
  it("returns the (possibly empty) record list", async () => {
    const response = await getLogs(request("/api/admin/logs"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { records: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.records)).toBe(true);
  });

  it("filters by a well-formed correlation id", async () => {
    const service = new ObsService();
    service.info("market", "e_one", { correlationId: "req-filter-1", attributes: {} });
    const filtered = service.recordsForCorrelation("req-filter-1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].correlationId).toBe("req-filter-1");
  });

  it("rejects a malformed correlation id with 400", async () => {
    const response = await getLogs(request("/api/admin/logs?correlationId=bad%20id!"));
    expect(response.status).toBe(400);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await getLogs(new Request("http://localhost:3100/api/admin/logs"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405 (read-only surface)", async () => {
    const response = await postLogs(request("/api/admin/logs", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});

describe("GET /api/admin/traces/[signalId]", () => {
  it("returns a full trace for a recorded signal", async () => {
    const spans = buildSignalPipelineSpans({
      correlationId: "req-trace-2",
      signalId: "ens_USDJPY_1",
      strategyId: "breakout",
      instrument: "USDJPY",
      decidedAtUtc: T0,
      riskCheckedAtUtc: T1,
      executedAtUtc: T2,
      outcomeAtUtc: T3,
      riskOutcome: "approved",
      executionOutcome: "filled",
      outcome: "closed_loss_0.9r",
    });
    for (const span of spans) {
      obsService.recordSpan(spanContent(span));
    }
    const response = await getTrace(request("/api/admin/traces/ens_USDJPY_1"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { signalId: string; complete: boolean; outcomeRecorded: boolean };
    };
    expect(body.data.signalId).toBe("ens_USDJPY_1");
    expect(body.data.complete).toBe(true);
    expect(body.data.outcomeRecorded).toBe(true);
  });

  it("unknown signal -> 404 (no fabricated trace)", async () => {
    const response = await getTrace(request("/api/admin/traces/ens_NOPE_1"));
    expect(response.status).toBe(404);
  });

  it("missing session -> 401", async () => {
    const response = await getTrace(new Request("http://localhost:3100/api/admin/traces/x"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405", async () => {
    const response = await postTrace(request("/api/admin/traces/ens_USDJPY_1", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});


function buildSignalPipelineSpansFixture() {
  return buildSignalPipelineSpans({
    correlationId: "req-trace-1",
    signalId: "ens_EURUSD_1",
    strategyId: "trend-pullback",
    instrument: "EURUSD",
    decidedAtUtc: T0,
    riskCheckedAtUtc: T1,
    executedAtUtc: T2,
    outcomeAtUtc: T3,
    riskOutcome: "approved",
    executionOutcome: "filled",
    outcome: "closed_win_1.8r",
  });
}
