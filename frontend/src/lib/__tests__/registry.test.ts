/**
 * Registry API-client tests (P13-03).
 *
 * Covers the frontend boundary: valid registry parses, malformed entries
 * reject (fail closed), non-200/unreachable backend returns `{ ok: false }`
 * without throwing, and state/kind vocabularies are enforced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { registryViewSchema, fetchRegistry } from "@/lib/registry";

const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const validEntry = {
  entryId: "reg_0123456789abcdef",
  kind: "strategy",
  artifactId: "trend-pullback@1.2.0",
  configHash: SHA64,
  dataset: { datasetId: "ds-1", digest: SHA64 },
  modelMetadata: null,
  state: "candidate",
  researchRunIds: ["run-1"],
  limitations: "Trend-following only; no range edge.",
  registeredAtUtc: "2026-09-11T12:00:00.000Z",
  registeredBy: "owner",
};

const validRegistry = {
  count: 1,
  champions: [],
  entries: [validEntry],
};

describe("registryViewSchema", () => {
  it("valid input / expected output: parses a well-formed registry", () => {
    const parsed = registryViewSchema.safeParse(validRegistry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries[0].artifactId).toBe("trend-pullback@1.2.0");
      expect(parsed.data.count).toBe(1);
    }
  });

  it("malformed entries are rejected (fail closed)", () => {
    expect(
      registryViewSchema.safeParse({
        ...validRegistry,
        entries: [{ ...validEntry, state: "championed" }],
      }).success,
    ).toBe(false);
    expect(
      registryViewSchema.safeParse({
        ...validRegistry,
        entries: [{ ...validEntry, configHash: "abc" }],
      }).success,
    ).toBe(false);
    expect(
      registryViewSchema.safeParse({
        ...validRegistry,
        entries: [{ ...validEntry, modelMetadata: { family: "x" } }],
      }).success,
    ).toBe(false);
    expect(
      registryViewSchema.safeParse({ ...validRegistry, entries: [{ ...validEntry, entryId: "x" }] })
        .success,
    ).toBe(false);
  });

  it("champion entries parse and are listed in champions", () => {
    const parsed = registryViewSchema.safeParse({
      count: 1,
      champions: ["trend-pullback@1.4.0"],
      entries: [{ ...validEntry, state: "champion" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("fetchRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-200 backend returns ok:false with a safe message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const result = await fetchRegistry();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
    }
  });

  it("malformed body returns ok:false (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, data: { bogus: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await fetchRegistry();
    expect(result.ok).toBe(false);
  });

  it("unreachable backend returns ok:false without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const result = await fetchRegistry();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Backend unreachable.");
    }
  });
});
