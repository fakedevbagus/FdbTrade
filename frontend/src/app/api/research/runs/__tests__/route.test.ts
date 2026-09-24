import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/research/runs/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("same-origin research run facade", () => {
  it("forwards only the exact POST body and opaque session cookie", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { datasetId: "dataset-1", createdAtUtc: "2026-09-24T02:00:00.000Z" };
    const response = await POST(new Request("http://localhost:3000/api/research/runs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "fdb_session=opaque-session" },
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/research/runs",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", cookie: "fdb_session=opaque-session" },
        body: JSON.stringify(payload),
      }),
    );
  });

  it("rejects query extensions before forwarding and denies GET", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const extended = await POST(new Request("http://localhost:3000/api/research/runs?optimize=true", {
      method: "POST",
      body: "{}",
    }));
    expect(extended.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const read = GET();
    expect(read.status).toBe(405);
    expect(read.headers.get("allow")).toBe("POST");
  });

  it("returns a safe backend-unavailable state without leaking transport details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret transport detail"); }));
    const response = await POST(new Request("http://localhost:3000/api/research/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret transport detail");
  });
});
