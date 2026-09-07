/**
 * Typed site configuration for the FdbTrade web shell (P01-01).
 *
 * This is the shell's only boundary contract: the raw configuration object is
 * parsed with zod (not merely typed) so a malformed configuration fails fast
 * at import time instead of silently rendering a broken UI.
 *
 * SECURITY: nothing in this module may ever contain a secret — it is bundled
 * into the browser. No environment variables are read here.
 */
import { z } from "zod";

export const navItemSchema = z.object({
  label: z.string().min(1),
  href: z
    .string()
    .regex(/^\//u, "nav href must be an internal path starting with '/'"),
});

export const siteConfigSchema = z.object({
  name: z.literal("FdbTrade"),
  tagline: z.string().min(1),
  environment: z.enum(["development", "test", "production"]),
  /**
   * Trading-safety invariant (Blueprint v2 "Live execution is OFF by default",
   * ADR-0005): the web shell can only ever render live execution as OFF.
   * This is a presentation-level invariant, not an execution control.
   */
  liveExecutionEnabled: z.literal(false),
  nav: z.array(navItemSchema).min(1),
});

export type NavItem = z.infer<typeof navItemSchema>;
export type SiteConfig = z.infer<typeof siteConfigSchema>;

const rawSiteConfig = {
  name: "FdbTrade",
  tagline: "Private Trading Intelligence OS",
  environment: "development",
  liveExecutionEnabled: false,
  nav: [
    { label: "Overview", href: "/" },
    { label: "Command Center", href: "/dashboard" },
  ],
} as const;

export const siteConfig: SiteConfig = siteConfigSchema.parse(rawSiteConfig);

/** Presentation-only label derived from the safety invariant; always "OFF". */
export const executionStatusLabel: "OFF" | "ON" = siteConfig.liveExecutionEnabled
  ? "ON"
  : "OFF";
