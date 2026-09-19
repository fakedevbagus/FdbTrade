/**
 * Backend strategy/model registry service (P13-03).
 *
 * Process-wide registry over the contracts-layer store
 * (`contracts/src/obs/registry.ts`, ADR-0026). Entries are immutable and
 * content-addressed; registration is idempotent. Every successful NEW
 * registration appends a `strategy_version` audit event (P13-02 ledger) so
 * registry history is auditable end-to-end. Wall clock read only at the
 * registration boundary (default registeredAtUtc).
 */
import {
  type Registry,
  type RegistryEntry,
  type RegistryEntryInput,
  registryEntrySchema,
  registerRegistryEntry,
  RegistryError,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";
import { auditService } from "@/obs/auditService";

export type RegistryRegisterInput = Omit<RegistryEntryInput, "registeredAtUtc"> & {
  registeredAtUtc?: string;
};

export class RegistryService {
  private registry: Registry;

  constructor(registryId: string = "strategy-model-registry-api") {
    this.registry = { registryId, entries: [] };
  }

  /**
   * Register one artifact version (idempotent per content). On a NEW entry,
   * a `strategy_version` audit event is appended with the artifact identity
   * and dataset/config provenance. Fail-closed: an invalid entry throws and
   * leaves the registry unchanged.
   */
  register(input: RegistryRegisterInput): RegistryEntry {
    const full: RegistryEntryInput = {
      registeredAtUtc: input.registeredAtUtc ?? utcNowIso(),
      ...input,
    };
    const before = this.registry.entries.length;
    const result = registerRegistryEntry(this.registry, full);
    this.registry = result.registry;
    if (this.registry.entries.length > before) {
      auditService.append({
        actor: full.registeredBy,
        action: "register_version",
        subjectType: "strategy_version",
        subjectId: full.artifactId,
        before: null,
        after: {
          kind: full.kind,
          state: full.state,
          datasetId: full.dataset.datasetId,
        },
        correlationId: `registry-${result.entry.entryId}`,
        source: "research-lab",
      });
    }
    return result.entry;
  }

  /** All entries (read-only snapshot). */
  entries(): readonly RegistryEntry[] {
    return this.registry.entries;
  }

  /** Validate + parse one entry WITHOUT registering (API boundary guard). */
  static validate(entry: unknown): RegistryEntry {
    return registryEntrySchema.parse(entry);
  }

  /** Reset (tests only; never call in request paths). */
  resetForTest(): void {
    this.registry = { registryId: this.registry.registryId, entries: [] };
  }
}

/** Process-wide singleton. */
const globalRegistry = globalThis as unknown as { __fdbRegistry?: RegistryService };
export const registryService: RegistryService =
  globalRegistry.__fdbRegistry ?? (globalRegistry.__fdbRegistry = new RegistryService());

export { RegistryError };
