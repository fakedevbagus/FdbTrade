import { describe, expect, it } from "vitest";

import {
  executionStatusLabel,
  navItemSchema,
  siteConfig,
  siteConfigSchema,
} from "@/lib/site-config";

const VALID_CONFIG = {
  name: "FdbTrade",
  tagline: "Private Trading Intelligence OS",
  environment: "development",
  liveExecutionEnabled: false,
  nav: [{ label: "Overview", href: "/" }],
} as const;

describe("siteConfig (happy path)", () => {
  it("parses the shipped configuration", () => {
    expect(siteConfig.name).toBe("FdbTrade");
    expect(siteConfig.tagline).toBe("Private Trading Intelligence OS");
    expect(siteConfig.environment).toBe("development");
    expect(siteConfig.nav.length).toBeGreaterThan(0);
  });

  it("keeps the live-execution safety invariant", () => {
    expect(siteConfig.liveExecutionEnabled).toBe(false);
    expect(executionStatusLabel).toBe("OFF");
  });
});

describe("siteConfigSchema (malformed / missing input)", () => {
  it("rejects a nav href that is not an internal path", () => {
    const malformed = {
      ...VALID_CONFIG,
      nav: [{ label: "External", href: "https://example.com" }],
    };
    expect(() => siteConfigSchema.parse(malformed)).toThrow(/internal path/);
  });

  it("rejects a missing required field", () => {
    const incomplete = { ...VALID_CONFIG } as Record<string, unknown>;
    delete incomplete.tagline;
    expect(() => siteConfigSchema.parse(incomplete)).toThrow();
  });

  it("rejects an empty nav array (boundary)", () => {
    expect(() => siteConfigSchema.parse({ ...VALID_CONFIG, nav: [] })).toThrow();
  });

  it("rejects an unknown environment value (boundary)", () => {
    expect(() =>
      siteConfigSchema.parse({ ...VALID_CONFIG, environment: "staging" }),
    ).toThrow();
  });

  it("rejects enabling live execution at the schema level (safety invariant)", () => {
    expect(() =>
      siteConfigSchema.parse({ ...VALID_CONFIG, liveExecutionEnabled: true }),
    ).toThrow();
  });
});

describe("navItemSchema (malformed / boundary input)", () => {
  it("rejects an empty label", () => {
    expect(() => navItemSchema.parse({ label: "", href: "/x" })).toThrow();
  });

  it("rejects a non-internal href", () => {
    expect(() => navItemSchema.parse({ label: "X", href: "javascript:alert(1)" })).toThrow();
  });

  it("accepts a valid internal item", () => {
    expect(navItemSchema.parse({ label: "Overview", href: "/" })).toEqual({
      label: "Overview",
      href: "/",
    });
  });
});
