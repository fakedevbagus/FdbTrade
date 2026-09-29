import { describe, expect, it, vi } from "vitest";
import type { AuthResult } from "@/auth/store";
const TOKEN = "r19-session";
const AUTH: AuthResult = { session: { id: "s", userId: "u", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, user: { id: "u", username: "owner", isActive: true, mfaEnabled: false } };
vi.mock("@/auth/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/auth/store")>()), getSessionByToken: vi.fn(async (token: string) => token === TOKEN ? AUTH : null) }));
import { POST } from "@/app/api/historical/preview/route";
const base={csvText:"x",instrument:"EURUSD",timeframe:"1h",providerId:"operator",license:{status:"verified",source:"operator",evidenceUrl:null,note:"test"},createdAtUtc:"2026-09-29T00:00:00.000Z"};
const req=(body:unknown,auth=true)=>new Request("http://localhost:3100/api/historical/preview",{method:"POST",headers:{"content-type":"application/json",...(auth?{cookie:`fdb_session=${TOKEN}`}:{})},body:JSON.stringify(body)});
describe("historical scope",()=>{it.each([["XAUUSD","1h"],["EURUSD","5m"],["EURUSD","1d"]])("rejects unsupported %s %s",async(instrument,timeframe)=>{const r=await POST(req({...base,instrument,timeframe}));expect(r.status).toBe(400);});it("requires authentication",async()=>expect((await POST(req({...base,instrument:"XAUUSD"},false))).status).toBe(401));});
