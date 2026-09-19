/**
 * Quote and Account Synchronization Engine (P15-03).
 *
 * Coordinates periodic polling of a BrokerReadOnlyAdapter:
 * - Freshness tracking for account and per-symbol quotes with configurable staleness thresholds.
 * - Deduplication of historical deals and open positions.
 * - Explicit visibility of stale states (isStale, staleSymbols, staleness latency).
 * - Idempotent repeated execution producing deterministic snapshot digests.
 * - Fail-safe degradation: network failures preserve last-known-good snapshot flagged as stale.
 *
 * HARD BOUNDARY:
 * - No order submission, no trading operations.
 * - All timestamps UTC (ADR-0004).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import {
  type BrokerAccount,
  brokerAccountSchema,
  type BrokerOrderRead,
  brokerOrderReadSchema,
  type BrokerPosition,
  brokerPositionSchema,
  type BrokerQuote,
  brokerQuoteSchema,
  type BrokerReadOnlyAdapter,
  type BrokerTrade,
  brokerTradeSchema,
} from "./contract";

export const BROKER_SYNC_ID = "broker-sync";
export const BROKER_SYNC_VERSION = "1.0.0";

/** FNV-1a 64-bit hash returning a 16-character hex string for deterministic ids. */
export function brokerHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export const quoteFreshnessRecordSchema = z
  .object({
    ageMs: z.number().finite().min(0),
    isStale: z.boolean(),
    lastQuoteAtUtc: utcInstantSchema,
  })
  .strict();

export type QuoteFreshnessRecord = z.infer<typeof quoteFreshnessRecordSchema>;

export const accountFreshnessRecordSchema = z
  .object({
    ageMs: z.number().finite().min(0),
    isStale: z.boolean(),
    lastUpdatedAtUtc: utcInstantSchema,
  })
  .strict();

export type AccountFreshnessRecord = z.infer<typeof accountFreshnessRecordSchema>;

export const brokerSyncSnapshotSchema = z
  .object({
    syncId: z.string().regex(/^bsync_[0-9a-f]{16}$/),
    brokerId: z.string().min(1),
    syncedAtUtc: utcInstantSchema,
    account: brokerAccountSchema,
    quotes: z.record(z.string(), brokerQuoteSchema),
    positions: z.array(brokerPositionSchema),
    orders: z.array(brokerOrderReadSchema),
    trades: z.array(brokerTradeSchema),
    quoteFreshness: z.record(z.string(), quoteFreshnessRecordSchema),
    accountFreshness: accountFreshnessRecordSchema,
    isStale: z.boolean(),
    staleSymbols: z.array(z.string()),
    lastError: z.string().nullable().default(null),
  })
  .strict();

export type BrokerSyncSnapshot = z.infer<typeof brokerSyncSnapshotSchema>;

export interface BrokerSyncOptions {
  /** Symbols to sync quotes for. */
  symbols: string[];
  /** Maximum acceptable age of quotes in milliseconds before marking stale (default 10,000ms). */
  quoteMaxStalenessMs?: number;
  /** Maximum acceptable age of account data in milliseconds before marking stale (default 60,000ms). */
  accountMaxStalenessMs?: number;
}


export class BrokerSyncEngine {
  private readonly adapter: BrokerReadOnlyAdapter;
  private readonly symbols: string[];
  private readonly quoteMaxStalenessMs: number;
  private readonly accountMaxStalenessMs: number;
  private readonly tradesMap = new Map<string, BrokerTrade>();
  private lastSnapshot: BrokerSyncSnapshot | null = null;

  constructor(adapter: BrokerReadOnlyAdapter, options: BrokerSyncOptions) {
    this.adapter = adapter;
    this.symbols = [...options.symbols];
    this.quoteMaxStalenessMs = options.quoteMaxStalenessMs ?? 10000;
    this.accountMaxStalenessMs = options.accountMaxStalenessMs ?? 60000;
  }

  getLatestSnapshot(): BrokerSyncSnapshot | null {
    return this.lastSnapshot ? { ...this.lastSnapshot } : null;
  }

  reset(): void {
    this.tradesMap.clear();
    this.lastSnapshot = null;
  }

  async sync(atUtc?: string): Promise<BrokerSyncSnapshot> {
    const nowIso = atUtc ?? new Date().toISOString();
    const nowMs = new Date(nowIso).getTime();

    try {
      const [account, quotes, positions, orders, fetchedTrades] = await Promise.all([
        this.adapter.getAccount(),
        this.adapter.getQuotes(this.symbols),
        this.adapter.getPositions(),
        this.adapter.getOrders(),
        this.adapter.getTrades(),
      ]);

      // Deduplicate historical trades
      for (const trade of fetchedTrades) {
        this.tradesMap.set(trade.tradeId, trade);
      }
      const dedupedTrades = Array.from(this.tradesMap.values()).sort((a, b) => {
        const timeDiff = new Date(a.closedAtUtc).getTime() - new Date(b.closedAtUtc).getTime();
        return timeDiff !== 0 ? timeDiff : a.tradeId.localeCompare(b.tradeId);
      });

      // Sort positions and orders deterministically
      const sortedPositions = [...positions].sort((a, b) =>
        a.positionId.localeCompare(b.positionId),
      );
      const sortedOrders = [...orders].sort((a, b) => a.orderId.localeCompare(b.orderId));

      // Calculate quote freshness
      const quoteFreshness: Record<string, QuoteFreshnessRecord> = {};
      const staleSymbols: string[] = [];

      for (const sym of this.symbols) {
        const quote = quotes[sym];
        if (quote) {
          const quoteTimeMs = new Date(quote.atUtc).getTime();
          const ageMs = Math.max(0, nowMs - quoteTimeMs);
          const isStale = ageMs > this.quoteMaxStalenessMs;
          quoteFreshness[sym] = {
            ageMs,
            isStale,
            lastQuoteAtUtc: quote.atUtc,
          };
          if (isStale) {
            staleSymbols.push(sym);
          }
        } else {
          quoteFreshness[sym] = {
            ageMs: 999999999,
            isStale: true,
            lastQuoteAtUtc: "1970-01-01T00:00:00.000Z",
          };
          staleSymbols.push(sym);
        }
      }

      // Calculate account freshness
      const accountUpdatedMs = new Date(account.updatedAtUtc).getTime();
      const accountAgeMs = Math.max(0, nowMs - accountUpdatedMs);
      const isAccountStale = accountAgeMs > this.accountMaxStalenessMs;

      const accountFreshness: AccountFreshnessRecord = {
        ageMs: accountAgeMs,
        isStale: isAccountStale,
        lastUpdatedAtUtc: account.updatedAtUtc,
      };

      const isStale = isAccountStale || staleSymbols.length > 0;

      // Deterministic sync ID
      const content = `${account.accountId}|${account.balance}|${nowIso}|${sortedPositions.length}|${sortedOrders.length}|${staleSymbols.join(",")}`;
      const syncId = `bsync_${brokerHash16(content)}`;

      const snapshot = brokerSyncSnapshotSchema.parse({
        syncId,
        brokerId: this.adapter.brokerId,
        syncedAtUtc: nowIso,
        account,
        quotes,
        positions: sortedPositions,
        orders: sortedOrders,
        trades: dedupedTrades,
        quoteFreshness,
        accountFreshness,
        isStale,
        staleSymbols,
        lastError: null,
      });

      this.lastSnapshot = snapshot;
      return snapshot;
    } catch (err: any) {
      if (this.lastSnapshot) {
        // Degrade fail-safe: keep previous state marked stale with error
        const degradedSnapshot: BrokerSyncSnapshot = {
          ...this.lastSnapshot,
          syncedAtUtc: nowIso,
          isStale: true,
          lastError: err instanceof Error ? err.message : String(err),
        };
        this.lastSnapshot = degradedSnapshot;
        return degradedSnapshot;
      }
      throw err;
    }
  }
}

