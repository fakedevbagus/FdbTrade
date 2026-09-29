import { describe, expect, it, vi } from "vitest";
import type { AuthResult } from "@/auth/store";
const TOKEN = "r19-session";
const AUTH: AuthResult = { session: { id: "s", userId: "u", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, user: { id: "u", username: "owner", isActive: true, mfaEnabled: false } };
vi.mock("@/auth/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/auth/store")>()), getSessionByToken: vi.fn(async (token: string) => token === TOKEN ? AUTH : null) }));
import { GET, POST } from "@/app/api/signals/[id]/route";
const req=(auth=true)=>new Request("http://localhost:3100/api/signals/ens_EURUSD_5m_x",{headers:auth?{cookie:`fdb_session=${TOKEN}`}:{}});const ctx={params:Promise.resolve({id:"ens_EURUSD_5m_x"})};
describe("retired detail",()=>{it("returns 410 even for old 5m/1d-shaped ids",async()=>{const r=await GET(req(),ctx);expect(r.status).toBe(410);const b=await r.json();expect(b.error.code).toBe("LEGACY_SURFACE_RETIRED");expect(b.error.details.legacyResultsAvailable).toBe(false);});it("requires authentication",async()=>expect((await GET(req(false),ctx)).status).toBe(401));it("closes writes",async()=>expect((await POST(req())).status).toBe(405));});
