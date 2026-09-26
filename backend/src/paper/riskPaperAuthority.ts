/** R0.9 SQLite authority for mandatory risk, paper brokerage and outcomes. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_RISK_LIMITS,
  applyPaperFill,
  applyRiskOverride,
  backtestIntentIdFor,
  computeAttributionReport,
  createPaperLedger,
  evaluateRisk,
  paperBrokerEventSchema,
  paperEventIdFor,
  paperFillContextSchema,
  paperFillPolicySchema,
  paperLedgerStateSchema,
  paperOrderFromIntent,
  paperOrderSchema,
  reconcilePaperBroker,
  riskCheckRequestSchema,
  riskDecisionSchema,
  riskOverrideIdFor,
  riskOverrideSchema,
  riskStateSchema,
  serializePaperEventCanonical,
  serializePaperFillCanonical,
  serializePaperOrderCanonical,
  signalSchema,
  simulatePaperRoundTrip,
  tradeRecordFromPaper,
  utcInstantSchema,
  type AnalyticsTradeRecord,
  type BacktestOrderIntent,
  type PaperBrokerEvent,
  type PaperFill,
  type PaperFillContext,
  type PaperFillPolicy,
  type PaperLedgerState,
  type PaperOrder,
  type RiskCheckRequest,
  type RiskConversionMetadata,
  type RiskDecision,
  type RiskOverrideAction,
  type RiskState,
  type Signal,
} from "@fdbtrade/contracts";

import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import { loadVerifiedPaperInputResolution } from "@/paper/paperInputResolutionAuthority";

export const RISK_PAPER_CONFIG_ID = "baseline-risk-paper-authority";
export const RISK_PAPER_CONFIG_VERSION = "1.0.0";
export const RISK_PAPER_CONFIG = Object.freeze({
  account: Object.freeze({ accountId: "paper-account", currency: "USD", initialCash: 100_000 }),
  riskLimits: DEFAULT_RISK_LIMITS,
  fillPolicy: Object.freeze({
    policyId: "paper-realistic" as const,
    latencyBars: 1,
    spreadPips: 0.6,
    slippagePips: 0.1,
    commissionPips: 0,
    maxFillFraction: 1,
  }),
  executionMode: "local-paper-simulation-only",
  liveExecutionEnabled: false,
  providerOrderTransportEnabled: false,
});

type Row = Record<string, unknown>;
type FaultStage = "after_run_started" | "after_risk_decision" | "after_terminal_commit";

export interface PaperRunRequest {
  inputResolutionId: string;
  requestedQuantityUnits: number;
}

export interface PaperRunResult {
  runId: string;
  status: "succeeded" | "blocked" | "failed";
  executed: boolean;
  riskDecision: RiskDecision | null;
  order: PaperOrder | null;
  outcome: Record<string, unknown> | null;
  reason: string | null;
}

export interface RiskStateRecord {
  eventId: string;
  sequenceNo: number;
  state: RiskState;
  overrideId: string | null;
  effectiveAtUtc: string;
}

export interface RiskPaperRecoveryReport {
  recoveredRuns: number;
  verifiedDecisions: number;
  verifiedOrders: number;
  verifiedFills: number;
  verifiedOutcomes: number;
  reconciliationOk: boolean;
  corruptRecords: string[];
}

interface RunEnvelope {
  request: Required<PaperRunRequest>;
  inputResolutionDigest: string;
  riskRequest: RiskCheckRequest;
  signalDatasetId: string;
  signalArtifactDigest: string;
  executionArtifactDigest: string;
  riskStateEventId: string;
  configDigest: string;
}

type UnstampedPaperEvent = PaperBrokerEvent extends infer Event
  ? Event extends { eventId: string }
    ? Omit<Event, "eventId">
    : never
  : never;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalUtc(value: string, field: string): string {
  utcInstantSchema.parse(value);
  if (new Date(value).toISOString() !== value) throw new Error(`${field} must be canonical UTC`);
  return value;
}

function assertExactKeys(value: object, allowed: readonly string[], boundary: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${boundary} contains unknown fields: ${unknown.sort().join(", ")}`);
}

function configJson(): string {
  return JSON.stringify(RISK_PAPER_CONFIG);
}

function configDigest(): string {
  return sha256(configJson());
}

function runIdFor(signalId: string): string {
  return `rpr_${sha256(signalId).slice(0, 32)}`;
}

function outcomeIdFor(orderId: string): string {
  return `pout_${sha256(orderId).slice(0, 32)}`;
}

function stateEventId(sequenceNo: number, state: RiskState, effectiveAtUtc: string): string {
  return `rse_${sha256(`${sequenceNo}|${state}|${effectiveAtUtc}`).slice(0, 32)}`;
}

function pipSize(instrument: string): number {
  return instrument.endsWith("JPY") ? 0.01 : 0.0001;
}

function startOfUtcDay(value: string): string {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString();
}

function startOfUtcWeek(value: string): string {
  const date = new Date(startOfUtcDay(value));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString();
}

function stampEvent(event: UnstampedPaperEvent): PaperBrokerEvent {
  const provisional = { ...event, eventId: `pbevt_${"0".repeat(16)}` } as PaperBrokerEvent;
  return paperBrokerEventSchema.parse({ ...provisional, eventId: paperEventIdFor(provisional) });
}

function assertDatasetAccepted(dataset: StoredDataset, label: string): void {
  if (
    dataset.qualityState !== "accepted" ||
    dataset.quality.quarantined !== 0 ||
    dataset.quality.gaps !== 0 ||
    dataset.quality.duplicates !== 0
  ) {
    throw new Error(`${label} dataset quality is not accepted`);
  }
}

export class RiskPaperAuthority {
  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
  ) {}

  registerBaseline(registeredAtUtc: string): void {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    paperFillPolicySchema.parse(RISK_PAPER_CONFIG.fillPolicy);
    withImmediateTransaction(this.database, () => {
      const existing = this.database.prepare(`
        SELECT config_digest FROM risk_paper_configs WHERE config_id = ? AND config_version = ?
      `).get(RISK_PAPER_CONFIG_ID, RISK_PAPER_CONFIG_VERSION) as Row | undefined;
      if (existing && String(existing.config_digest) !== configDigest()) {
        throw new Error("risk paper config registry drift");
      }
      if (!existing) {
        this.database.prepare(`
          INSERT INTO risk_paper_configs (
            config_id, config_version, config_digest, config_json, registered_at_utc
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          RISK_PAPER_CONFIG_ID,
          RISK_PAPER_CONFIG_VERSION,
          configDigest(),
          configJson(),
          registeredAtUtc,
        );
      }
      const initial = this.database.prepare("SELECT event_id FROM risk_state_events LIMIT 1").get();
      if (!initial) {
        this.database.prepare(`
          INSERT INTO risk_state_events (
            event_id, sequence_no, previous_state, state, action, override_id,
            actor, reason, effective_at_utc, created_at_utc
          ) VALUES (?, 1, NULL, 'green', 'initialized', NULL, 'system',
                    'r0.9_authority_initialized', ?, ?)
        `).run(stateEventId(1, "green", registeredAtUtc), registeredAtUtc, registeredAtUtc);
      }
    });
  }

  currentRiskState(): RiskStateRecord {
    const row = this.database.prepare(`
      SELECT * FROM risk_state_events ORDER BY sequence_no DESC LIMIT 1
    `).get() as Row | undefined;
    if (!row) throw new Error("risk paper baseline is not registered");
    return {
      eventId: String(row.event_id),
      sequenceNo: Number(row.sequence_no),
      state: riskStateSchema.parse(row.state),
      overrideId: row.override_id === null ? null : String(row.override_id),
      effectiveAtUtc: String(row.effective_at_utc),
    };
  }

  engageKill(actor: string, reason: string, atUtc: string): RiskStateRecord {
    return this.applyStateOverride("engage_kill", null, actor, reason, atUtc);
  }

  releaseKill(actor: string, reason: string, atUtc: string): RiskStateRecord {
    return this.applyStateOverride("release_kill", null, actor, reason, atUtc);
  }

  forceRiskState(state: Exclude<RiskState, "kill">, actor: string, reason: string, atUtc: string): RiskStateRecord {
    return this.applyStateOverride("force_state", state, actor, reason, atUtc);
  }

  private applyStateOverride(
    action: RiskOverrideAction,
    targetState: RiskState | null,
    actor: string,
    reason: string,
    atUtc: string,
  ): RiskStateRecord {
    canonicalUtc(atUtc, "atUtc");
    const overrideId = riskOverrideIdFor(action, targetState, actor, reason, atUtc);
    const existing = this.database.prepare(`
      SELECT * FROM risk_state_events WHERE override_id = ?
    `).get(overrideId) as Row | undefined;
    if (existing) {
      return {
        eventId: String(existing.event_id), sequenceNo: Number(existing.sequence_no),
        state: riskStateSchema.parse(existing.state), overrideId,
        effectiveAtUtc: String(existing.effective_at_utc),
      };
    }
    const current = this.currentRiskState();
    if (atUtc < current.effectiveAtUtc) throw new Error("risk state override is out of chronology");
    const override = riskOverrideSchema.parse({ overrideId, action, targetState, actor, reason, atUtc });
    const next = applyRiskOverride(current.state, override);
    const sequenceNo = current.sequenceNo + 1;
    const eventId = stateEventId(sequenceNo, next, atUtc);
    withImmediateTransaction(this.database, () => {
      const latest = this.currentRiskState();
      if (latest.eventId !== current.eventId) throw new Error("risk state changed concurrently");
      this.database.prepare(`
        INSERT INTO risk_state_events (
          event_id, sequence_no, previous_state, state, action, override_id,
          actor, reason, effective_at_utc, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, sequenceNo, current.state, next, action, overrideId, actor, reason, atUtc, atUtc);
    });
    return { eventId, sequenceNo, state: next, overrideId, effectiveAtUtc: atUtc };
  }

  run(request: PaperRunRequest, fault?: (stage: FaultStage) => void): PaperRunResult {
    assertExactKeys(request, ["inputResolutionId", "requestedQuantityUnits"], "paper run request");
    const resolvedInputs = loadVerifiedPaperInputResolution(
      this.database, this.marketData, request.inputResolutionId,
    );
    const createdAtUtc = canonicalUtc(resolvedInputs.checkedAtUtc, "createdAtUtc");
    const checkedAtUtc = canonicalUtc(resolvedInputs.checkedAtUtc, "checkedAtUtc");
    const conversion = {
      quoteCurrency: resolvedInputs.conversion.quoteCurrency,
      accountCurrency: resolvedInputs.conversion.accountCurrency,
      conversionRate: resolvedInputs.conversion.conversionRate,
      rateAtUtc: resolvedInputs.conversion.rateAtUtc,
      rateSource: resolvedInputs.conversion.rateSource,
    };
    if (!Number.isFinite(request.requestedQuantityUnits) || request.requestedQuantityUnits <= 0) {
      throw new Error("requestedQuantityUnits must be positive");
    }
    if (
      resolvedInputs.costs.observedSpreadPips !== RISK_PAPER_CONFIG.fillPolicy.spreadPips ||
      resolvedInputs.costs.estimatedSlippagePips !== RISK_PAPER_CONFIG.fillPolicy.slippagePips
    ) throw new Error("resolved paper costs do not match the registered fill policy");
    const candidate = this.loadCandidate(resolvedInputs.signalId);
    if (candidate.lifecycleState !== "identified" || checkedAtUtc >= candidate.signal.expiresAtUtc) {
      throw new Error("signal candidate is expired or not active");
    }
    const signalDataset = this.marketData.load(candidate.datasetId);
    const executionDataset = this.marketData.load(resolvedInputs.executionDataset.datasetId);
    if (!signalDataset || !executionDataset) throw new Error("risk paper dataset provenance missing");
    assertDatasetAccepted(signalDataset, "signal source");
    assertDatasetAccepted(executionDataset, "execution");
    if (
      executionDataset.manifest.instrument !== candidate.signal.instrument ||
      executionDataset.manifest.timeframe !== candidate.signal.timeframe
    ) throw new Error("execution dataset scope does not match signal candidate");
    const submitBarIndex = executionDataset.candles.findIndex(
      (candle) => candle.timestamp === candidate.signal.eventTimeUtc,
    );
    if (submitBarIndex < 0) throw new Error("execution dataset does not contain the signal bar");
    canonicalUtc(resolvedInputs.conversion.rateAtUtc, "conversion.rateAtUtc");
    if (
      resolvedInputs.conversion.quoteCurrency !== candidate.signal.instrument.slice(3) ||
      resolvedInputs.conversion.accountCurrency !== RISK_PAPER_CONFIG.account.currency ||
      resolvedInputs.conversion.rateAtUtc > checkedAtUtc
    ) {
      throw new Error("conversion provenance does not match the paper account decision");
    }

    const runId = runIdFor(resolvedInputs.signalId);
    const normalized: Required<PaperRunRequest> = { ...request };
    let run = this.runRow(runId);
    if (run && ["succeeded", "blocked", "failed"].includes(String(run.status))) {
      const storedEnvelope = JSON.parse(String(run.request_json)) as RunEnvelope;
      if (JSON.stringify(storedEnvelope.request) !== JSON.stringify(normalized)) {
        throw new Error("paper signal already has a divergent authoritative request");
      }
      return this.resultFor(run, false);
    }
    if (this.events().length > 0 && checkedAtUtc < this.latestEventUtc()) {
      throw new Error("paper risk decision cannot predate the durable ledger");
    }

    const inflight = this.database.prepare(`
      SELECT run_id FROM risk_paper_runs
      WHERE status IN ('pending', 'running') AND signal_id <> ? LIMIT 1
    `).get(resolvedInputs.signalId);
    if (inflight) throw new Error("another risk paper run requires recovery");

    let envelope: RunEnvelope;
    let riskRequest: RiskCheckRequest;
    if (run) {
      envelope = JSON.parse(String(run.request_json)) as RunEnvelope;
      if (JSON.stringify(envelope.request) !== JSON.stringify(normalized)) {
        throw new Error("paper signal already has a divergent authoritative request");
      }
      if (
        envelope.signalDatasetId !== candidate.datasetId ||
        envelope.signalArtifactDigest !== signalDataset.manifest.checksum.digest ||
        envelope.executionArtifactDigest !== executionDataset.manifest.checksum.digest ||
        envelope.inputResolutionDigest !== resolvedInputs.resolutionDigest ||
        envelope.configDigest !== configDigest()
      ) {
        throw new Error("risk paper recovery provenance drift");
      }
      riskRequest = riskCheckRequestSchema.parse(envelope.riskRequest);
    } else {
      const state = this.currentRiskState();
      if (state.effectiveAtUtc > checkedAtUtc) {
        throw new Error("risk state evidence cannot postdate the risk decision");
      }
      const ledger = this.replayLedger();
      const account = this.accountSnapshot(ledger, checkedAtUtc);
      riskRequest = riskCheckRequestSchema.parse({
        checkedAtUtc,
        intentId: backtestIntentIdFor(candidate.signal.signalId),
        signalId: candidate.signal.signalId,
        strategyId: candidate.signal.strategyId,
        strategyVersion: candidate.signal.strategyVersion,
        configVersion: candidate.signal.configVersion,
        snapshotHash: candidate.signal.snapshotHash,
        instrument: candidate.signal.instrument,
        timeframe: candidate.signal.timeframe,
        direction: candidate.signal.direction,
        entryType: candidate.signal.entryType,
        entryPrice: candidate.signal.entryPrice,
        referencePrice: candidate.signal.referencePrice,
        stopLoss: candidate.signal.stopLoss,
        takeProfit: candidate.signal.takeProfit,
        eventTimeUtc: candidate.signal.eventTimeUtc,
        expiresAtUtc: candidate.signal.expiresAtUtc,
        requestedQuantityUnits: request.requestedQuantityUnits,
        account,
        openPositions: this.riskOpenPositions(ledger),
        market: {
          instrument: candidate.signal.instrument,
          providerId: signalDataset.manifest.providerId,
          providerHealth: "healthy",
          barTimeframe: candidate.signal.timeframe,
          lastClosedBarOpenUtc: signalDataset.candles.at(-1)?.timestamp,
          observedSpreadPips: resolvedInputs.costs.observedSpreadPips,
          estimatedSlippagePips: resolvedInputs.costs.estimatedSlippagePips,
          conversion,
        },
        riskState: state.state,
        activeOverrideId: state.overrideId,
      });
      envelope = {
        request: normalized,
        inputResolutionDigest: resolvedInputs.resolutionDigest,
        riskRequest,
        signalDatasetId: candidate.datasetId,
        signalArtifactDigest: signalDataset.manifest.checksum.digest,
        executionArtifactDigest: executionDataset.manifest.checksum.digest,
        riskStateEventId: state.eventId,
        configDigest: configDigest(),
      };
    }
    const requestJson = JSON.stringify(envelope);
    const requestHash = sha256(requestJson);
    if (run) {
      if (String(run.request_hash) !== requestHash) {
        throw new Error("paper signal already has a divergent authoritative request");
      }
    } else {
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          INSERT INTO risk_paper_runs (
            run_id, signal_id, execution_dataset_id, request_hash, request_json,
            risk_state_event_id, status, attempts, created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        `).run(
          runId, resolvedInputs.signalId, resolvedInputs.executionDataset.datasetId, requestHash, requestJson,
          envelope.riskStateEventId, createdAtUtc, createdAtUtc,
        );
      });
      run = this.runRow(runId)!;
    }

    withImmediateTransaction(this.database, () => {
      const claimed = this.database.prepare(`
        UPDATE risk_paper_runs SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE run_id = ? AND status = 'pending'
      `).run(createdAtUtc, runId);
      if (claimed.changes !== 1) throw new Error("risk paper run could not be claimed");
    });
    fault?.("after_run_started");
    if (this.currentRiskState().eventId !== envelope.riskStateEventId) {
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE risk_paper_runs
          SET status = 'failed', failure_reason = 'risk_state_changed_before_paper',
              updated_at_utc = ?
          WHERE run_id = ? AND status = 'running'
        `).run(createdAtUtc, runId);
      });
      return this.resultFor(this.runRow(runId)!, true);
    }

    const decision = evaluateRisk(riskRequest, DEFAULT_RISK_LIMITS);
    const decisionJson = JSON.stringify(decision);
    withImmediateTransaction(this.database, () => {
      const prior = this.database.prepare("SELECT decision_json FROM risk_decisions WHERE run_id = ?")
        .get(runId) as Row | undefined;
      if (prior && String(prior.decision_json) !== decisionJson) {
        throw new Error("risk decision replay diverged");
      }
      if (!prior) {
        this.database.prepare(`
          INSERT INTO risk_decisions (
            decision_id, run_id, signal_id, risk_state_event_id, outcome,
            request_digest, request_json, decision_digest, decision_json,
            checked_at_utc, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          decision.decisionId, runId, resolvedInputs.signalId, envelope.riskStateEventId, decision.outcome,
          decision.requestDigest, JSON.stringify(riskRequest), sha256(decisionJson), decisionJson,
          checkedAtUtc, createdAtUtc,
        );
      }
      this.database.prepare(`
        UPDATE risk_paper_runs SET risk_decision_id = ?, updated_at_utc = ?
        WHERE run_id = ? AND status = 'running'
      `).run(decision.decisionId, createdAtUtc, runId);
    });
    fault?.("after_risk_decision");

    const intent = this.intentFor(candidate.signal, decision);
    const order = paperOrderFromIntent(intent, RISK_PAPER_CONFIG.fillPolicy.latencyBars);
    if (decision.outcome === "rejected") {
      this.commitRejected(runId, candidate.signal, decision, order, createdAtUtc);
    } else {
      const roundTrip = simulatePaperRoundTrip(
        order,
        executionDataset.candles,
        submitBarIndex,
        RISK_PAPER_CONFIG.fillPolicy,
        pipSize(order.instrument),
      );
      if (roundTrip.abortedReason || !roundTrip.exitFill || !roundTrip.exitReason) {
        this.commitPaperFailure(
          runId, candidate.signal, decision, order,
          `paper simulation failed closed: ${roundTrip.abortedReason ?? "missing exit"}`,
          createdAtUtc,
        );
      } else {
        this.commitRoundTrip(
          runId, candidate.signal, decision, order,
          [...roundTrip.entryFills, roundTrip.exitFill], roundTrip.exitReason,
          conversion, createdAtUtc,
        );
      }
    }
    fault?.("after_terminal_commit");
    return this.resultFor(this.runRow(runId)!, true);
  }

  recover(): RiskPaperRecoveryReport {
    const recoveredRuns = Number(withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE risk_paper_runs SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    ));
    const corruptRecords: string[] = [];
    let verifiedDecisions = 0;
    let verifiedOrders = 0;
    let verifiedFills = 0;
    let verifiedOutcomes = 0;
    for (const row of this.database.prepare("SELECT * FROM risk_decisions ORDER BY decision_id").all() as Row[]) {
      try {
        const json = String(row.decision_json);
        if (sha256(json) !== String(row.decision_digest)) throw new Error("digest");
        const decision = riskDecisionSchema.parse(JSON.parse(json));
        const replay = evaluateRisk(JSON.parse(String(row.request_json)) as RiskCheckRequest, DEFAULT_RISK_LIMITS);
        if (JSON.stringify(replay) !== JSON.stringify(decision)) throw new Error("replay");
        verifiedDecisions += 1;
      } catch { corruptRecords.push(`risk_decision:${String(row.decision_id)}`); }
    }
    for (const row of this.database.prepare("SELECT * FROM paper_orders ORDER BY order_id").all() as Row[]) {
      try {
        const json = String(row.order_json);
        const order = paperOrderSchema.parse(JSON.parse(json));
        if (sha256(serializePaperOrderCanonical(order)) !== String(row.order_digest)) throw new Error("digest");
        verifiedOrders += 1;
      } catch { corruptRecords.push(`paper_order:${String(row.order_id)}`); }
    }
    for (const row of this.fillRows()) {
      try {
        const fill = JSON.parse(String(row.fill_json)) as PaperFill;
        if (sha256(serializePaperFillCanonical(fill)) !== String(row.fill_digest)) throw new Error("digest");
        verifiedFills += 1;
      } catch { corruptRecords.push(`paper_fill:${String(row.fill_id)}`); }
    }
    for (const row of this.database.prepare("SELECT * FROM paper_outcomes ORDER BY outcome_id").all() as Row[]) {
      const json = String(row.outcome_json);
      if (sha256(json) === String(row.outcome_digest)) verifiedOutcomes += 1;
      else corruptRecords.push(`paper_outcome:${String(row.outcome_id)}`);
    }
    let reconciliationOk = false;
    try { reconciliationOk = this.reconcileAll(this.latestEventUtc()).ok; }
    catch { reconciliationOk = false; }
    if (!reconciliationOk && (verifiedOrders > 0 || verifiedFills > 0)) {
      corruptRecords.push("paper_ledger:reconciliation");
    }
    return {
      recoveredRuns, verifiedDecisions, verifiedOrders, verifiedFills,
      verifiedOutcomes, reconciliationOk, corruptRecords,
    };
  }

  listOutcomes(): Record<string, unknown>[] {
    return (this.database.prepare(`
      SELECT outcome_json FROM paper_outcomes ORDER BY closed_at_utc, outcome_id
    `).all() as Row[]).map((row) => JSON.parse(String(row.outcome_json)) as Record<string, unknown>);
  }

  private loadCandidate(signalId: string): { signal: Signal; datasetId: string; lifecycleState: string } {
    const row = this.database.prepare(`
      SELECT c.signal_json, c.dataset_id, (
        SELECT state FROM signal_lifecycle_events AS e WHERE e.signal_id = c.signal_id
        ORDER BY effective_at_utc DESC, state DESC LIMIT 1
      ) AS lifecycle_state
      FROM signal_candidates AS c WHERE c.signal_id = ?
    `).get(signalId) as Row | undefined;
    if (!row) throw new Error("signal candidate is not authoritative");
    return {
      signal: signalSchema.parse(JSON.parse(String(row.signal_json))),
      datasetId: String(row.dataset_id),
      lifecycleState: String(row.lifecycle_state),
    };
  }

  private accountSnapshot(ledger: PaperLedgerState, checkedAtUtc: string): RiskCheckRequest["account"] {
    const equity = ledger.positions.some((position) => position.status === "open")
      ? ledger.equity
      : ledger.cash;
    return {
      accountCurrency: ledger.accountCurrency,
      equity,
      dayStartUtc: startOfUtcDay(checkedAtUtc),
      equityAtDayStart: Math.max(equity, RISK_PAPER_CONFIG.account.initialCash),
      weekStartUtc: startOfUtcWeek(checkedAtUtc),
      weekPeakEquity: Math.max(equity, RISK_PAPER_CONFIG.account.initialCash),
    };
  }

  private riskOpenPositions(ledger: PaperLedgerState): RiskCheckRequest["openPositions"] {
    return ledger.positions.filter((position) => position.status === "open").map((position) => {
      const orderId = position.positionId.slice("pbpos_".length);
      const row = this.database.prepare("SELECT order_json FROM paper_orders WHERE order_id = ?")
        .get(orderId) as Row | undefined;
      if (!row || position.avgPrice === null) throw new Error("open paper position lineage missing");
      const order = paperOrderSchema.parse(JSON.parse(String(row.order_json)));
      return {
        positionId: position.positionId,
        instrument: position.instrument,
        direction: position.direction,
        quantityUnits: position.quantityUnits,
        avgPrice: position.avgPrice,
        stopLoss: order.stopLoss,
        openedAtUtc: position.openedAtUtc,
        strategyId: order.strategyId,
        conversion: position.conversion,
      };
    });
  }

  private intentFor(signal: Signal, decision: RiskDecision): BacktestOrderIntent {
    return {
      intentId: backtestIntentIdFor(signal.signalId), signalId: signal.signalId,
      strategyId: signal.strategyId, strategyVersion: signal.strategyVersion,
      configVersion: signal.configVersion, snapshotHash: signal.snapshotHash,
      instrument: signal.instrument, timeframe: signal.timeframe,
      eventTimeUtc: signal.eventTimeUtc, direction: signal.direction,
      entryType: signal.entryType, entryPrice: signal.entryPrice,
      referencePrice: signal.referencePrice, stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit, expiresAtUtc: signal.expiresAtUtc,
      quantityUnits: decision.outcome === "approved"
        ? decision.sizedQuantityUnits
        : decision.requestedQuantityUnits,
    };
  }

  private baseEvents(order: PaperOrder, checkedAtUtc: string): PaperBrokerEvent[] {
    return [
      stampEvent({ type: "order_created", atUtc: checkedAtUtc, orderId: order.orderId }),
      stampEvent({ type: "order_risk_checked", atUtc: checkedAtUtc, orderId: order.orderId }),
    ];
  }

  private commitRejected(
    runId: string, signal: Signal, decision: RiskDecision, order: PaperOrder, createdAtUtc: string,
  ): void {
    const events = [
      ...this.baseEvents(order, decision.checkedAtUtc),
      stampEvent({ type: "order_rejected", atUtc: decision.checkedAtUtc, orderId: order.orderId, reason: "risk_rejected" }),
    ];
    const allEvents = [...this.events(), ...events];
    const reconciliation = reconcilePaperBroker({
      events: allEvents, derivedFills: this.fills(), derivedLedger: this.replayLedger(),
      fillContexts: this.fillContexts(), atUtc: decision.checkedAtUtc,
    });
    if (!reconciliation.ok) throw new Error("paper rejection reconciliation failed closed");
    withImmediateTransaction(this.database, () => {
      this.insertOrder(runId, signal, decision, order, createdAtUtc);
      this.insertEvents(order.orderId, events, createdAtUtc);
      this.insertReconciliation(runId, reconciliation, createdAtUtc);
      this.database.prepare(`
        UPDATE risk_paper_runs SET status = 'blocked', order_id = ?, updated_at_utc = ?
        WHERE run_id = ? AND status = 'running'
      `).run(order.orderId, createdAtUtc, runId);
    });
  }

  private commitPaperFailure(
    runId: string, signal: Signal, decision: RiskDecision, order: PaperOrder,
    message: string, createdAtUtc: string,
  ): void {
    const events = [
      ...this.baseEvents(order, decision.checkedAtUtc),
      stampEvent({ type: "order_submitted", atUtc: decision.checkedAtUtc, orderId: order.orderId }),
      stampEvent({ type: "order_acknowledged", atUtc: decision.checkedAtUtc, orderId: order.orderId, resting: order.orderType !== "market" }),
      stampEvent({ type: "broker_error", atUtc: decision.checkedAtUtc, orderId: order.orderId, message }),
    ];
    const reconciliation = reconcilePaperBroker({
      events: [...this.events(), ...events], derivedFills: this.fills(),
      derivedLedger: this.replayLedger(), fillContexts: this.fillContexts(),
      atUtc: decision.checkedAtUtc,
    });
    if (!reconciliation.ok) throw new Error("paper failure reconciliation failed closed");
    withImmediateTransaction(this.database, () => {
      this.insertOrder(runId, signal, decision, order, createdAtUtc);
      this.insertEvents(order.orderId, events, createdAtUtc);
      this.insertReconciliation(runId, reconciliation, createdAtUtc);
      this.database.prepare(`
        UPDATE risk_paper_runs SET status = 'blocked', order_id = ?, updated_at_utc = ?
        WHERE run_id = ? AND status = 'running'
      `).run(order.orderId, createdAtUtc, runId);
    });
  }

  private commitRoundTrip(
    runId: string, signal: Signal, decision: RiskDecision, order: PaperOrder,
    fills: PaperFill[], exitReason: "stop" | "target" | "end_of_simulation",
    conversion: RiskConversionMetadata, createdAtUtc: string,
  ): void {
    const context = paperFillContextSchema.parse({ pipSize: pipSize(order.instrument), conversion });
    const entryFills = fills.filter((fill) => fill.side === "entry");
    const exitFill = fills.find((fill) => fill.side === "exit");
    if (!exitFill || entryFills.length === 0) throw new Error("paper round trip is incomplete");
    const positionId = `pbpos_${order.orderId}`;
    const events: PaperBrokerEvent[] = [
      ...this.baseEvents(order, decision.checkedAtUtc),
      stampEvent({ type: "order_submitted", atUtc: decision.checkedAtUtc, orderId: order.orderId }),
      stampEvent({ type: "order_acknowledged", atUtc: decision.checkedAtUtc, orderId: order.orderId, resting: order.orderType !== "market" }),
      ...entryFills.map((fill) => stampEvent({
        type: "fill_executed", atUtc: fill.atUtc, orderId: order.orderId,
        fillId: fill.fillId, side: fill.side, quantityUnits: fill.quantityUnits,
        price: fill.price, costs: fill.costs, remainingQuantityUnits: fill.remainingQuantityUnits,
      })),
      stampEvent({ type: "position_opened", atUtc: entryFills.at(-1)!.atUtc, positionId, orderId: order.orderId }),
      stampEvent({ type: "position_managed", atUtc: entryFills.at(-1)!.atUtc, positionId }),
      stampEvent({
        type: "fill_executed", atUtc: exitFill.atUtc, orderId: order.orderId,
        fillId: exitFill.fillId, side: exitFill.side, quantityUnits: exitFill.quantityUnits,
        price: exitFill.price, costs: exitFill.costs, remainingQuantityUnits: exitFill.remainingQuantityUnits,
      }),
    ];
    let ledger = this.replayLedger();
    let openedPosition: PaperLedgerState["positions"][number] | null = null;
    for (const fill of fills) {
      ledger = applyPaperFill(ledger, fill, context);
      if (fill.side === "entry") {
        openedPosition = ledger.positions.find((position) => position.positionId === positionId) ?? null;
      }
    }
    const position = ledger.positions.find((item) => item.positionId === positionId);
    if (!openedPosition || !position || position.status !== "closed") {
      throw new Error("paper ledger did not close its position");
    }
    ledger = paperLedgerStateSchema.parse({ ...ledger, equity: ledger.cash });
    events.push(stampEvent({
      type: "position_closed", atUtc: exitFill.atUtc, positionId,
      exitPrice: exitFill.price, exitReason, realizedPnl: position.realizedPnlQuote,
    }));
    const contexts = this.fillContexts();
    for (const fill of fills) contexts[fill.fillId] = context;
    const reconciliation = reconcilePaperBroker({
      events: [...this.events(), ...events], derivedFills: [...this.fills(), ...fills],
      derivedLedger: ledger, fillContexts: contexts, atUtc: exitFill.atUtc,
    });
    if (!reconciliation.ok) {
      throw new Error(`paper reconciliation failed closed: ${JSON.stringify(reconciliation.discrepancies)}`);
    }
    const trade = tradeRecordFromPaper(order, position, exitReason, {
      plannedRisk: decision.riskAmountAccount,
      confidence: null,
      regimeState: null,
      maePips: 0,
      mfePips: 0,
    });
    const outcomeId = outcomeIdFor(order.orderId);
    const outcome = {
      schemaVersion: 1,
      outcomeId,
      authority: "operational-paper-outcome",
      signalId: signal.signalId,
      signalSnapshotHash: signal.snapshotHash,
      riskDecisionId: decision.decisionId,
      orderId: order.orderId,
      positionId,
      trade,
      interpretation: {
        paperOnly: true,
        liveExecution: false,
        providerOrderTransport: false,
        signalConfidenceCalibrated: false,
        signalConfidenceValue: null,
        modelPromotionEligible: false,
        backtestEvidenceUsedAsConfidence: false,
      },
    };
    const outcomeJson = JSON.stringify(outcome);
    const priorTrades = this.listOutcomes().map((item) => item.trade as AnalyticsTradeRecord);
    const attribution = computeAttributionReport([...priorTrades, trade], {
      reportId: `paper-attribution-${outcomeId}`,
    });
    const attributionJson = JSON.stringify(attribution);
    withImmediateTransaction(this.database, () => {
      this.insertOrder(runId, signal, decision, order, createdAtUtc);
      this.insertEvents(order.orderId, events, createdAtUtc);
      for (const fill of fills) this.insertFill(order.orderId, fill, context, createdAtUtc);
      this.insertPositionEvent(order.orderId, openedPosition!, "opened", createdAtUtc);
      this.insertPositionEvent(order.orderId, position, "closed", createdAtUtc);
      this.insertReconciliation(runId, reconciliation, createdAtUtc);
      this.database.prepare(`
        INSERT INTO paper_outcomes (
          outcome_id, run_id, signal_id, risk_decision_id, order_id, position_id,
          outcome_digest, outcome_json, closed_at_utc, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        outcomeId, runId, signal.signalId, decision.decisionId, order.orderId, positionId,
        sha256(outcomeJson), outcomeJson, position.closedAtUtc, createdAtUtc,
      );
      this.database.prepare(`
        INSERT INTO paper_outcome_attribution_reports (
          report_id, through_outcome_id, report_digest, report_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        `poar_${sha256(attributionJson).slice(0, 32)}`, outcomeId,
        sha256(attributionJson), attributionJson, createdAtUtc,
      );
      this.database.prepare(`
        UPDATE risk_paper_runs
        SET status = 'succeeded', order_id = ?, outcome_id = ?, updated_at_utc = ?
        WHERE run_id = ? AND status = 'running'
      `).run(order.orderId, outcomeId, createdAtUtc, runId);
    });
  }

  private insertOrder(
    runId: string, signal: Signal, decision: RiskDecision, order: PaperOrder, createdAtUtc: string,
  ): void {
    const orderJson = JSON.stringify(order);
    this.database.prepare(`
      INSERT INTO paper_orders (
        order_id, run_id, signal_id, risk_decision_id, instrument, timeframe,
        direction, order_digest, order_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.orderId, runId, signal.signalId, decision.decisionId,
      order.instrument, order.timeframe, order.direction,
      sha256(serializePaperOrderCanonical(order)), orderJson, createdAtUtc,
    );
  }

  private insertEvents(orderId: string, events: PaperBrokerEvent[], createdAtUtc: string): void {
    const statement = this.database.prepare(`
      INSERT INTO paper_order_events (
        event_id, order_id, sequence_no, event_type, effective_at_utc,
        event_digest, event_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    events.forEach((event, index) => {
      const canonical = serializePaperEventCanonical(event);
      statement.run(
        event.eventId, orderId, index + 1, event.type, event.atUtc,
        sha256(canonical), JSON.stringify(event), createdAtUtc,
      );
    });
  }

  private insertFill(orderId: string, fill: PaperFill, context: PaperFillContext, createdAtUtc: string): void {
    this.database.prepare(`
      INSERT INTO paper_fills (
        fill_id, order_id, sequence_no, side, effective_at_utc,
        fill_digest, fill_json, context_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fill.fillId, orderId, fill.seq, fill.side, fill.atUtc,
      sha256(serializePaperFillCanonical(fill)), JSON.stringify(fill), JSON.stringify(context), createdAtUtc,
    );
  }

  private insertPositionEvent(
    orderId: string,
    position: PaperLedgerState["positions"][number],
    eventType: "opened" | "closed",
    createdAtUtc: string,
  ): void {
    const json = JSON.stringify(position);
    const effectiveAtUtc = eventType === "opened" ? position.openedAtUtc : position.closedAtUtc!;
    this.database.prepare(`
      INSERT INTO paper_position_events (
        position_event_id, position_id, order_id, event_type, effective_at_utc,
        position_digest, position_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `ppe_${sha256(`${position.positionId}|${eventType}`).slice(0, 32)}`,
      position.positionId, orderId, eventType, effectiveAtUtc, sha256(json), json, createdAtUtc,
    );
  }

  private insertReconciliation(runId: string, report: ReturnType<typeof reconcilePaperBroker>, createdAtUtc: string): void {
    const json = JSON.stringify(report);
    this.database.prepare(`
      INSERT INTO paper_reconciliation_reports (
        reconciliation_id, run_id, ok, report_digest, report_json,
        reconciled_at_utc, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.reconciliationId, runId, report.ok ? 1 : 0,
      sha256(json), json, report.atUtc, createdAtUtc,
    );
  }

  private events(): PaperBrokerEvent[] {
    return (this.database.prepare(`
      SELECT event_json FROM paper_order_events ORDER BY effective_at_utc, rowid
    `).all() as Row[]).map((row) => paperBrokerEventSchema.parse(JSON.parse(String(row.event_json))));
  }

  private fillRows(): Row[] {
    return this.database.prepare(`
      SELECT * FROM paper_fills ORDER BY effective_at_utc, order_id, sequence_no
    `).all() as Row[];
  }

  private fills(): PaperFill[] {
    return this.fillRows().map((row) => JSON.parse(String(row.fill_json)) as PaperFill);
  }

  private fillContexts(): Record<string, PaperFillContext> {
    return Object.fromEntries(this.fillRows().map((row) => [
      String(row.fill_id),
      paperFillContextSchema.parse(JSON.parse(String(row.context_json))),
    ]));
  }

  private replayLedger(): PaperLedgerState {
    let ledger = createPaperLedger(
      RISK_PAPER_CONFIG.account.currency,
      RISK_PAPER_CONFIG.account.initialCash,
    );
    for (const row of this.fillRows()) {
      ledger = applyPaperFill(
        ledger,
        JSON.parse(String(row.fill_json)) as PaperFill,
        paperFillContextSchema.parse(JSON.parse(String(row.context_json))),
      );
    }
    if (!ledger.positions.some((position) => position.status === "open")) {
      ledger = paperLedgerStateSchema.parse({ ...ledger, equity: ledger.cash });
    }
    return ledger;
  }

  private reconcileAll(atUtc: string): ReturnType<typeof reconcilePaperBroker> {
    return reconcilePaperBroker({
      events: this.events(), derivedFills: this.fills(), derivedLedger: this.replayLedger(),
      fillContexts: this.fillContexts(), atUtc,
    });
  }

  private latestEventUtc(): string {
    const row = this.database.prepare(`
      SELECT effective_at_utc FROM paper_order_events ORDER BY effective_at_utc DESC LIMIT 1
    `).get() as Row | undefined;
    return row ? String(row.effective_at_utc) : this.currentRiskState().effectiveAtUtc;
  }

  private runRow(runId: string): Row | undefined {
    return this.database.prepare("SELECT * FROM risk_paper_runs WHERE run_id = ?").get(runId) as Row | undefined;
  }

  private resultFor(run: Row, executed: boolean): PaperRunResult {
    const decisionRow = run.risk_decision_id === null ? undefined : this.database.prepare(`
      SELECT decision_json FROM risk_decisions WHERE decision_id = ?
    `).get(String(run.risk_decision_id)) as Row | undefined;
    const orderRow = run.order_id === null ? undefined : this.database.prepare(`
      SELECT order_json FROM paper_orders WHERE order_id = ?
    `).get(String(run.order_id)) as Row | undefined;
    const outcomeRow = run.outcome_id === null ? undefined : this.database.prepare(`
      SELECT outcome_json FROM paper_outcomes WHERE outcome_id = ?
    `).get(String(run.outcome_id)) as Row | undefined;
    return {
      runId: String(run.run_id),
      status: String(run.status) as PaperRunResult["status"],
      executed,
      riskDecision: decisionRow ? riskDecisionSchema.parse(JSON.parse(String(decisionRow.decision_json))) : null,
      order: orderRow ? paperOrderSchema.parse(JSON.parse(String(orderRow.order_json))) : null,
      outcome: outcomeRow ? JSON.parse(String(outcomeRow.outcome_json)) as Record<string, unknown> : null,
      reason: run.failure_reason === null ? null : String(run.failure_reason),
    };
  }
}
