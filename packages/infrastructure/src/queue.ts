import { DelayedError, Worker, type Job, type Queue } from "bullmq";
import IORedis from "ioredis";
import type { WorkflowJob } from "@koolezt/domain";
import type { PostgresOutboxStore } from "./postgres.js";

export const WORKFLOW_QUEUE_NAME = "koolezt-workflow";

export type WorkflowQueuePayload = Readonly<{ workflowJobId: string }>;

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export class OutboxDispatcher {
  constructor(
    private readonly outbox: PostgresOutboxStore,
    private readonly queue: Queue<WorkflowQueuePayload>
  ) {}

  async dispatchAvailable(limit = 50): Promise<number> {
    const rows = await this.outbox.claimUndispatched(limit);
    for (const row of rows) {
      try {
        await this.queue.add("workflow.execute", row.payload, {
          // BullMQ rejects colons in custom job IDs. The durable workflow-job
          // UUID is already unique and remains the queue-level idempotency key;
          // the outbox dedupe key remains authoritative in PostgreSQL.
          jobId: row.workflowJobId,
          removeOnComplete: false,
          removeOnFail: false,
          attempts: 60,
          backoff: { type: "exponential", delay: 1_000 }
        });
        await this.outbox.markDispatched(row.id);
      } catch (error) {
        await this.outbox.markDispatchFailure(
          row.id,
          error instanceof Error ? error.message : "Unknown queue dispatch error."
        );
      }
    }
    return rows.length;
  }

  async recover(): Promise<number> {
    const restored = await this.outbox.requeuePendingJobs();
    await this.dispatchAvailable();
    return restored;
  }
}

export function createWorkflowWorker(
  connection: IORedis,
  service: Readonly<{ processJob(jobId: string): Promise<WorkflowJob> }>,
  concurrency = 2
): Worker<WorkflowQueuePayload> {
  return new Worker<WorkflowQueuePayload>(
    WORKFLOW_QUEUE_NAME,
    async (job: Job<WorkflowQueuePayload>) => {
      const result = await service.processJob(job.data.workflowJobId);
      // The database remains the source of truth. Throwing merely asks BullMQ for
      // another at-least-once delivery while the provider has not completed.
      if (result.status === "PENDING") {
        if (result.nextAttemptAt) {
          await job.moveToDelayed(Date.parse(result.nextAttemptAt), job.token);
          throw new DelayedError();
        }
        throw new Error(`Workflow operation ${result.id} is still processing.`);
      }
    },
    { connection, concurrency: Math.max(1, Math.floor(concurrency)) }
  );
}
