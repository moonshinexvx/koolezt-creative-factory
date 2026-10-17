import { OutboxDispatcher, PostgresOutboxStore, createRedisConnection, createWorkflowWorker } from "@koolezt/infrastructure";
import { Queue } from "bullmq";
import { createRuntime } from "../../api/src/runtime.js";

const runtime = createRuntime();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required.");
const connection = createRedisConnection(redisUrl);
const queue = new Queue("koolezt-workflow", { connection });
const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(runtime.pool), queue);
await dispatcher.recover();
const dispatchTimer = setInterval(() => void dispatcher.dispatchAvailable().catch(console.error), 1_000);
dispatchTimer.unref();
// This is deliberately a shared conservative cap: a project can mix providers per scene.
const workflowProcessor = { processJob: async (jobId: string) => {
  const job = await runtime.repository.getJob(jobId);
  return job.type === "ANALYZE_CREATIVE_DNA" ? runtime.creativeDnaService.processJob(jobId) : job.type === "GENERATE_STRATEGY" || job.type === "REPLACE_STRATEGY"
    ? runtime.strategyService.processJob(jobId)
    : runtime.service.processJob(jobId);
} };
const worker = createWorkflowWorker(connection, workflowProcessor, Number(process.env.VIDEO_WORKER_CONCURRENCY ?? process.env.KLING_MAX_CONCURRENCY ?? process.env.SEEDANCE_MAX_CONCURRENCY ?? "2"));
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
worker.on("failed", (job, error) => console.error("workflow job failed", job?.id, error));
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(dispatchTimer);
  clearInterval(cleanupTimer);
  await worker.close();
  await queue.close();
  await connection.quit();
  await runtime.pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
