/**
 * Market-data cache (P02-04).
 *
 * Deterministic cache keys + bounded TTL memory cache with an INJECTABLE
 * clock (determinism: tests and replays control time; no wall-clock reads).
 * The cache is a pure performance layer: a miss never fabricates data, and
 * a hit must be byte-identical to a fresh fetch (P02-02 determinism).
 */
import type { Candle } from "@fdbtrade/contracts";

/** Deterministic cache key for a candle-range fetch. */
export function candleRangeCacheKey(
  providerId: string,
  instrument: string,
  timeframe: string,
  startUtc: string,
  endUtc: string,
): string {
  return `candles|${providerId}|${instrument}|${timeframe}|${startUtc}|${endUtc}`;
}

/** Cache entry: stored value + expiry (epoch ms) + UTC insert instant. */
interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  insertedAtUtc: string;
}

/** Injectable clock so cache behavior is deterministic in tests. */
export interface CacheClock {
  nowMs(): number;
}

/** Default production clock — the ONLY wall-clock read in this module. */
export const systemClock: CacheClock = { nowMs: () => Date.now() };

export class MarketDataCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly clock: CacheClock;
  private readonly maxEntries: number;

  constructor(options: { clock?: CacheClock; maxEntries?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxEntries = options.maxEntries ?? 256;
  }

  /** Entries currently stored (expiry-cleaned; for tests/observability). */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  get<T>(key: string): T | null {
    this.evictExpired();
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    return entry ? entry.value : null;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) {
      throw new Error(`cache ttl must be positive: ${ttlMs}`);
    }
    this.evictExpired();
    // Bound: evict oldest first (LRU-style by insertion order on Map).
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      expiresAtMs: this.clock.nowMs() + ttlMs,
      insertedAtUtc: new Date(this.clock.nowMs()).toISOString(),
    });
  }

  has(key: string): boolean {
    this.evictExpired();
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const now = this.clock.nowMs();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }
}

/** Convenience type for cached candle ranges. */
export type CandleRange = readonly Candle[];
