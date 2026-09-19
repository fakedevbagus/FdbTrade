/**
 * Server-side registry API client for the admin web shell (P13-03).
 *
 * Zod-validated boundary over `GET /api/admin/registry`. Fail closed on
 * non-200, unreachable backend or malformed body. The registry surface is
 * read-only: no client-side registration or promotion exists (promotion
 * requires P09 evidence gates; the UI never owns that action).
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const sha64 = z.string().regex(/^[0-9a-f]{64}$/);
const utcInstant = z.string();

const modelMetadataViewSchema = z
  .object({
    family: z.string(),
    featureSet: z.array(z.string()),
    trainDatasetId: z.string(),
    trainDatasetDigest: sha64,
    hyperparams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

export const registryEntryViewSchema = z
  .object({
    entryId: z.string().regex(/^reg_[0-9a-f]{16}$/),
    kind: z.enum(["strategy", "model"]),
    artifactId: z.string(),
    configHash: sha64,
    dataset: z.object({ datasetId: z.string(), digest: sha64 }).strict(),
    modelMetadata: modelMetadataViewSchema.nullable(),
    state: z.enum(["candidate", "challenger", "champion", "retired", "rejected"]),
    researchRunIds: z.array(z.string()),
    limitations: z.string(),
    registeredAtUtc: utcInstant,
    registeredBy: z.string(),
  })
  .strict();

export const registryViewSchema = z
  .object({
    count: z.number().int().min(0),
    champions: z.array(z.string()),
    entries: z.array(registryEntryViewSchema),
  })
  .strict();

export type RegistryEntryView = z.infer<typeof registryEntryViewSchema>;
export type RegistryView = z.infer<typeof registryViewSchema>;

export type RegistryResult =
  | { ok: true; data: RegistryView }
  | { ok: false; error: string };

/** Fetch the admin registry (fail closed; no client write path). */
export async function fetchRegistry(cookie?: string): Promise<RegistryResult> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/admin/registry`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = registryViewSchema.safeParse(body?.data);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Registry response failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
