import { describe, expect, it } from "vitest";

import { openMigratedDatabase } from "@/db/sqlite.mjs";
import { OperationalAuthority } from "@/operations/operationalAuthority";

describe("OperationalAuthority", () => {
  it("projects empty authoritative state without inventing readiness", () => {
    const database = openMigratedDatabase();
    try {
      const view = new OperationalAuthority(database).overview();
      expect(view.authority).toBe("sqlite");
      expect(view.scope.instruments).toHaveLength(7);
      expect(view.scope.timeframes).toEqual(["15m", "1h", "4h"]);
      expect(view.risk).toEqual({
        initialized: false,
        state: null,
        sequenceNo: null,
        effectiveAtUtc: null,
      });
      expect(view.safety).toMatchObject({
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        credentialedProviderSelected: false,
        modelPromotionAuthority: false,
        uiAuthority: false,
      });
      expect(view.counts.reconciliationFailures).toBe(0);
    } finally {
      database.close();
    }
  });

  it("reads the durable risk latch and refuses operational event mutation", () => {
    const database = openMigratedDatabase();
    try {
      database.prepare(`
        INSERT INTO risk_paper_configs
          (config_id, config_version, config_digest, config_json, registered_at_utc)
        VALUES ('test', '1', ?, '{}', '2026-09-23T00:00:00.000Z')
      `).run("a".repeat(64));
      database.prepare(`
        INSERT INTO risk_state_events
          (event_id, sequence_no, previous_state, state, action, override_id,
           actor, reason, effective_at_utc, created_at_utc)
        VALUES ('risk-1', 1, NULL, 'green', 'initialized', NULL, 'system', 'test',
                '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')
      `).run();
      database.prepare(`
        INSERT INTO operational_events
          (event_id, sequence_no, event_type, status, artifact_digest,
           details_json, event_digest, occurred_at_utc, created_at_utc)
        VALUES ('op-1', 1, 'deployment_drill_verified', 'passed', NULL,
                '{}', ?, '2026-09-23T01:00:00.000Z', '2026-09-23T01:00:00.000Z')
      `).run("b".repeat(64));

      const view = new OperationalAuthority(database).overview();
      expect(view.risk.state).toBe("green");
      expect(view.operationalEvents[0]?.eventType).toBe("deployment_drill_verified");
      expect(() => database.prepare("DELETE FROM operational_events").run()).toThrow(
        /append-only/u,
      );
      expect(() => database.prepare("UPDATE operational_events SET status = 'failed'").run()).toThrow(
        /immutable/u,
      );
    } finally {
      database.close();
    }
  });
});
