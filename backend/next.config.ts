import type { NextConfig } from "next";

/**
 * Next.js configuration for the FdbTrade API foundation (P01-02).
 *
 * `poweredByHeader: false` keeps the `X-Powered-By: Next.js` fingerprint out
 * of every response (minimal public surface for a private trading OS).
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // P02-01: @fdbtrade/contracts is a workspace source package (TS entry, no
  // dist build) — transpile it so the Next compiler consumes the TS files.
  transpilePackages: ["@fdbtrade/contracts"],
};

export default nextConfig;
