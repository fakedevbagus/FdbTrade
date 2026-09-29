import { describe, expect, it, vi } from "vitest";
import type { AuthResult } from "@/auth/store";
const TOKEN = "r19-session";
const AUTH: AuthResult = { session: { id: "s", userId: "u", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, user: { id: "u", username: "owner", isActive: true, mfaEnabled: false } };
vi.mock("@/auth/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/auth/store")>()), getSessionByToken: vi.fn(async (token: string) => token === TOKEN ? AUTH : null) }));
import { GET, POST } from "@/app/api/signals/scanner/route";
const req=(auth=true)=>new Request("http://localhost:3100/api/signals/scanner",{headers:auth?{cookie:`fdb_session=${TOKEN}`}:{}});
describe("retired scanner",()=>{it("returns authenticated 410 and replacement",async()=>{const r=await GET(req());expect(r.status).toBe(410);const b=await r.json();expect(b.error.code).toBe("LEGACY_SURFACE_RETIRED");expect(b.error.details.legacyResultsAvailable).toBe(false);expect(JSON.stringify(b)).not.toContain("canonicalParams");});it("requires authentication",async()=>expect((await GET(req(false))).status).toBe(401));it("closes writes",async()=>expect((await POST(req())).status).toBe(405));});
