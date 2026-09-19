/**
 * Broker Health and Position Drift Checking Subsystem (P15-04).
 *
 * Compares internal application position/balance state against read-only broker state:
 * - Detects quantity mismatches, side/direction mismatches, phantom app positions,
 *   untracked broker positions, price deviations, and equity/balance drift.
 * - Categorizes discrepancies by severity: INFO, WARNING, CRITICAL.
 * - Broker health monitoring tracking heartbeats, latency thresholds, and degradation.
 *
 * HARD BOUNDARY (Acceptance Criterion):
 * - Discrepancies NEVER trigger automatic orders.
 * - NO auto-heal through trading.
 * - Purely observational, diagnostic, and auditable.
 * - All timestamps UTC (ADR-0004).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import {
  type BrokerAccount,
  brokerAccountSchema,
  type BrokerHealth,
  type BrokerHealthStatus,
  brokerHealthStatusSchema,
  type BrokerPosition,
  brokerPositionSchema,
} from "./contract";
import { brokerHash16 } from "./sync";

export const BROKER_DRIFT_ID = "broker-drift";
export const BROKER_DRIFT_VERSION = "1.0.0";

export const BROKER_DISCREPANCY_CODES = [
  "POSITION_QTY_MISMATCH",
  "POSITION_SIDE_MISMATCH",
  "PHANTOM_APP_POSITION",
  "UNTRACKED_BROKER_POSITION",
  "PRICE_DRIFT_EXCEEDED",
  "EQUITY_DRIFT_EXCEEDED",
  "STALE_BROKER_FEED",
] as const;

export type BrokerDiscrepancyCode = (typeof BROKER_DISCREPANCY_CODES)[number];
export const brokerDiscrepancyCodeSchema = z.enum(BROKER_DISCREPANCY_CODES);

export const brokerDiscrepancySeveritySchema = z.enum(["info", "warning", "critical"]);
export type BrokerDiscrepancySeverity = z.infer<typeof brokerDiscrepancySeveritySchema>;

export const brokerDiscrepancySchema = z
  .object({
    code: brokerDiscrepancyCodeSchema,
    severity: brokerDiscrepancySeveritySchema,
    symbol: z.string().min(1),
    appPositionId: z.string().nullable().default(null),
    brokerTicket: z.string().nullable().default(null),
    appValue: z.union([z.string(), z.number()]).nullable().default(null),
    brokerValue: z.union([z.string(), z.number()]).nullable().default(null),
    delta: z.number().nullable().default(null),
    message: z.string().min(1),
    atUtc: utcInstantSchema,
  })
  .strict();

export type BrokerDiscrepancy = z.infer<typeof brokerDiscrepancySchema>;

export const brokerDriftReportSchema = z
  .object({
    reportId: z.string().regex(/^brkdrf_[0-9a-f]{16}$/),
    atUtc: utcInstantSchema,
    clean: z.boolean(),
    appPositionCount: z.number().int().min(0),
    brokerPositionCount: z.number().int().min(0),
    matchedCount: z.number().int().min(0),
    discrepancyCount: z.number().int().min(0),
    criticalCount: z.number().int().min(0),
    warningCount: z.number().int().min(0),
    infoCount: z.number().int().min(0),
    discrepancies: z.array(brokerDiscrepancySchema),
  })
  .strict();

export type BrokerDriftReport = z.infer<typeof brokerDriftReportSchema>;

/** Generic app position shape expected by drift checker. */
export interface AppPositionInput {
  positionId: string;
  symbol: string;
  direction: "long" | "short";
  quantityUnits: number;
  openPrice: number;
  status?: "open" | "closed";
}

export interface AppAccountInput {
  balance: number;
  equity: number;
}

export interface BrokerDriftOptions {
  /** Quantity tolerance in units (default 0.001 units). */
  qtyToleranceUnits?: number;
  /** Maximum allowable relative open price drift fraction (default 0.005, i.e. 0.5%). */
  maxPriceDriftFraction?: number;
  /** Maximum allowable relative equity drift fraction (default 0.05, i.e. 5%). */
  maxEquityDriftFraction?: number;
}


function normalizeSymbol(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function round6(val: number): number {
  return Math.round(val * 1e6) / 1e6;
}

export class BrokerDriftChecker {
  private readonly qtyToleranceUnits: number;
  private readonly maxPriceDriftFraction: number;
  private readonly maxEquityDriftFraction: number;

  constructor(options?: BrokerDriftOptions) {
    this.qtyToleranceUnits = options?.qtyToleranceUnits ?? 0.001;
    this.maxPriceDriftFraction = options?.maxPriceDriftFraction ?? 0.005; // 0.5%
    this.maxEquityDriftFraction = options?.maxEquityDriftFraction ?? 0.05; // 5.0%
  }

  compare(params: {
    appPositions: AppPositionInput[];
    brokerPositions: BrokerPosition[];
    appAccount?: AppAccountInput;
    brokerAccount?: BrokerAccount;
    isBrokerFeedStale?: boolean;
    atUtc?: string;
  }): BrokerDriftReport {
    const nowIso = params.atUtc ?? new Date().toISOString();
    const discrepancies: BrokerDiscrepancy[] = [];

    // 1. Feed Staleness Check
    if (params.isBrokerFeedStale) {
      discrepancies.push({
        code: "STALE_BROKER_FEED",
        severity: "warning",
        symbol: "SYSTEM",
        appPositionId: null,
        brokerTicket: null,
        appValue: null,
        brokerValue: "stale",
        delta: null,
        message: "Broker feed is stale: prices and positions may not reflect live terminal state",
        atUtc: nowIso,
      });
    }

    // 2. Filter open app positions
    const openAppPositions = params.appPositions.filter(
      (p) => !p.status || p.status === "open",
    );

    interface AggEntry {
      symbol: string;
      direction: "long" | "short";
      quantityUnits: number;
      openPrice: number;
      positionIds: string[];
    }

    const appBySym = new Map<string, AggEntry>();
    for (const pos of openAppPositions) {
      const symKey = normalizeSymbol(pos.symbol);
      const existing = appBySym.get(symKey);
      if (!existing) {
        appBySym.set(symKey, {
          symbol: pos.symbol,
          direction: pos.direction,
          quantityUnits: pos.quantityUnits,
          openPrice: pos.openPrice,
          positionIds: [pos.positionId],
        });
      } else {
        const totalQty = existing.quantityUnits + pos.quantityUnits;
        const weightedPrice =
          totalQty > 0
            ? (existing.openPrice * existing.quantityUnits + pos.openPrice * pos.quantityUnits) /
              totalQty
            : existing.openPrice;
        existing.quantityUnits = totalQty;
        existing.openPrice = round6(weightedPrice);
        existing.positionIds.push(pos.positionId);
      }
    }

    interface BrokerAggEntry {
      symbol: string;
      direction: "long" | "short";
      quantityUnits: number;
      openPrice: number;
      tickets: string[];
    }

    const brokerBySym = new Map<string, BrokerAggEntry>();
    for (const pos of params.brokerPositions) {
      const symKey = normalizeSymbol(pos.symbol);
      const existing = brokerBySym.get(symKey);
      if (!existing) {
        brokerBySym.set(symKey, {
          symbol: pos.symbol,
          direction: pos.direction,
          quantityUnits: pos.quantityUnits,
          openPrice: pos.openPrice,
          tickets: [pos.brokerTicket],
        });
      } else {
        const totalQty = existing.quantityUnits + pos.quantityUnits;
        const weightedPrice =
          totalQty > 0
            ? (existing.openPrice * existing.quantityUnits + pos.openPrice * pos.quantityUnits) /
              totalQty
            : existing.openPrice;
        existing.quantityUnits = totalQty;
        existing.openPrice = round6(weightedPrice);
        existing.tickets.push(pos.brokerTicket);
      }
    }
    let matchedCount = 0;

    for (const [symKey, appPos] of appBySym.entries()) {
      const brokerPos = brokerBySym.get(symKey);

      if (!brokerPos || brokerPos.quantityUnits <= 0) {
        discrepancies.push({
          code: "PHANTOM_APP_POSITION",
          severity: "critical",
          symbol: appPos.symbol,
          appPositionId: appPos.positionIds.join(","),
          brokerTicket: null,
          appValue: appPos.quantityUnits,
          brokerValue: 0,
          delta: appPos.quantityUnits,
          message: `Phantom app position detected: open in app (${appPos.quantityUnits} units) but not on broker`,
          atUtc: nowIso,
        });
        continue;
      }

      matchedCount++;

      if (appPos.direction !== brokerPos.direction) {
        discrepancies.push({
          code: "POSITION_SIDE_MISMATCH",
          severity: "critical",
          symbol: appPos.symbol,
          appPositionId: appPos.positionIds.join(","),
          brokerTicket: brokerPos.tickets.join(","),
          appValue: appPos.direction,
          brokerValue: brokerPos.direction,
          delta: null,
          message: `Position side mismatch: app direction is ${appPos.direction} while broker is ${brokerPos.direction}`,
          atUtc: nowIso,
        });
      }

      const qtyDelta = Math.abs(appPos.quantityUnits - brokerPos.quantityUnits);
      if (qtyDelta > this.qtyToleranceUnits) {
        const relDelta = appPos.quantityUnits > 0 ? qtyDelta / appPos.quantityUnits : 1;
        const severity = relDelta > 0.05 ? "critical" : "warning";
        discrepancies.push({
          code: "POSITION_QTY_MISMATCH",
          severity,
          symbol: appPos.symbol,
          appPositionId: appPos.positionIds.join(","),
          brokerTicket: brokerPos.tickets.join(","),
          appValue: appPos.quantityUnits,
          brokerValue: brokerPos.quantityUnits,
          delta: round6(qtyDelta),
          message: `Position quantity mismatch: app=${appPos.quantityUnits}, broker=${brokerPos.quantityUnits}, delta=${round6(qtyDelta)}`,
          atUtc: nowIso,
        });
      }

      if (appPos.openPrice > 0 && brokerPos.openPrice > 0) {
        const priceDelta = Math.abs(appPos.openPrice - brokerPos.openPrice);
        const priceRelDrift = priceDelta / brokerPos.openPrice;
        if (priceRelDrift > this.maxPriceDriftFraction) {
          discrepancies.push({
            code: "PRICE_DRIFT_EXCEEDED",
            severity: "warning",
            symbol: appPos.symbol,
            appPositionId: appPos.positionIds.join(","),
            brokerTicket: brokerPos.tickets.join(","),
            appValue: appPos.openPrice,
            brokerValue: brokerPos.openPrice,
            delta: round6(priceDelta),
            message: `Open price drift exceeded tolerance: app=${appPos.openPrice}, broker=${brokerPos.openPrice} (drift=${round6(priceRelDrift * 100)}%)`,
            atUtc: nowIso,
          });
        }
      }
    }

    for (const [symKey, brokerPos] of brokerBySym.entries()) {
      if (!appBySym.has(symKey) && brokerPos.quantityUnits > 0) {
        discrepancies.push({
          code: "UNTRACKED_BROKER_POSITION",
          severity: "critical",
          symbol: brokerPos.symbol,
          appPositionId: null,
          brokerTicket: brokerPos.tickets.join(","),
          appValue: 0,
          brokerValue: brokerPos.quantityUnits,
          delta: brokerPos.quantityUnits,
          message: `Untracked broker position detected: open on broker (${brokerPos.quantityUnits} units) but missing from app ledger`,
          atUtc: nowIso,
        });
      }
    }

    if (params.appAccount && params.brokerAccount) {
      const brokerEq = params.brokerAccount.equity;
      const appEq = params.appAccount.equity;
      const eqDelta = Math.abs(appEq - brokerEq);
      const eqDriftFraction = Math.abs(brokerEq) > 0 ? eqDelta / Math.abs(brokerEq) : 0;

      if (eqDriftFraction > this.maxEquityDriftFraction) {
        const severity = eqDriftFraction > 0.15 ? "critical" : "warning";
        discrepancies.push({
          code: "EQUITY_DRIFT_EXCEEDED",
          severity,
          symbol: "ACCOUNT",
          appPositionId: null,
          brokerTicket: null,
          appValue: round6(appEq),
          brokerValue: round6(brokerEq),
          delta: round6(eqDelta),
          message: `Equity drift exceeded threshold: app=${round6(appEq)}, broker=${round6(brokerEq)} (drift=${round6(eqDriftFraction * 100)}%)`,
          atUtc: nowIso,
        });
      }
    }

    const criticalCount = discrepancies.filter((d) => d.severity === "critical").length;
    const warningCount = discrepancies.filter((d) => d.severity === "warning").length;
    const infoCount = discrepancies.filter((d) => d.severity === "info").length;

    const content = `${nowIso}|${openAppPositions.length}|${params.brokerPositions.length}|${discrepancies.length}|${criticalCount}|${warningCount}`;
    const reportId = `brkdrf_${brokerHash16(content)}`;

    return brokerDriftReportSchema.parse({
      reportId,
      atUtc: nowIso,
      clean: discrepancies.length === 0,
      appPositionCount: openAppPositions.length,
      brokerPositionCount: params.brokerPositions.length,
      matchedCount,
      discrepancyCount: discrepancies.length,
      criticalCount,
      warningCount,
      infoCount,
      discrepancies,
    });
  }
}

export interface BrokerHealthMonitorOptions {
  adapterName?: string;
  brokerId?: string;
  maxLatencyMs?: number; // default 500ms
  maxFailuresBeforeUnhealthy?: number; // default 3
}

/**
 * Health monitor for tracking broker connectivity, latency, and heartbeat stability.
 */
export class BrokerHealthMonitor {
  readonly adapterName: string;
  readonly brokerId: string;
  private readonly maxLatencyMs: number;
  private readonly maxFailuresBeforeUnhealthy: number;
  private consecutiveFailures = 0;
  private lastLatencyMs = 0;
  private lastHeartbeatUtc: string;
  private isConnected = false;

  constructor(options?: BrokerHealthMonitorOptions) {
    this.adapterName = options?.adapterName ?? "broker-health-monitor";
    this.brokerId = options?.brokerId ?? "default";
    this.maxLatencyMs = options?.maxLatencyMs ?? 500;
    this.maxFailuresBeforeUnhealthy = options?.maxFailuresBeforeUnhealthy ?? 3;
    this.lastHeartbeatUtc = new Date().toISOString();
  }

  recordHeartbeat(params: {
    ok: boolean;
    latencyMs: number;
    atUtc?: string;
    message?: string | null;
  }): BrokerHealth {
    const nowIso = params.atUtc ?? new Date().toISOString();
    this.lastHeartbeatUtc = nowIso;
    this.lastLatencyMs = params.latencyMs;

    if (params.ok) {
      this.isConnected = true;
      this.consecutiveFailures = 0;
    } else {
      this.isConnected = false;
      this.consecutiveFailures++;
    }

    let status: BrokerHealthStatus = "healthy";
    if (this.consecutiveFailures >= this.maxFailuresBeforeUnhealthy || !this.isConnected) {
      status = "unhealthy";
    } else if (this.consecutiveFailures > 0 || params.latencyMs > this.maxLatencyMs) {
      status = "degraded";
    }

    return {
      adapterName: this.adapterName,
      brokerId: this.brokerId,
      status,
      connected: this.isConnected,
      latencyMs: params.latencyMs,
      lastHeartbeatUtc: nowIso,
      message: params.message ?? (params.ok ? "Heartbeat OK" : "Heartbeat failed"),
      details: {
        consecutiveFailures: this.consecutiveFailures,
        maxLatencyMs: this.maxLatencyMs,
      },
    };
  }

  getHealth(nowUtc?: string): BrokerHealth {
    const nowIso = nowUtc ?? new Date().toISOString();
    let status: BrokerHealthStatus = "healthy";
    if (this.consecutiveFailures >= this.maxFailuresBeforeUnhealthy || !this.isConnected) {
      status = "unhealthy";
    } else if (this.consecutiveFailures > 0 || this.lastLatencyMs > this.maxLatencyMs) {
      status = "degraded";
    }

    return {
      adapterName: this.adapterName,
      brokerId: this.brokerId,
      status,
      connected: this.isConnected,
      latencyMs: this.lastLatencyMs,
      lastHeartbeatUtc: this.lastHeartbeatUtc,
      message: this.isConnected ? "Operational" : "Disconnected",
      details: {
        consecutiveFailures: this.consecutiveFailures,
        maxLatencyMs: this.maxLatencyMs,
      },
    };
  }
}


