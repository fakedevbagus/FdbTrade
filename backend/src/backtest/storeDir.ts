/**
 * Run-artifact storage directory (P08-05).
 *
 * Server-side scratch area under `<backend>/artifacts/backtest-runs`
 * (gitignored). Resolved from `process.cwd()` once at import; pure
 * filesystem — no network, no secrets ever stored here.
 */
import path from "node:path";

export const RUN_STORE_DIR = path.join(process.cwd(), "artifacts", "backtest-runs");
