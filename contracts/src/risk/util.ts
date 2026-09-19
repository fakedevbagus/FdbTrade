/**
 * Risk engine utility primitives (P11, ADR-0022).
 *
 * Deterministic hashing (FNV-1a 64-bit over UTF-16 code units — the same
 * convention as the paper-broker hashing) and the 6-decimal storage
 * convention. Duplicated locally (NOT imported from `paper/`) so the risk
 * layer stays fully independent of any broker module (ADR-0003): risk is
 * upstream of execution and must never depend on it.
 */

/** FNV-1a 64-bit → 16 lowercase hex chars. Byte-identical TS/Python. */
export function riskHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** JS `Number(x.toFixed(6))` — same 6-decimal storage convention as P08/P10. */
export function riskRound6(value: number): number {
  return Number(value.toFixed(6));
}
