/** Next.js node-runtime hook for the optional local scheduler. */
import { apiEnv } from "@/env";

export async function register(): Promise<void> {
  // NEXT_RUNTIME is a framework compile-time selector, not application
  // configuration. This literal lets Next exclude SQLite from Edge builds.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRuntimeScheduler } = await import("@/runtime/startup");
  startRuntimeScheduler({
    FDB_RUNTIME_SCHEDULER: apiEnv.FDB_RUNTIME_SCHEDULER,
    FDB_RUNTIME_INTERVAL_MS: apiEnv.FDB_RUNTIME_INTERVAL_MS,
    FDB_RUNTIME_DATABASE_ID: apiEnv.FDB_RUNTIME_DATABASE_ID,
  });
}
