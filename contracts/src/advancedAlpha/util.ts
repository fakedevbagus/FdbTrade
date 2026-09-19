/**
 * Advanced-alpha shared utility primitives (P18, ADR-0032).
 *
 * Local deterministic hashing (FNV-1a 64-bit over UTF-16 code units — the
 * same convention as `risk/util.ts` and `obs/logging.ts`) and the 6-decimal
 * storage convention. Duplicated locally on purpose (same rationale as
 * `risk/util.ts`): the advanced-alpha research layer must not depend on the
 * risk or observability modules — layers stay independent per ADR-0003.
 *
 * Pure, deterministic; no clock, no randomness, no broker access
 * (ADR-0003/0005). All timestamps are UTC (ADR-0004).
 */

/** FNV-1a 64-bit → 16 lowercase hex chars. Byte-identical across TS mirrors. */
export function advHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** JS `Number(x.toFixed(6))` — the storage convention shared with P08..P12. */
export function advRound6(value: number): number {
  return Number(value.toFixed(6));
}
