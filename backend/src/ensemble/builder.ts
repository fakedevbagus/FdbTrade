/**
 * Ensemble decision builder (P06-01).
 *
 * Single construction path for canonical ensemble decisions: fills the
 * deterministic `decisionId`, computes the sha256 `decisionHash` over the
 * canonical serialization and validates the result against the strict
 * contract. Engines never hand-build raw records — they go through this
 * builder so every emitted decision is contract-valid by construction
 * (fail closed), mirroring the signal builder (P05-01).
 */
import { createHash } from "node:crypto";

import {
  type EnsembleDecision,
  type EnsembleDecisionContent,
  ensembleDecisionIdFor,
  ensembleDecisionSchema,
  serializeEnsembleDecisionCanonical,
  utcInstantSchema,
} from "@fdbtrade/contracts";

/** Deterministic decision hash = sha256 of the canonical serialization. */
export function ensembleDecisionHash(content: EnsembleDecisionContent): string {
  return createHash("sha256")
    .update(serializeEnsembleDecisionCanonical(content), "utf8")
    .digest("hex");
}

/** Draft without the derived fields (decisionId + decisionHash). */
export type EnsembleDecisionDraft = Omit<EnsembleDecisionContent, "decisionId" | "decisionHash"> & {
  decisionId?: string;
  decisionHash?: string;
};

/**
 * Build a canonical ensemble decision: derive `decisionId`, hash the content,
 * validate against `ensembleDecisionSchema`. Throws a structured error
 * message on any contract violation — never returns an invalid decision.
 */
export function buildEnsembleDecision(draft: EnsembleDecisionDraft): EnsembleDecision {
  const content: EnsembleDecisionContent = {
    ...draft,
    decisionId: ensembleDecisionIdFor(draft),
  };
  utcInstantSchema.parse(content.eventTimeUtc);
  return ensembleDecisionSchema.parse({
    ...content,
    decisionHash: ensembleDecisionHash(content),
  });
}
