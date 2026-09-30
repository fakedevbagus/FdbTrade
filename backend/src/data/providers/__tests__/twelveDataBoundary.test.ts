import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TWELVE_DATA_DAY_BUDGET,
  TWELVE_DATA_MAX_ATTEMPTS,
  TWELVE_DATA_MINUTE_BUDGET,
  TWELVE_DATA_ORIGIN,
  TWELVE_DATA_PATH,
  TWELVE_DATA_SECRET_FILE,
  TWELVE_DATA_TIMEOUT_MS,
  TwelveDataBudget,
  assertPublicResolution,
  buildTwelveDataRequest,
  executeTwelveDataRead,
  loadTwelveDataSecret,
  redactBoundaryDetail,
  type AuditEvent,
  type HttpRequest,
  type HttpResponse,
} from "../twelveDataBoundary";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function secretDir(mode = 0o600, body: unknown = { apiKey: "dummy-test-key-123456" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fdbtrade-r115-")); roots.push(root);
  const file = path.join(root, TWELVE_DATA_SECRET_FILE);
  writeFileSync(file, JSON.stringify(body), { mode }); chmodSync(file, mode);
  return root;
}

function ports(script: Array<HttpResponse | Error>, addresses: readonly string[] = ["8.8.8.8"]) {
  const requests: HttpRequest[] = []; const audits: AuditEvent[] = []; const sleeps: number[] = [];
  let now = 0;
  return {
    requests, audits, sleeps,
    value: {
      resolve: async () => addresses,
      send: async (request: HttpRequest) => {
        requests.push(request); const item = script.shift();
        if (item instanceof Error) throw item;
        if (!item) throw new Error("unscripted");
        return item;
      },
      sleep: async (milliseconds: number) => { sleeps.push(milliseconds); now += milliseconds; },
      nowMs: () => now,
      audit: (event: AuditEvent) => audits.push(event),
    },
  };
}

describe("Twelve Data R1.15 credential boundary", () => {
  it("loads only an owner-only regular exact-shape secret", async () => {
    const root = await secretDir();
    const loaded = loadTwelveDataSecret(root);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.apiKey).toBe("dummy-test-key-123456");
      expect(loaded.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    }
    chmodSync(path.join(root, TWELVE_DATA_SECRET_FILE), 0o644);
    expect(loadTwelveDataSecret(root)).toMatchObject({ ok: false, code: "secret_permissions" });
    const linkRoot = await mkdtemp(path.join(os.tmpdir(), "fdbtrade-r115-link-")); roots.push(linkRoot);
    symlinkSync(path.join(root, TWELVE_DATA_SECRET_FILE), path.join(linkRoot, TWELVE_DATA_SECRET_FILE));
    expect(loadTwelveDataSecret(linkRoot)).toMatchObject({ ok: false, code: "secret_symlink" });
    const extra = await secretDir(0o600, { apiKey: "dummy-test-key-123456", other: true });
    expect(loadTwelveDataSecret(extra)).toMatchObject({ ok: false, code: "secret_invalid" });
  });

  it("builds only exact GET HTTPS time_series requests without query secrets", () => {
    const request = buildTwelveDataRequest({ pair: "EUR/USD", interval: "15min", outputsize: 5000 }, "dummy-key");
    const url = new URL(request.url);
    expect(url.origin).toBe(TWELVE_DATA_ORIGIN);
    expect(url.pathname).toBe(TWELVE_DATA_PATH);
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.timeoutMs).toBe(TWELVE_DATA_TIMEOUT_MS);
    expect([...url.searchParams.keys()].sort()).toEqual(["format", "interval", "outputsize", "symbol", "timezone"]);
    expect(url.search).not.toContain("dummy-key");
    expect(request.headers.Authorization).toBe("apikey dummy-key");
    expect(() => buildTwelveDataRequest({ pair: "EUR/USD", interval: "15min", outputsize: 5001 }, "x")).toThrow("request_denied");
  });

  it("rejects private, loopback, link-local, multicast and empty DNS results", () => {
    for (const addresses of [[], ["127.0.0.1"], ["10.0.0.1"], ["172.16.0.1"], ["192.168.1.1"], ["169.254.1.1"], ["224.0.0.1"], ["::1"], ["fd00::1"], ["fe80::1"]]) {
      expect(() => assertPublicResolution(addresses)).toThrow("dns_denied");
    }
    expect(() => assertPublicResolution(["8.8.8.8", "2606:4700:4700::1111"])).not.toThrow();
  });

  it("uses hermetic transport, bounded retry/budgets and metadata-only audit", async () => {
    const root = await secretDir();
    const fake = ports([{ status: 500, bodyText: "retry" }, { status: 200, bodyText: "{\"ok\":true}" }]);
    const result = await executeTwelveDataRead({
      configDir: root, query: { pair: "USD/JPY", interval: "4h", outputsize: 100 },
      ports: fake.value, budget: new TwelveDataBudget(0),
    });
    expect(result).toMatchObject({ ok: true, attempts: TWELVE_DATA_MAX_ATTEMPTS });
    expect(fake.requests).toHaveLength(2);
    expect(fake.sleeps).toEqual([250]);
    expect(fake.audits).toHaveLength(1);
    expect(JSON.stringify(fake.audits)).not.toContain("dummy-test-key");
    expect(fake.audits[0]).toMatchObject({ outcome: "passed", path: TWELVE_DATA_PATH });
    expect(TWELVE_DATA_MINUTE_BUDGET).toBe(8);
    expect(TWELVE_DATA_DAY_BUDGET).toBe(800);
  });

  it("fails closed on DNS denial, exhaustion and redacts auditable errors", async () => {
    const root = await secretDir();
    const denied = ports([], ["127.0.0.1"]);
    expect(await executeTwelveDataRead({
      configDir: root, query: { pair: "AUD/USD", interval: "1h", outputsize: 30 },
      ports: denied.value, budget: new TwelveDataBudget(0),
    })).toMatchObject({ ok: false, code: "dns_denied", attempts: 0 });
    expect(redactBoundaryDetail("authorization=super-secret-token-value-123456789")).not.toContain("super-secret");
    const budget = new TwelveDataBudget(0);
    for (let index = 0; index < TWELVE_DATA_MINUTE_BUDGET; index += 1) expect(budget.take(0)).toBe(true);
    expect(budget.take(0)).toBe(false);
  });
});