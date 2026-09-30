/**
 * Production HTTPS port for the R1.15 boundary.
 *
 * Resolution happens first and the connection is pinned to one of those
 * approved addresses. TLS still verifies the exact Twelve Data hostname.
 * Redirects are never followed and response bytes are bounded before parsing.
 */
import { promises as dns } from "node:dns";
import https from "node:https";

import type { HttpRequest, HttpResponse } from "./twelveDataBoundary";

export const TWELVE_DATA_HTTPS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const TWELVE_DATA_HTTPS_ORIGIN = "https://api.twelvedata.com";
export const TWELVE_DATA_HTTPS_PATH = "/time_series";

export function createPinnedTwelveDataTransport(): {
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly send: (request: HttpRequest) => Promise<HttpResponse>;
} {
  let pinned: readonly string[] = Object.freeze([]);
  return {
    async resolve(hostname) {
      if (hostname !== new URL(TWELVE_DATA_HTTPS_ORIGIN).hostname) {
        throw new Error("unexpected provider hostname");
      }
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => []),
        dns.resolve6(hostname).catch(() => []),
      ]);
      pinned = Object.freeze([...v4, ...v6]);
      return pinned;
    },
    async send(request) {
      if (pinned.length === 0) throw new Error("DNS resolution was not pinned");
      const url = new URL(request.url);
      if (request.method !== "GET" || url.origin !== TWELVE_DATA_HTTPS_ORIGIN ||
          url.pathname !== TWELVE_DATA_HTTPS_PATH || request.redirect !== "error") {
        throw new Error("request escaped the Twelve Data boundary");
      }
      const address = pinned[0];
      return await new Promise<HttpResponse>((resolve, reject) => {
        const outgoing = https.request({
          protocol: "https:",
          hostname: address,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          servername: url.hostname,
          rejectUnauthorized: true,
          headers: { ...request.headers, Host: url.hostname },
          timeout: request.timeoutMs,
        }, (response) => {
          response.setEncoding("utf8");
          let bodyText = "";
          response.on("data", (chunk: string) => {
            bodyText += chunk;
            if (Buffer.byteLength(bodyText, "utf8") > TWELVE_DATA_HTTPS_MAX_RESPONSE_BYTES) {
              outgoing.destroy(new Error("response too large"));
            }
          });
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            bodyText,
          }));
        });
        outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
        outgoing.on("error", reject);
        outgoing.end();
      });
    },
  };
}