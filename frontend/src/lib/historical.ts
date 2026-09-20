import { z } from "zod";
import { BFF_API_URL } from "@/lib/dashboard";

const entrySchema = z.object({
  datasetId: z.string(), providerId: z.string(), instrument: z.string(), timeframe: z.string(),
  periodStartUtc: z.string(), periodEndUtc: z.string(), recordCount: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), mode: z.literal("historical"),
  quality: z.object({ accepted: z.number(), quarantined: z.number(), gaps: z.number(), duplicates: z.number(), mode: z.literal("historical") }),
  createdAtUtc: z.string(),
}).strict();
const listSchema = z.object({ mode: z.literal("historical"), datasets: z.array(entrySchema) }).strict();
export type HistoricalDatasetEntry = z.infer<typeof entrySchema>;

export async function fetchHistoricalDatasets(cookie?: string): Promise<{ ok: true; datasets: HistoricalDatasetEntry[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/historical/datasets`, { headers: cookie ? { cookie } : {}, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = listSchema.safeParse(body.data);
    if (response.status !== 200 || body.ok !== true || !parsed.success) return { ok: false, error: "Historical dataset response failed validation." };
    return { ok: true, datasets: parsed.data.datasets };
  } catch { return { ok: false, error: "Historical dataset service unreachable." }; }
}
