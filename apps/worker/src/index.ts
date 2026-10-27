import { createRuntime } from "../../api/src/runtime.js";

const runtime = createRuntime();

// One job at a time: winner analysis, plan writing, and video rendering share this single loop,
// so rendering never runs in parallel with itself on the shared server.
let jobLoopRunning = false;
const runJobs = async () => {
  if (jobLoopRunning) return;
  jobLoopRunning = true;
  try {
    while (await runtime.winnerJobRunner.runOnce()) { /* keep draining due jobs */ }
  } catch (error) {
    console.error("winner job loop failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  } finally {
    jobLoopRunning = false;
  }
};
const jobTimer = setInterval(() => void runJobs(), Number(process.env.WINNER_JOB_POLL_MS ?? "3000"));

let cleanupRunning = false;
const cleanupMedia = async () => {
  if (!runtime.runMediaCleanup || cleanupRunning) return;
  cleanupRunning = true;
  try {
    const count = await runtime.runMediaCleanup();
    if (count > 0) console.info("durable media cleanup completed", { count });
  } catch (error) {
    console.error("durable media cleanup failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  } finally {
    cleanupRunning = false;
  }
};
await cleanupMedia();
const cleanupTimer = setInterval(() => void cleanupMedia(), Number(process.env.MEDIA_CLEANUP_INTERVAL_MS ?? "3600000"));
cleanupTimer.unref();

// Imported Meta winners get their lifetime results refreshed daily; read-only, no paid AI calls.
const refreshMetaWinners = async () => {
  if (!runtime.metaWinners) return;
  try {
    const result = await runtime.metaWinners.refreshAll();
    if (result.refreshed || result.failed) console.info("meta winner refresh completed", result);
  } catch (error) {
    console.error("meta winner refresh failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  }
};
const metaFirstRun = setTimeout(() => void refreshMetaWinners(), 10 * 60_000);
metaFirstRun.unref();
const metaTimer = setInterval(() => void refreshMetaWinners(), Number(process.env.META_REFRESH_INTERVAL_MS ?? "86400000"));
metaTimer.unref();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(jobTimer);
  clearInterval(cleanupTimer);
  clearTimeout(metaFirstRun);
  clearInterval(metaTimer);
  // Let a running job finish its current step before closing the database pool.
  while (jobLoopRunning) await new Promise((resolve) => setTimeout(resolve, 250));
  await runtime.pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
