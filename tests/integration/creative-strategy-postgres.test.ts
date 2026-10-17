import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreativeFactoryService, CreativeStrategyService } from "@koolezt/application";
import { DomainError } from "@koolezt/domain";
import type {
  CreativeInputSnapshot,
  CreativeProvider,
  ProviderOperationContext,
  StrategyProviderConceptDraft,
  StrategyRequestedCount
} from "@koolezt/domain";
import {
  createPostgresPool,
  createRedisConnection,
  createWorkflowWorker,
  OutboxDispatcher,
  PostgresCreativeStrategyStore,
  PostgresFactoryRepository,
  PostgresOutboxStore,
  WORKFLOW_QUEUE_NAME
} from "@koolezt/infrastructure";
import {
  FakeExternalMediaDeliveryProvider,
  InlineCompositionOutputIngestor,
  LocalReadyPublisher,
  LocalStorageProvider,
  MetadataMediaInspector
} from "@koolezt/media";
import {
  FakeCompositionProvider,
  FakeCreativeProvider,
  FakeVideoGenerationProvider,
  FakeVoiceProvider
} from "@koolezt/providers";

const baseDatabaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
const baseRedisUrl = process.env.KOOLEZT_TEST_STRATEGY_REDIS_URL ?? process.env.KOOLEZT_TEST_REDIS_URL;
let databaseUrl = process.env.KOOLEZT_TEST_STRATEGY_DATABASE_URL;
let freshDatabaseUrl: string | undefined;
let upgradeDatabaseUrl: string | undefined;
const redisUrl = baseRedisUrl;
const schemaPrefix = `strategy_7c13e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const schemas = { runtime: `${schemaPrefix}_runtime`, fresh: `${schemaPrefix}_fresh`, upgrade: `${schemaPrefix}_upgrade` } as const;
const integration = baseDatabaseUrl && redisUrl
  ? describe.sequential
  : describe.skip;

function withSchema(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}

async function migrateSchema(connectionString: string, through?: string): Promise<void> {
  const pool = createPostgresPool(connectionString);
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const names = (await readdir(new URL("../../db/migrations", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      if (through && name > through) break;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

function draftOf(value: StrategyProviderConceptDraft): StrategyProviderConceptDraft {
  return structuredClone(value);
}

async function fakeStrategyDrafts(base: FakeCreativeProvider, input: Parameters<NonNullable<CreativeProvider["submitStrategyConcepts"]>>[0], context: ProviderOperationContext) {
  const response = await base.submitStrategyConcepts(input, context);
  return { response, concepts: (JSON.parse(response.outputText!) as { concepts: StrategyProviderConceptDraft[] }).concepts };
}

function duplicateFixtureProvider(options: Readonly<{ unresolvedRepair?: boolean }> = {}) {
  const base = new FakeCreativeProvider();
  let calls = 0;
  const provider: CreativeProvider = {
    generateConcept: base.generateConcept.bind(base),
    submitStrategyConcepts: async (input, context) => {
      calls += 1;
      const { response, concepts } = await fakeStrategyDrafts(base, input, context);
      const source = concepts[0]!;
      if (!input.replacementOrdinals) {
        return { ...response, outputText: JSON.stringify({ concepts: concepts.map((item) =>
            item.ordinal >= 11 ? { ...draftOf(source), ordinal: item.ordinal } : item
          ) }) };
      }
      return { ...response, outputText: JSON.stringify({ concepts: options.unresolvedRepair
          ? input.replacementOrdinals.map((ordinal) => ({ ...draftOf(source), ordinal }))
          : concepts }) };
    },
    retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base)
  };
  return { provider, count: () => calls };
}

class FailFirstConceptPersistenceStore extends PostgresCreativeStrategyStore {
  private failed = false;
  override async saveGeneratedConcepts(input: Parameters<PostgresCreativeStrategyStore["saveGeneratedConcepts"]>[0]) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("simulated application persistence failure");
    }
    return super.saveGeneratedConcepts(input);
  }
}

async function harness(
  provider: CreativeProvider = new FakeCreativeProvider(),
  storeFactory: (pool: ReturnType<typeof createPostgresPool>) => PostgresCreativeStrategyStore =
    (pool) => new PostgresCreativeStrategyStore(pool)
) {
  const pool = createPostgresPool(databaseUrl!);
  const repository = new PostgresFactoryRepository(pool);
  const strategies = storeFactory(pool);
  const root = await mkdtemp(join(tmpdir(), "strategy-pg-integration-"));
  const storage = new LocalStorageProvider(join(root, "media"));
  const videoProvider = new FakeVideoGenerationProvider();
  const voiceProvider = new FakeVoiceProvider();
  const compositionProvider = new FakeCompositionProvider();
  const service = new CreativeFactoryService({
    repository,
    strategyRepository: strategies,
    creativeProvider: provider,
    videoProvider,
    voiceProvider,
    compositionProvider,
    externalMediaDelivery: new FakeExternalMediaDeliveryProvider(),
    compositionOutputIngestor: new InlineCompositionOutputIngestor(),
    storage,
    mediaInspector: new MetadataMediaInspector(),
    readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  const strategyService = new CreativeStrategyService({ repository, strategies, creativeProvider: provider });
  return {
    pool,
    repository,
    strategies,
    service,
    strategyService,
    storage,
    videoProvider,
    voiceProvider,
    compositionProvider,
    dispose: async () => {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function createSource(setup: Awaited<ReturnType<typeof harness>>, label: string) {
  return setup.service.createProjectFromBrief({
    requestId: randomUUID(),
    name: `Strategy integration ${label}`,
    creativeTopic: "Create diverse AI-executable Meta advertising concepts",
    productDetails: "A personalized sign using the supplied pet image and address numbers.",
    verifiedClaims: ["Personalized with the supplied pet image", "Displays operator-supplied address numbers"],
    targetDurationSeconds: 15,
    actor: "integration"
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for strategy integration state.");
}

async function processBatch(setup: Awaited<ReturnType<typeof harness>>, requestId = randomUUID(), requestedCount: StrategyRequestedCount = 12) {
  const project = await createSource(setup, requestId.slice(0, 8));
  const batch = await setup.strategyService.createBatch(project.id, requestId, "integration", requestedCount);
  const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
  const result = await setup.strategyService.processJob(job.id);
  return { project, batch: await setup.strategies.getBatch(batch.id), job: result, concepts: await setup.strategies.listConcepts(batch.id) };
}

integration("Milestone 7C.13E PostgreSQL/Redis acceptance", () => {
  beforeAll(async () => {
    const admin = createPostgresPool(baseDatabaseUrl!);
    try {
      for (const schema of Object.values(schemas)) {
        if (!/^strategy_7c13e_[a-f0-9]{12}_(?:runtime|fresh|upgrade)$/.test(schema)) throw new Error("Unsafe integration schema name.");
        await admin.query(`CREATE SCHEMA ${schema}`);
      }
    } finally {
      await admin.end();
    }
    databaseUrl = withSchema(baseDatabaseUrl!, schemas.runtime);
    freshDatabaseUrl = withSchema(baseDatabaseUrl!, schemas.fresh);
    upgradeDatabaseUrl = withSchema(baseDatabaseUrl!, schemas.upgrade);
    await migrateSchema(databaseUrl);
    // This suite fingerprints the 0018 boundary specifically; 0019 is covered
    // independently by the Creative DNA fresh/upgrade integration suite.
    await migrateSchema(freshDatabaseUrl, "0018_canonical_strategy_constraints.sql");
    await migrateSchema(upgradeDatabaseUrl, "0017_strategy_background_execution.sql");
    const upgradePool = createPostgresPool(upgradeDatabaseUrl);
    try {
      const name = "0018_canonical_strategy_constraints.sql";
      await upgradePool.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"));
      await upgradePool.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    } finally {
      await upgradePool.end();
    }
  }, 60_000);

  afterAll(async () => {
    const admin = createPostgresPool(baseDatabaseUrl!);
    try {
      for (const schema of Object.values(schemas)) {
        if (!/^strategy_7c13e_[a-f0-9]{12}_(?:runtime|fresh|upgrade)$/.test(schema)) throw new Error("Unsafe integration schema name.");
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it("produces identical complete 0018 schemas from fresh and upgrade paths", async () => {
    const pools = [createPostgresPool(freshDatabaseUrl!), createPostgresPool(upgradeDatabaseUrl!)];
    try {
      const fingerprints: string[] = [];
      for (const pool of pools) {
        const migrations = await pool.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
        expect(migrations.rows.at(-1)?.name).toBe("0018_canonical_strategy_constraints.sql");
        expect(migrations.rows).toHaveLength(19);
        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'creative_strategy_%' ORDER BY table_name"
        );
        expect(tables.rows.map((row) => row.table_name)).toEqual([
          "creative_strategy_batches",
          "creative_strategy_concept_revisions",
          "creative_strategy_concepts",
          "creative_strategy_handoffs",
          "creative_strategy_provider_operations"
        ]);
        const projectColumns = await pool.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='creative_projects' AND column_name LIKE 'strategy_%' ORDER BY column_name"
        );
        expect(projectColumns.rows.map((row) => row.column_name)).toEqual([
          "strategy_batch_id",
          "strategy_concept_revision_id",
          "strategy_required"
        ]);
        const operationColumns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='creative_strategy_provider_operations' AND column_name IN ('response_id','model','submitted_at','latest_provider_status','latest_poll_at','terminal_at','result_sha256') ORDER BY column_name");
        expect(operationColumns.rows.map((row) => row.column_name)).toEqual(["latest_poll_at","latest_provider_status","model","response_id","result_sha256","submitted_at","terminal_at"]);
        const revisionColumns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='creative_strategy_concept_revisions' AND column_name='creative_visual_execution_notes'");
        expect(revisionColumns.rows).toEqual([{ column_name: "creative_visual_execution_notes" }]);
        const constraints = await pool.query<{ table_name: string; constraint_name: string; definition: string }>(
          `SELECT rel.relname table_name,con.conname constraint_name,pg_get_constraintdef(con.oid) definition
           FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
           WHERE ns.nspname=current_schema() AND rel.relname LIKE 'creative_strategy_%' ORDER BY rel.relname,con.conname`
        );
        expect(constraints.rows.filter((row) => row.definition.startsWith("FOREIGN KEY")).length).toBeGreaterThanOrEqual(10);
        expect(constraints.rows.some((row) => row.definition.includes("ordinal >= 1") && row.definition.includes("ordinal <= 12"))).toBe(true);
        expect(constraints.rows.some((row) => row.definition.includes("requested_count") && row.definition.includes("3") && row.definition.includes("6") && row.definition.includes("12"))).toBe(true);
        expect(constraints.rows.some((row) => row.definition.includes("AI_UGC_STYLE"))).toBe(true);
        const indexes = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname LIKE 'creative_strategy_%' ORDER BY indexname"
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
          "creative_strategy_batches_project_idx",
          "creative_strategy_batches_product_idx",
          "creative_strategy_one_automatic_operation_idx",
          "creative_strategy_provider_response_id_idx",
          "creative_strategy_revisions_batch_idx"
        ]));
        fingerprints.push(JSON.stringify({ tables: tables.rows, columns: projectColumns.rows, operationColumns: operationColumns.rows, constraints: constraints.rows, indexes: indexes.rows }));
      }
      expect(fingerprints[1]).toBe(fingerprints[0]);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it("persists a 12-slot strategy workflow through PostgreSQL, Redis, outbox, and fake providers without secrets or media calls", async () => {
    const base = new FakeCreativeProvider();
    const secret = "integration-provider-secret";
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: async (input, context) => ({ ...(await base.submitStrategyConcepts(input, context)), authorization: `Bearer ${secret}` }),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base)
    };
    const setup = await harness(provider);
    const connection = createRedisConnection(redisUrl!);
    const queue = new Queue(WORKFLOW_QUEUE_NAME, { connection });
    const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(setup.pool), queue);
    let worker: ReturnType<typeof createWorkflowWorker> | undefined;
    try {
      await connection.flushdb();
      const project = await createSource(setup, "redis-outbox");
      const batch = await setup.strategyService.createBatch(project.id, randomUUID(), "integration", 12);
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      const outbox = await setup.pool.query<{ payload: unknown }>("SELECT payload FROM workflow_outbox WHERE workflow_job_id=$1", [job.id]);
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]?.payload).toEqual({ workflowJobId: job.id });
      worker = createWorkflowWorker(connection, setup.strategyService, 2);
      expect(await dispatcher.dispatchAvailable()).toBeGreaterThanOrEqual(1);
      await waitFor(async () => (await setup.repository.getJob(job.id)).status === "COMPLETED");
      const concepts = await setup.strategies.listConcepts(batch.id);
      expect(concepts).toHaveLength(12);
      expect(new Set(concepts.map((item) => item.ordinal)).size).toBe(12);
      expect((await setup.strategies.getBatch(batch.id))).toMatchObject({ status: "REVIEW", providerRequestCount: 1 });
      const operation = await setup.pool.query<{ status: string; result_payload: unknown; provider_metadata: unknown }>(
        "SELECT status,result_payload,provider_metadata FROM creative_strategy_provider_operations WHERE batch_id=$1",
        [batch.id]
      );
      expect(operation.rows).toHaveLength(1);
      expect(operation.rows[0]?.status).toBe("SUCCEEDED");
      expect(operation.rows[0]?.result_payload).toBeTruthy();
      const costs = await setup.pool.query<{ operation_type: string }>("SELECT operation_type FROM usage_costs WHERE project_id=$1", [project.id]);
      expect(costs.rows.map((row) => row.operation_type)).toEqual(["STRATEGY"]);
      const persisted = JSON.stringify({ batch: await setup.strategies.getBatch(batch.id), operation: operation.rows[0], outbox: outbox.rows });
      expect(persisted).not.toContain(secret);
      expect(persisted.toLowerCase()).not.toContain("authorization");
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    } finally {
      await worker?.close();
      await queue.close();
      await connection.quit();
      await setup.dispose();
    }
  });

  it("persists the immutable default and explicit 3/6/12 requested counts in PostgreSQL", async () => {
    const setup = await harness();
    try {
      for (const requestedCount of [3, 6, 12] as const) {
        const result = await processBatch(setup, randomUUID(), requestedCount);
        expect(result.batch.requestedCount).toBe(requestedCount);
        expect(result.batch.inputSnapshot.requestedCount).toBe(requestedCount);
        expect(result.concepts).toHaveLength(requestedCount);
      }
      const project = await createSource(setup, "default-six");
      const batch = await setup.strategyService.createBatch(project.id, randomUUID(), "integration");
      expect(batch.requestedCount).toBe(6);
      const stored = await setup.pool.query<{ requested_count: number }>("SELECT requested_count FROM creative_strategy_batches WHERE id=$1", [batch.id]);
      expect(stored.rows[0]?.requested_count).toBe(6);
    } finally {
      await setup.dispose();
    }
  }, 90_000);

  it("persists the response ID and resumes delayed retrieval after a real worker restart", async () => {
    const base = new FakeCreativeProvider();
    let createCalls = 0;
    let retrieveCalls = 0;
    let completed: Awaited<ReturnType<FakeCreativeProvider["submitStrategyConcepts"]>> | undefined;
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: async (input, context) => {
        createCalls += 1;
        completed = await base.submitStrategyConcepts(input, context);
        return { ...completed, status: "queued", outputText: undefined } as unknown as typeof completed;
      },
      retrieveStrategyConcepts: async (responseId) => {
        retrieveCalls += 1;
        if (!completed || completed.responseId !== responseId) throw new Error("Unexpected response ID.");
        if (retrieveCalls === 1) return { ...completed, status: "in_progress", outputText: undefined } as unknown as typeof completed;
        return completed;
      }
    };
    const setup = await harness(provider);
    const connection = createRedisConnection(redisUrl!);
    const queue = new Queue(WORKFLOW_QUEUE_NAME, { connection });
    const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(setup.pool), queue);
    let worker: ReturnType<typeof createWorkflowWorker> | undefined;
    try {
      await connection.flushdb();
      // Earlier direct-service tests deliberately do not dispatch their
      // isolated outbox rows. Remove those test-only leftovers so this case
      // observes a single durable job across the worker restart.
      await setup.pool.query("DELETE FROM workflow_outbox");
      const project = await createSource(setup, "background-restart");
      const batch = await setup.strategyService.createBatch(project.id, randomUUID(), "integration", 12);
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      worker = createWorkflowWorker(connection, setup.strategyService, 1);
      await dispatcher.dispatchAvailable();
      await waitFor(
        async () => (await setup.pool.query<{ latest_provider_status: string }>("SELECT latest_provider_status FROM creative_strategy_provider_operations WHERE batch_id=$1", [batch.id])).rows[0]?.latest_provider_status === "in_progress",
        60_000
      );
      await worker.close();
      worker = createWorkflowWorker(connection, setup.strategyService, 1);
      // A delayed BullMQ job is intentionally reclaimed after the worker is
      // recreated. Allow for cross-host PostgreSQL/Redis transport latency in
      // the isolated integration environment; this does not alter production
      // polling cadence or retry semantics.
      await waitFor(async () => (await setup.repository.getJob(job.id)).status === "COMPLETED", 60_000);
      const operation = (await setup.pool.query<{ status: string; response_id: string; result_sha256: string }>("SELECT status,response_id,result_sha256 FROM creative_strategy_provider_operations WHERE batch_id=$1", [batch.id])).rows[0];
      expect(operation).toMatchObject({ status: "SUCCEEDED", response_id: expect.any(String), result_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(createCalls).toBe(1);
      expect(retrieveCalls).toBe(2);
      expect((await setup.strategies.getBatch(batch.id))).toMatchObject({ requestedCount: 12, inputSnapshot: expect.objectContaining({ requestedCount: 12 }) });
      expect(await setup.strategies.listConcepts(batch.id)).toHaveLength(12);
    } finally {
      await worker?.close();
      await queue.close();
      await connection.quit();
      await setup.dispose();
    }
  }, 90_000);

  it("deduplicates concurrent generation and grants only one provider execution under duplicate Redis delivery", async () => {
    const base = new FakeCreativeProvider();
    let strategyCalls = 0;
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: async (input, context) => {
        strategyCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return base.submitStrategyConcepts(input, context);
      },
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base)
    };
    const setup = await harness(provider);
    const connection = createRedisConnection(redisUrl!);
    const queue = new Queue(WORKFLOW_QUEUE_NAME, { connection });
    let worker: ReturnType<typeof createWorkflowWorker> | undefined;
    try {
      await connection.flushdb();
      const project = await createSource(setup, "concurrency");
      const requestId = randomUUID();
      const generated = await Promise.all([
        setup.strategyService.createBatch(project.id, requestId, "integration", 12),
        setup.strategyService.createBatch(project.id, requestId, "integration", 12)
      ]);
      expect(generated[1]?.id).toBe(generated[0]?.id);
      const jobs = (await setup.repository.listJobs(project.id)).filter((item) => item.type === "GENERATE_STRATEGY");
      expect(jobs).toHaveLength(1);
      worker = createWorkflowWorker(connection, setup.strategyService, 2);
      await Promise.all([
        queue.add("workflow.execute", { workflowJobId: jobs[0]!.id }, { jobId: `duplicate-a-${randomUUID()}` }),
        queue.add("workflow.execute", { workflowJobId: jobs[0]!.id }, { jobId: `duplicate-b-${randomUUID()}` })
      ]);
      await waitFor(async () => strategyCalls === 1 && (await setup.strategies.listConcepts(generated[0]!.id)).length === 12);
      for (let attempt = 0; attempt < 3 && (await setup.repository.getJob(jobs[0]!.id)).status !== "COMPLETED"; attempt += 1) {
        await setup.strategyService.processJob(jobs[0]!.id);
      }
      expect(strategyCalls).toBe(1);
      expect((await setup.repository.getJob(jobs[0]!.id)).status).toBe("COMPLETED");
      const operations = await setup.pool.query<{ count: string }>("SELECT count(*)::text count FROM creative_strategy_provider_operations WHERE batch_id=$1", [generated[0]!.id]);
      expect(Number(operations.rows[0]?.count)).toBe(1);
      expect((await setup.strategies.getBatch(generated[0]!.id)).providerRequestCount).toBe(1);
    } finally {
      await worker?.close();
      await queue.close();
      await connection.quit();
      await setup.dispose();
    }
  });

  it("repairs only flagged pre-persistence drafts once and preserves valid drafts", async () => {
    const fixture = duplicateFixtureProvider({ unresolvedRepair: true });
    const interrupted = await harness(fixture.provider);
    try {
      const project = await createSource(interrupted, "restart-repair");
      const batch = await interrupted.strategyService.createBatch(project.id, randomUUID(), "integration", 12);
      const job = (await interrupted.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      expect((await interrupted.strategyService.processJob(job.id)).status).toBe("COMPLETED");
      expect(fixture.count()).toBe(2);
      const restartedStore = new PostgresCreativeStrategyStore(interrupted.pool);
      const repaired = await restartedStore.listConcepts(batch.id);
      for (const ordinal of Array.from({ length: 10 }, (_, index) => index + 1)) {
        expect(repaired.find((item) => item.ordinal === ordinal)?.currentRevision).toMatchObject({ revision: 1, conceptName: expect.stringContaining("concept") });
      }
      expect(repaired.find((item) => item.ordinal === 11)?.currentRevision.revision).toBe(1);
      expect(repaired.find((item) => item.ordinal === 12)?.currentRevision.revision).toBe(1);
      expect((await restartedStore.getBatch(batch.id))).toMatchObject({ status: "REVIEW_WITH_ISSUES", providerRequestCount: 2, automaticRepairAttempted: true });
      await interrupted.strategyService.processJob(job.id);
      expect(fixture.count()).toBe(2);
    } finally {
      await interrupted.dispose();
    }
  });

  it("replays a persisted provider result after application persistence failure and never resubmits an ambiguous operation", async () => {
    const base = new FakeCreativeProvider();
    const flaky = await harness(base, (pool) => new FailFirstConceptPersistenceStore(pool));
    try {
      const project = await createSource(flaky, "result-replay");
      const batch = await flaky.strategyService.createBatch(project.id, randomUUID(), "integration", 12);
      const job = (await flaky.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      expect((await flaky.strategyService.processJob(job.id)).status).toBe("PENDING");
      expect(base.calls).toHaveLength(1);
      const operation = await flaky.pool.query<{ status: string; result_payload: unknown }>("SELECT status,result_payload FROM creative_strategy_provider_operations WHERE batch_id=$1", [batch.id]);
      expect(operation.rows[0]).toMatchObject({ status: "SUCCEEDED" });
      expect(operation.rows[0]?.result_payload).toBeTruthy();
      const restartedStore = new PostgresCreativeStrategyStore(flaky.pool);
      const restarted = new CreativeStrategyService({ repository: flaky.repository, strategies: restartedStore, creativeProvider: base });
      expect((await restarted.processJob(job.id)).status).toBe("COMPLETED");
      expect(base.calls).toHaveLength(1);
      expect(await restartedStore.listConcepts(batch.id)).toHaveLength(12);
    } finally {
      await flaky.dispose();
    }

    let unknownCalls = 0;
    const unknownBase = new FakeCreativeProvider();
    const unknownProvider: CreativeProvider = {
      generateConcept: unknownBase.generateConcept.bind(unknownBase),
      submitStrategyConcepts: async () => {
        unknownCalls += 1;
        throw new DomainError("OPENAI_STRATEGY_SUBMISSION_UNKNOWN", "simulated ambiguous submission");
      },
      retrieveStrategyConcepts: unknownBase.retrieveStrategyConcepts.bind(unknownBase)
    };
    const unknown = await harness(unknownProvider);
    try {
      const project = await createSource(unknown, "submission-unknown");
      const batch = await unknown.strategyService.createBatch(project.id, randomUUID(), "integration");
      const job = (await unknown.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      expect((await unknown.strategyService.processJob(job.id)).status).toBe("FAILED");
      expect((await unknown.strategies.getBatch(batch.id)).status).toBe("SUBMISSION_UNKNOWN");
      expect((await unknown.strategyService.processJob(job.id)).status).toBe("FAILED");
      expect(unknownCalls).toBe(1);
      const operations = await unknown.pool.query<{ status: string }>("SELECT status FROM creative_strategy_provider_operations WHERE batch_id=$1", [batch.id]);
      expect(operations.rows[0]?.status).toBe("SUBMISSION_UNKNOWN");
    } finally {
      await unknown.dispose();
    }
  });

  it("makes handoff idempotent, rejects stale/four selections, and preserves the exact authoritative strategy", async () => {
    const base = new FakeCreativeProvider();
    const conceptInputs: CreativeInputSnapshot[] = [];
    const provider: CreativeProvider = {
      submitStrategyConcepts: base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base),
      generateConcept: async (input, context) => {
        conceptInputs.push(input);
        return base.generateConcept(input, context);
      },
      submitConceptExecution: async (input, context) => {
        conceptInputs.push(input);
        return base.submitConceptExecution!(input, context);
      },
      retrieveConceptExecution: base.retrieveConceptExecution!.bind(base)
    };
    const setup = await harness(provider);
    try {
      const generated = await processBatch(setup);
      const selected = generated.concepts.slice(0, 3).map((item) => item.currentRevision.id);
      const requestId = randomUUID();
      const projects = await setup.strategyService.handoff(generated.batch.id, selected, requestId, "owner");
      const duplicate = await setup.strategyService.handoff(generated.batch.id, selected, requestId, "owner");
      expect(duplicate.map((item) => item.id)).toEqual(projects.map((item) => item.id));
      expect(duplicate.map((item)=>item.creativeInputSnapshot?.id)).toEqual(projects.map((item)=>item.creativeInputSnapshot?.id));
      expect(projects.every((item)=>item.creativeInputSnapshot?.sha256.length===64)).toBe(true);
      expect(projects[0]?.creativeInputSnapshot?.input.selectedStrategy?.id).toBe(generated.concepts[0]!.currentRevision.id);
      expect(projects[0]?.creativeInputSnapshot?.input.productionCapabilities).toEqual(generated.batch.inputSnapshot.availableAssetCapabilities);
      expect((await setup.repository.getProject(projects[0]!.id)).creativeInputSnapshot).toEqual(projects[0]!.creativeInputSnapshot);
      expect(projects).toHaveLength(3);
      expect(projects[0]?.id).not.toBe(generated.project.id);
      expect(projects[1]?.id).not.toBe(generated.project.id);
      expect(projects[2]?.id).not.toBe(generated.project.id);
      expect(projects.every((project)=>project.strategyOrigin?.sourceProjectId===generated.project.id)).toBe(true);
      expect((await setup.repository.getProject(generated.project.id)).creativeInputSnapshot).toBeUndefined();
      const handoffs = await setup.pool.query<{ count: string }>("SELECT count(*)::text count FROM creative_strategy_handoffs WHERE batch_id=$1", [generated.batch.id]);
      expect(Number(handoffs.rows[0]?.count)).toBe(3);
      const originalHandoff = structuredClone(await setup.repository.getProject(projects[0]!.id));
      const product = await setup.service.getProduct(originalHandoff.productId);
      const changedAuthority = { status: "OPERATOR_CONFIRMED" as const, immutableStructure: ["Wall-sign silhouette", "Mounting configuration"], authorizedPersonalizationFields: ["Pet artwork", "House number", "Street text"] };
      await setup.service.updateProduct(product.id, { ...product, personalizationVisualAuthority: changedAuthority });
      const changedRequestId = randomUUID();
      const [changedAuthorityProject] = await setup.strategyService.handoff(generated.batch.id, [selected[0]!], changedRequestId, "owner");
      expect(changedAuthorityProject!.id).not.toBe(projects[0]!.id);
      expect(changedAuthorityProject!.creativeInputSnapshot!.id).not.toBe(projects[0]!.creativeInputSnapshot!.id);
      expect(changedAuthorityProject!.creativeInputSnapshot!.input.personalizationVisualAuthority).toEqual(changedAuthority);
      expect(await setup.repository.getProject(projects[0]!.id)).toEqual(originalHandoff);
      const [changedAuthorityDuplicate] = await setup.strategyService.handoff(generated.batch.id, [selected[0]!], changedRequestId, "owner");
      expect(changedAuthorityDuplicate!.id).toBe(changedAuthorityProject!.id);
      expect(changedAuthorityDuplicate!.creativeInputSnapshot).toEqual(changedAuthorityProject!.creativeInputSnapshot);
      const strategy = generated.concepts[0]!.currentRevision;
      await setup.service.generateConcept(projects[0]!.id, "editor");
      const conceptJob=(await setup.repository.listJobs(projects[0]!.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      expect((await setup.service.processJob(conceptJob.id)).status).toBe("COMPLETED");
      const project = await setup.repository.getProject(projects[0]!.id);
      const concept = project.concepts.at(-1)!;
      expect(concept.inputSnapshot.selectedStrategy).toMatchObject({
        id: strategy.id,
        coreAngle: strategy.coreAngle,
        hook: strategy.hook,
        proofMechanism: strategy.proofMechanism,
        primaryProductionMethod: strategy.primaryProductionMethod,
        supportingProductionMethods: strategy.supportingProductionMethods,
        productTruthConstraints: strategy.productTruthConstraints,
        visualFidelityRequirements: strategy.visualFidelityRequirements
      });
      expect(concept.angle).toBe(strategy.coreAngle);
      expect(concept.hook).toBe(strategy.hook);
      expect(concept.cta).toBe(concept.inputSnapshot.defaultCta);
      expect(concept.inputSnapshot.selectedStrategy?.ctaStrategy).toBe(strategy.ctaStrategy);
      expect(conceptInputs[0]?.selectedStrategy?.revisionSha256).toBe(projects[0]?.strategyOrigin?.revisionSha256);
      const conceptOperation=await setup.repository.getConceptProviderOperation(`concept:${project.id}:revision:1:generate`);
      expect(conceptOperation).toMatchObject({state:"SUCCEEDED",provider:"fake-openai",model:"fake-structured-concept-v1",snapshotId:projects[0]!.creativeInputSnapshot!.id,snapshotSha256:projects[0]!.creativeInputSnapshot!.sha256});
      expect(conceptOperation?.resultSha256).toHaveLength(64);
      expect(conceptOperation?.safeResult).not.toHaveProperty("angle");
      expect((await setup.repository.getProject(project.id)).creativeInputSnapshot).toEqual(projects[0]!.creativeInputSnapshot);
      const before = Number((await setup.pool.query<{ count: string }>("SELECT count(*)::text count FROM creative_strategy_handoffs WHERE batch_id=$1", [generated.batch.id])).rows[0]?.count);
      await expect(setup.strategyService.handoff(generated.batch.id, generated.concepts.slice(0, 4).map((item) => item.currentRevision.id), randomUUID(), "owner")).rejects.toThrow("between one and three");
      expect(Number((await setup.pool.query<{ count: string }>("SELECT count(*)::text count FROM creative_strategy_handoffs WHERE batch_id=$1", [generated.batch.id])).rows[0]?.count)).toBe(before);

      const stale = generated.concepts[4]!.currentRevision;
      await setup.strategies.saveGeneratedConcepts({
        batchId: generated.batch.id,
        concepts: [{ ...stale, ordinal: stale.ordinal }],
        source: "OPERATOR_REPLACEMENT",
        actor: "integration",
        providerMetadata: { fake: true },
        timestamp: new Date().toISOString(),
        replaceOrdinals: [stale.ordinal]
      });
      await expect(setup.strategyService.handoff(generated.batch.id, [stale.id], randomUUID(), "owner")).rejects.toThrow("production-safe");
    } finally {
      await setup.dispose();
    }
  });

  it("resumes a known Creative Concept Response ID after service restart without another create",async()=>{
    const base=new FakeCreativeProvider();
    let outputText="";
    let creates=0;
    let retrieves=0;
    const provider:CreativeProvider={
      generateConcept:base.generateConcept.bind(base),
      submitStrategyConcepts:base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),
      submitConceptExecution:async(input,context)=>{
        creates+=1;
        outputText=JSON.stringify((await base.generateConcept(input,context)).concept);
        return {responseId:"resp_concept_restart",status:"queued",provider:"fake-openai",model:"fake-background"};
      },
      retrieveConceptExecution:async(responseId)=>{
        retrieves+=1;
        expect(responseId).toBe("resp_concept_restart");
        return {responseId,status:"completed",provider:"fake-openai",model:"fake-background",outputText,usage:{inputTokens:13,outputTokens:21,totalTokens:34}};
      }
    };
    const first=await harness(provider);
    let projectId="";
    let jobId="";
    let operationKey="";
    try{
      const generated=await processBatch(first,randomUUID(),3);
      const [project]=await first.strategyService.handoff(generated.batch.id,[generated.concepts[0]!.currentRevision.id],randomUUID(),"owner");
      projectId=project!.id;
      await first.service.generateConcept(projectId,"editor");
      const job=(await first.repository.listJobs(projectId)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      jobId=job.id;operationKey=job.dedupeKey;
      expect((await first.service.processJob(jobId)).status).toBe("PENDING");
      expect(await first.repository.getConceptProviderOperation(operationKey)).toMatchObject({state:"POLLING",providerTaskId:"resp_concept_restart",latestProviderStatus:"queued"});
      expect(creates).toBe(1);
    }finally{await first.dispose();}
    const restarted=await harness(provider);
    try{
      expect((await restarted.service.processJob(jobId)).status).toBe("COMPLETED");
      expect(creates).toBe(1);
      expect(retrieves).toBe(1);
      expect(await restarted.repository.getConceptProviderOperation(operationKey)).toMatchObject({state:"SUCCEEDED",providerTaskId:"resp_concept_restart",usage:{totalTokens:34}});
      expect((await restarted.repository.getProject(projectId)).concepts).toHaveLength(1);
    }finally{await restarted.dispose();}
  });

  it("rejects a contradictory concept provider response before creating scene or media jobs and preserves legacy direct workflow", async () => {
    const base = new FakeCreativeProvider();
    const contradictory: CreativeProvider = {
      submitStrategyConcepts: base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base),
      generateConcept: async (input: CreativeInputSnapshot, context: ProviderOperationContext) => {
        const result = await base.generateConcept(input, context);
        if(!input.selectedStrategy)return result;
        return { ...result, concept: { ...result.concept, strategyExecutionSummary: "Moving into a new home? Send the perfect housewarming gift.", voiceScript: "A generic moving gift for the new homeowner.", scenes: result.concept.scenes.map((scene)=>({...scene,purpose:"Housewarming gift story",generationPrompt:"Show a gift box and new homeowner before a generic present.",overlayText:"THE PERFECT MOVING GIFT"})) } };
      },
      submitConceptExecution: async (input,context) => {
        const result=await base.generateConcept(input,context);
        const concept=input.selectedStrategy?{...result.concept,strategyExecutionSummary:"Moving into a new home? Send the perfect housewarming gift.",voiceScript:"A generic moving gift for the new homeowner.",scenes:result.concept.scenes.map((scene)=>({...scene,purpose:"Housewarming gift story",generationPrompt:"Show a gift box and new homeowner before a generic present.",overlayText:"THE PERFECT MOVING GIFT"}))}:result.concept;
        return {responseId:`resp-${context.operationKey}`,status:"completed",provider:"fake-openai",model:"fake-structured-concept-v1",outputText:JSON.stringify(concept),usage:{inputTokens:10,outputTokens:20,totalTokens:30}};
      },
      retrieveConceptExecution: base.retrieveConceptExecution!.bind(base)
    };
    const setup = await harness(contradictory);
    try {
      const generated = await processBatch(setup);
      const [project] = await setup.strategyService.handoff(generated.batch.id, [generated.concepts[0]!.currentRevision.id], randomUUID(), "owner");
      await setup.service.generateConcept(project!.id, "editor");
      const conceptJob=(await setup.repository.listJobs(project!.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      await expect(setup.service.processJob(conceptJob.id)).rejects.toMatchObject({ code: "CONCEPT_STRATEGY_MISMATCH" });
      const rejected = await setup.service.getProject(project!.id);
      expect(rejected.concepts).toHaveLength(0);
      const operation=await setup.repository.getConceptProviderOperation(`concept:${project!.id}:revision:1:generate`);
      expect(operation).toMatchObject({state:"REJECTED",provider:"fake-openai",model:"fake-structured-concept-v1",rejectionCode:"CONCEPT_STRATEGY_MISMATCH"});
      expect(operation?.resultSha256).toHaveLength(64);
      expect(operation?.validationFindings.join(" ")).toMatch(/STRATEGY_(SEMANTIC_DRIFT|TERRITORY_CHANGED)/);
      expect(JSON.stringify(operation)).not.toMatch(/authorization|api[_-]?key|cookie/i);
      expect((await setup.repository.listJobs(project!.id)).filter((item) => item.type === "GENERATE_SCENE")).toHaveLength(0);
      expect(setup.videoProvider.submissions).toHaveLength(0);

      const legacyAsset = await setup.storage.put(`legacy/${randomUUID()}.png`, {
        bytes: Buffer.from("legacy-reference"),
        mimeType: "image/png",
        extension: "png",
        metadata: { integration: true }
      });
      await setup.pool.query(
        "INSERT INTO media_assets(id,storage_provider,storage_key,kind,mime_type,byte_size,sha256,metadata,status,created_at) VALUES($1,'local',$2,'IMAGE',$3,$4,$5,$6::jsonb,'AVAILABLE',$7)",
        [legacyAsset.id, legacyAsset.storageKey, legacyAsset.mimeType, legacyAsset.byteSize, legacyAsset.sha256, JSON.stringify(legacyAsset.metadata), legacyAsset.createdAt]
      );
      const legacyProduct = await setup.service.createProduct({
        name: "Legacy integration product",
        slug: `legacy-${randomUUID()}`,
        description: "Project created without strategy metadata.",
        claims: [],
        defaultCta: "Create yours",
        assets: [{ id: legacyAsset.id, kind: "IMAGE", label: "Legacy product image", storageKey: legacyAsset.storageKey, mimeType: legacyAsset.mimeType }]
      });
      let legacy = await setup.service.createProject({ productId: legacyProduct.id, selectedProductAssetIds: [legacyAsset.id], preferredVoiceProfileId: "marin", actor: "integration" });
      expect(legacy.strategyRequired).toBeUndefined();
      legacy = await setup.service.generateConcept(legacy.id, "integration");
      legacy = await setup.service.approveConcept(legacy.id, "integration");
      expect(legacy.state).toBe("SCENES_GENERATING");
      expect((await setup.repository.listJobs(legacy.id)).filter((item) => item.type === "GENERATE_SCENE")).toHaveLength(3);
    } finally {
      await setup.dispose();
    }
  });
});
