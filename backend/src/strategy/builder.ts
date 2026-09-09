/**
 * Signal builder (P05-01).
 *
 * Single construction path for canonical signals: fills the deterministic
 * `signalId`, computes the sha256 `snapshotHash` over the canonical
 * serialization and validates the result against the strict contract.
 * Strategies never hand-build raw records — they go through this builder so
 * every emitted signal is contract-valid by construction (fail closed).
 */
import { createHash } from "node:crypto";

import {
  type Signal,
  type SignalContent,
  serializeSignalCanonical,
  signalIdFor,
  signalSchema,
  utcInstantSchema,
} from "@fdbtrade/contracts";

/** Deterministic snapshot hash = sha256 of the canonical serialization. */
export function signalSnapshotHash(content: SignalContent): string {
  return createHash("sha256").update(serializeSignalCanonical(content), "utf8").digest("hex");
}

/** Draft without the derived fields (signalId + snapshotHash). */
export type SignalDraft = Omit<SignalContent, "signalId" | "snapshotHash"> & {
  signalId?: string;
  snapshotHash?: string;
};

/**
 * Build a canonical signal: derive `signalId`, hash the content, validate
 * against `signalSchema`. Throws a structured error message on any
 * contract violation — never returns an invalid signal.
 */
export function buildSignal(draft: SignalDraft): Signal {
  const content: SignalContent = {
    ...draft,
    signalId: signalIdFor(draft),
  };
  utcInstantSchema.parse(content.eventTimeUtc);
  utcInstantSchema.parse(content.expiresAtUtc);
  return signalSchema.parse({ ...content, snapshotHash: signalSnapshotHash(content) });
}
