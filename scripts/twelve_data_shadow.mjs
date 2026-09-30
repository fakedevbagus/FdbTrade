#!/usr/bin/env node
/**
 * Explicit operator entrypoint for the R1.16 Twelve Data read-only shadow.
 *
 * It reads one canonical candle artifact, makes one bounded credentialed
 * request through the R1.15 boundary, prints a comparison report, and exits.
 * It does not write SQLite, publish an artifact, schedule work, or call any
 * signal, research, paper, broker, demo, or live surface.
 */
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const FLAGS = new Set([
  "--config-dir", "--authority-artifact", "--pair", "--interval",
  "--outputsize", "--pip-size", "--observed-at",
]);

function usage() {
  console.error(
    "usage: node --experimental-strip-types scripts/twelve_data_shadow.mjs " +
    "--config-dir ABS --authority-artifact FILE --pair EUR/USD " +
    "--interval 1h --outputsize 100 --pip-size 0.0001 " +
    "--observed-at 2026-09-30T12:30:00.000Z",
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || value === undefined || value.startsWith("--")) {
      usage();
      process.exit(64);
    }
    parsed[flag.slice(2)] = value;
  }
  if ([...FLAGS].some((flag) => parsed[flag.slice(2)] === undefined)) {
    usage();
    process.exit(64);
  }
  return parsed;
}

function boundedHttpsSender() {
  let pinned = [];
  return {
    async resolve(hostname) {
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => []),
        dns.resolve6(hostname).catch(() => []),
      ]);
      pinned = [...v4, ...v6];
      return pinned;
    },
    async send(request) {
      if (pinned.length === 0) throw new Error("DNS resolution was not pinned");
      const url = new URL(request.url);
      const address = pinned[0];
      return await new Promise((resolve, reject) => {
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
          response.on("data", (chunk) => {
            bodyText += chunk;
            if (Buffer.byteLength(bodyText, "utf8") > 2 * 1024 * 1024) {
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

const args = parseArgs(process.argv.slice(2));
if (!path.isAbsolute(args["config-dir"]) || !path.isAbsolute(args["authority-artifact"])) {
  console.error("config and artifact paths must be absolute");
  process.exit(64);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boundary = await import(pathToFileURL(
  path.join(root, "backend/src/data/providers/twelveDataBoundary.ts"),
));
const shadow = await import(pathToFileURL(
  path.join(root, "backend/src/data/providers/twelveDataShadow.ts"),
));
const artifact = await readFile(args["authority-artifact"], "utf8");
const network = boundedHttpsSender();
const audits = [];
const ports = {
  resolve: network.resolve,
  send: network.send,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowMs: () => Date.now(),
  audit: (event) => audits.push(event),
};
const result = await shadow.runTwelveDataShadow({
  configDir: args["config-dir"],
  query: {
    pair: args.pair,
    interval: args.interval,
    outputsize: Number(args.outputsize),
  },
  observedAtUtc: args["observed-at"],
  referenceArtifactText: artifact,
  pipSize: Number(args["pip-size"]),
  ports,
  budget: new boundary.TwelveDataBudget(Date.now()),
  executeRead: boundary.executeTwelveDataRead,
});
console.log(JSON.stringify({ command: "twelve-data-shadow", audits, result }, null, 2));
process.exit(result.status === "compared" ? 0 : 2);