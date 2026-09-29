import { describe, expect, it, vi } from "vitest";
import type { AuthResult } from "@/auth/store";
const TOKEN = "r19-session";
const AUTH: AuthResult = { session: { id: "s", userId: "u", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, user: { id: "u", username: "owner", isActive: true, mfaEnabled: false } };
vi.mock("@/auth/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/auth/store")>()), getSessionByToken: vi.fn(async (token: string) => token === TOKEN ? AUTH : null) }));
import { GET, POST, PUT } from "@/app/api/backtest/runs/route";
const req=(method="GET",auth=true)=>new Request("http://localhost:3100/api/backtest/runs",{method,headers:auth?{cookie:`fdb_session=${TOKEN}`}:{}});
describe("retired backtest",()=>{it.each(["GET","POST"])("%s returns 410",async m=>{const r=m==="GET"?await GET(req()):await POST(req("POST"));expect(r.status).toBe(410);const b=await r.json();expect(b.error.code).toBe("LEGACY_SURFACE_RETIRED");expect(b.error.details.replacement.ui).toBe("/research/workbench");});it("requires authentication",async()=>expect((await GET(req("GET",false))).status).toBe(401));it("closes unsupported methods",async()=>expect((await PUT(req("PUT"))).status).toBe(405));});
