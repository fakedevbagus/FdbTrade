/**
 * Structured logging/tracing contract tests (P13-01).
 *
 * Covers: happy path (record build + append + query), malformed input
 * (bad level/stage/event shape, non-UTC time), redaction fail-closed
 * (secret-shaped keys and non-scalar values rejected), duplicate append
 * refused (idempotency), deterministic ids + canonical serialization pinned,
 * span boundary (end < start refused), trace assembly from shuffled input
 * (deterministic ordering), full-pipeline coverage flag, and the acceptance
 * fixture: one signal traced decision -> risk -> paper execution -> outcome.
 */
import { describe, expect, it } from "vitest";

import {
  appendObsLogRecord,
  assembleTrace,
  buildSignalPipelineSpans,
  createObsLog,
  OBS_LOG_LEVELS,
  OBS_PIPELINE_STAGES,
  obsLogRecordIdFor,
  obsLogRecordSchema,
  obsRecordsForCorrelation,
  obsRecordsForEntity,
  obsTraceSpanIdFor,
  obsTraceSpanSchema,
  OBS_REDACTED_KEY_PATTERN,
  serializeObsLogContentCanonical,
  serializeObsSpanCanonical,
  traceCoversFullPipeline,
  type ObsLogRecordInput,
  type ObsTraceSpanInput,
} from "../obs/logging";

const T0 = "2026-09-11T10:00:00.000Z";
const T1 = "2026-09-11T10:00:01.000Z";
const T2 = "2026-09-11T10:00:02.000Z";
const T3 = "2026-09-11T10:00:03.000Z";

function recordInput(overrides: Partial<ObsLogRecordInput> = {}): ObsLogRecordInput {
  return {
    level: "info",
    atUtc: T0,
    stage: "market",
    event: "candle_range_served",
    correlationId: "req-abc123",
    entities: ["ens_EURUSD_1"],
    attributes: { instrument: "EURUSD", bars: 100 },
    message: "served candle range",
    ...overrides,
  };
}

function spanInput(overrides: Partial<ObsTraceSpanInput> = {}): ObsTraceSpanInput {
  return {
    correlationId: "req-abc123",
    signalId: "ens_EURUSD_1",
    stage: "signal",
    operation: "ensemble_decision",
    startedAtUtc: T0,
    endedAtUtc: T0,
    status: "ok",
    errorCode: null,
    attributes: { strategyId: "trend-pullback" },
    ...overrides,
  };
}

describe("obs log records", () => {
  it("happy path: builds a deterministic id and appends", () => {
    const input = recordInput();
    const id = obsLogRecordIdFor(input);
    expect(id).toMatch(/^obslog_[0-9a-f]{16}$/);
    const parsed = obsLogRecordSchema.parse({ ...input, recordId: id });
    expect(parsed.level).toBe("info");
    const log = appendObsLogRecord(createObsLog(), input);
    expect(log.records).toHaveLength(1);
    expect(log.records[0].recordId).toBe(id);
  });

  it("is idempotent per content: same input -> same id; duplicate append refused", () => {
    const input = recordInput();
    expect(obsLogRecordIdFor(input)).toBe(obsLogRecordIdFor({ ...input }));
    let log = appendObsLogRecord(createObsLog(), input);
    expect(() => appendObsLogRecord(log, input)).toThrow(/duplicate log record/);
    // A different atUtc is a DIFFERENT event and may be appended.
    log = appendObsLogRecord(log, recordInput({ atUtc: T1 }));
    expect(log.records).toHaveLength(2);
  });

  it("deterministic ids: attribute order does not change the id", () => {
    const a = recordInput({ attributes: { a: 1, b: "x", c: null } });
    const b = recordInput({ attributes: { c: null, b: "x", a: 1 } });
    expect(obsLogRecordIdFor(a)).toBe(obsLogRecordIdFor(b));
  });

  it("canonical serialization is pinned", () => {
    const input = recordInput();
    expect(serializeObsLogContentCanonical(input)).toBe(
      [
        "obslog",
        "info",
        T0,
        "market",
        "candle_range_served",
        "req-abc123",
        "ens_EURUSD_1",
        "bars=100,instrument=EURUSD",
        "served candle range",
      ].join("|"),
    );
  });

  it("rejects malformed level/stage/event/time", () => {
    expect(() => obsLogRecordIdFor(recordInput({ level: "loud" as never }))).toThrow();
    expect(() => obsLogRecordIdFor(recordInput({ stage: "quantum" as never }))).toThrow();
    expect(() => obsLogRecordIdFor(recordInput({ event: "Not-Snake" }))).toThrow();
    expect(() => obsLogRecordIdFor(recordInput({ atUtc: "2026-09-11T10:00:00Z" }))).toThrow();
    expect(() => obsLogRecordIdFor(recordInput({ correlationId: "bad id!" }))).toThrow();
  });

  it("redaction fail closed: secret-shaped attribute keys are refused", () => {
    for (const key of ["password", "api_key", "apiKey", "SECRET", "authToken", "cookie", "authorization"]) {
      expect(OBS_REDACTED_KEY_PATTERN.test(key)).toBe(true);
      expect(() => obsLogRecordIdFor(recordInput({ attributes: { [key]: "x" } }))).toThrow();
    }
  });

  it("redaction fail closed: non-scalar attribute values are refused", () => {
    expect(() =>
      obsLogRecordIdFor(recordInput({ attributes: { nested: { deep: 1 } as never } })),
    ).toThrow();
    expect(() =>
      obsLogRecordIdFor(recordInput({ attributes: { list: [1, 2] as never } })),
    ).toThrow();
  });

  it("queries by correlation and entity", () => {
    let log = createObsLog();
    log = appendObsLogRecord(log, recordInput({ event: "e_one", entities: ["s1"] }));
    log = appendObsLogRecord(log, recordInput({ event: "e_two", entities: ["s2"] }));
    log = appendObsLogRecord(
      log,
      recordInput({ atUtc: T1, event: "e_three", entities: ["s1", "s2"] }),
    );
    expect(obsRecordsForCorrelation(log, "req-abc123")).toHaveLength(3);
    expect(obsRecordsForEntity(log, "s1").map((r) => r.event)).toEqual(["e_one", "e_three"]);
    expect(obsRecordsForEntity(log, "unknown")).toEqual([]);
  });

  it("frozen vocabularies stay stable", () => {
    expect(OBS_LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    expect(OBS_PIPELINE_STAGES).toEqual([
      "market",
      "signal",
      "risk",
      "execution",
      "analytics",
      "admin",
    ]);
  });
});

describe("obs trace spans", () => {
  it("happy path: content-addressed span id + canonical serialization", () => {
    const input = spanInput();
    const spanId = obsTraceSpanIdFor(input);
    expect(spanId).toMatch(/^obsspan_[0-9a-f]{16}$/);
    const span = obsTraceSpanSchema.parse({ ...input, spanId });
    expect(serializeObsSpanCanonical(span)).toBe(
      [
        "obsspan",
        "req-abc123",
        "ens_EURUSD_1",
        "signal",
        "ensemble_decision",
        T0,
        T0,
        "ok",
        "-",
        "strategyId=trend-pullback",
        spanId,
      ].join("|"),
    );
  });

  it("boundary: end before start is refused", () => {
    expect(() => obsTraceSpanIdFor(spanInput({ endedAtUtc: "2026-09-11T09:59:59.000Z" }))).toThrow();
  });

  it("error spans carry a code; ok spans carry null", () => {
    // ok span: errorCode null parses.
    expect(() =>
      obsTraceSpanSchema.parse({ ...spanInput(), spanId: obsTraceSpanIdFor(spanInput()) }),
    ).not.toThrow();
    // error span: a reason code is REQUIRED.
    expect(() =>
      obsTraceSpanSchema.parse({
        ...spanInput({ status: "error", errorCode: null }),
        spanId: obsTraceSpanIdFor(spanInput({ status: "error", errorCode: null })),
      }),
    ).toThrow(/errorCode/);
    // ok span: errorCode must be null.
    expect(() =>
      obsTraceSpanSchema.parse({
        ...spanInput({ errorCode: "some_code" }),
        spanId: obsTraceSpanIdFor(spanInput({ errorCode: "some_code" })),
      }),
    ).toThrow(/errorCode/);
    // error span with a code parses.
    expect(() =>
      obsTraceSpanSchema.parse({
        ...spanInput({ status: "error", errorCode: "risk_rejected" }),
        spanId: obsTraceSpanIdFor(spanInput({ status: "error", errorCode: "risk_rejected" })),
      }),
    ).not.toThrow();
  });

  it("redaction applies to spans too", () => {
    expect(() => obsTraceSpanIdFor(spanInput({ attributes: { api_key: "k" } }))).toThrow();
  });
});

describe("end-to-end trace assembly (acceptance)", () => {
  const signalId = "ens_EURUSD_1";
  const spans = buildSignalPipelineSpans({
    correlationId: "req-trace-1",
    signalId,
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

  it("a single signal is traced through decision, risk, execution and outcome", () => {
    const trace = assembleTrace(spans, signalId);
    expect(trace.correlationId).toBe("req-trace-1");
    expect(trace.steps.map((s) => s.operation)).toEqual([
      "ensemble_decision",
      "risk_evaluation",
      "paper_execution",
      "outcome_recorded",
    ]);
    expect(trace.steps.map((s) => s.stage)).toEqual(["signal", "risk", "execution", "analytics"]);
    expect(trace.stagesPresent).toEqual(["signal", "risk", "execution", "analytics"]);
    expect(trace.outcomeRecorded).toBe(true);
    expect(traceCoversFullPipeline(trace)).toBe(true);
  });

  it("is deterministic: shuffled input order assembles an identical trace", () => {
    const a = assembleTrace(spans, signalId);
    const shuffled = [...spans].reverse();
    const b = assembleTrace(shuffled, signalId);
    expect(b).toEqual(a);
  });

  it("rejects a signal with no spans (never fabricates a trace)", () => {
    expect(() => assembleTrace(spans, "ens_UNKNOWN_1")).toThrow(/no spans/);
  });

  it("rejects spans that disagree on the correlation id", () => {
    const alien = obsTraceSpanSchema.parse({
      ...spanInput({ correlationId: "req-other", stage: "market", startedAtUtc: T1, endedAtUtc: T1 }),
      spanId: "obsspan_0123456789abcdef",
    });
    expect(() => assembleTrace([...spans, alien], signalId)).toThrow(/disagree on correlation/);
  });

  it("incomplete pipeline is flagged, never green-by-default", () => {
    const partial = spans.filter((s) => s.stage !== "analytics");
    const trace = assembleTrace(partial, signalId);
    expect(trace.outcomeRecorded).toBe(false);
    expect(traceCoversFullPipeline(trace)).toBe(false);
  });

  it("rejected risk path is visible as an error span", () => {
    const rejected = buildSignalPipelineSpans({
      correlationId: "req-trace-2",
      signalId: "ens_GBPUSD_1",
      strategyId: "momentum",
      instrument: "GBPUSD",
      decidedAtUtc: T0,
      riskCheckedAtUtc: T1,
      executedAtUtc: T2,
      outcomeAtUtc: T3,
      riskOutcome: "rejected",
      executionOutcome: "rejected",
      outcome: "not_executed_risk_rejected",
    });
    const trace = assembleTrace(rejected, "ens_GBPUSD_1");
    const risk = trace.steps.find((s) => s.stage === "risk");
    expect(risk?.status).toBe("error");
    expect(risk?.errorCode).toBe("risk_rejected");
  });
});

