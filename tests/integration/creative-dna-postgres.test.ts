import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreativeDnaService, CreativeFactoryService } from "@koolezt/application";
import type { CreativeDnaPreprocessor, CreativeProvider, GeneratedAsset, MediaPayload, StorageProvider, StrategyProviderResponse } from "@koolezt/domain";
import {
  createPostgresPool, createRedisConnection, createWorkflowWorker, OutboxDispatcher,
  PostgresCreativeDnaStore, PostgresDurableMediaAssetCatalog, PostgresFactoryRepository, PostgresMediaAssetCatalog,
  PostgresOutboxStore, WORKFLOW_QUEUE_NAME
} from "@koolezt/infrastructure";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";

const databaseBase = process.env.KOOLEZT_TEST_DATABASE_URL;
const redisUrl = process.env.KOOLEZT_TEST_DNA_REDIS_URL ?? process.env.KOOLEZT_TEST_REDIS_URL;
const integration = databaseBase && redisUrl ? describe.sequential : describe.skip;
const prefix = `dna_7c14_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const schemas = { runtime: `${prefix}_runtime`, fresh: `${prefix}_fresh`, upgrade: `${prefix}_upgrade` } as const;
let runtimeUrl: string | undefined;
let freshUrl: string | undefined;
let upgradeUrl: string | undefined;

function withSchema(connectionString: string, schema: string) {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}
async function migrate(connectionString: string, through?: string) {
  const pool = createPostgresPool(connectionString);
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    const names = (await readdir(new URL("../../db/migrations", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      if (through && name > through) break;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  } finally { await pool.end(); }
}

const metadata = { durationMs: 15_000, width: 720, height: 1280, frameRate: 30, hasAudio: true, mimeType: "video/mp4" };
const frames = [
  { timestampMs: 0, mimeType: "image/jpeg" as const, bytesBase64: "YQ==", sha256: "a".repeat(64) },
  { timestampMs: 14_900, mimeType: "image/jpeg" as const, bytesBase64: "Yg==", sha256: "b".repeat(64) }
];
const preprocessor: CreativeDnaPreprocessor = { async preprocess(asset: GeneratedAsset) { void asset; return { mediaMetadata: metadata, frames }; } };
class IntegrationStorage implements StorageProvider {
  private readonly assets=new Map<string,GeneratedAsset>();
  constructor(private readonly catalog:PostgresMediaAssetCatalog){}
  async put(key:string,payload:MediaPayload){
    const bytes=Uint8Array.from(payload.bytes);
    const asset:GeneratedAsset={id:randomUUID(),kind:payload.mimeType.startsWith("video/")?"VIDEO":payload.mimeType.startsWith("image/")?"IMAGE":"AUDIO",storageKey:key,mimeType:payload.mimeType,byteSize:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex"),metadata:payload.metadata,createdAt:new Date().toISOString()};
    this.assets.set(asset.id,asset);await this.catalog.save(asset);return asset;
  }
  async read(key:string){const asset=[...this.assets.values()].find((item)=>item.storageKey===key);if(!asset)throw new Error("Test asset not found.");return new Uint8Array([0,1,2]);}
  async getAsset(id:string){const asset=this.assets.get(id)??await this.catalog.get(id);if(!asset)throw new Error("Test asset not found.");return asset;}
}

async function harness(databaseUrl: string, provider: CreativeProvider) {
  const pool = createPostgresPool(databaseUrl);
  const repository = new PostgresFactoryRepository(pool);
  const dna = new PostgresCreativeDnaStore(pool);
  const storage = new IntegrationStorage(new PostgresMediaAssetCatalog(pool));
  const videoProvider = new FakeVideoGenerationProvider();
  const voiceProvider = new FakeVoiceProvider();
  const compositionProvider = new FakeCompositionProvider();
  const factory = new CreativeFactoryService({
    repository, creativeDnaRepository: dna, creativeProvider: provider, videoProvider, voiceProvider, compositionProvider,
    externalMediaDelivery: {} as never, compositionOutputIngestor: {} as never,
    storage, mediaInspector: {} as never, readyPublisher: {} as never
  });
  const service = new CreativeDnaService({ repository, dna, provider, storage, preprocessor });
  const project = await factory.createProjectFromBrief({
    requestId: randomUUID(), name: "DNA integration product", creativeTopic: "Historical winner learning",
    productDetails: "Personalized product shown in supplied references.", verifiedClaims: [],
    targetDurationSeconds: 15, actor: "integration"
  });
  const asset = await storage.put(`historical/${randomUUID()}.mp4`, { bytes: new Uint8Array([0, 1, 2]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
  const reference = await service.register({
    projectId: project.id, assetId: asset.id, displayName: "Historical Meta winner",
    operatorStatus: "WINNER", actor: "integration", platform: "Meta",
    performance: { spend: 100, purchases: 4, purchaseCpa: 25, currency: "USD", metricSource: "operator supplied" }
  });
  return { pool, repository, dna, storage, factory, service, project, reference, videoProvider, voiceProvider, compositionProvider, dispose: async () => { await pool.end(); } };
}
async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Timed out waiting for Creative DNA workflow.");
}

integration("Milestone 7C.14 PostgreSQL/Redis acceptance", () => {
  beforeAll(async () => {
    const admin = createPostgresPool(databaseBase!);
    try {
      for (const schema of Object.values(schemas)) {
        if (!/^dna_7c14_[a-f0-9]{12}_(?:runtime|fresh|upgrade)$/.test(schema)) throw new Error("Unsafe integration schema name.");
        await admin.query(`CREATE SCHEMA ${schema}`);
      }
    } finally { await admin.end(); }
    runtimeUrl = withSchema(databaseBase!, schemas.runtime);
    freshUrl = withSchema(databaseBase!, schemas.fresh);
    upgradeUrl = withSchema(databaseBase!, schemas.upgrade);
    await migrate(runtimeUrl);
    await migrate(freshUrl, "0019_winning_creative_dna.sql");
    await migrate(upgradeUrl, "0018_canonical_strategy_constraints.sql");
    const pool = createPostgresPool(upgradeUrl);
    try {
      const name = "0019_winning_creative_dna.sql";
      await pool.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    } finally { await pool.end(); }
  }, 90_000);

  afterAll(async () => {
    const admin = createPostgresPool(databaseBase!);
    try {
      for (const schema of Object.values(schemas)) {
        if (!/^dna_7c14_[a-f0-9]{12}_(?:runtime|fresh|upgrade)$/.test(schema)) throw new Error("Unsafe integration schema name.");
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    } finally { await admin.end(); }
  }, 60_000);

  it("produces equivalent fresh and 0018-to-0019 additive schemas", async () => {
    const pools = [createPostgresPool(freshUrl!), createPostgresPool(upgradeUrl!)];
    try {
      const fingerprints: string[] = [];
      for (const pool of pools) {
        const migration = await pool.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
        expect(migration.rows[0]?.name).toBe("0019_winning_creative_dna.sql");
        const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'creative_dna_%' OR table_schema=current_schema() AND table_name='creative_references' ORDER BY table_name");
        expect(tables.rows.map((row) => row.table_name)).toEqual(["creative_dna_provider_operations", "creative_dna_revisions", "creative_references"]);
        const projectColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='creative_projects' AND column_name LIKE 'winner_%' ORDER BY column_name");
        expect(projectColumns.rows.map((row) => row.column_name)).toEqual(["winner_creative_reference_id", "winner_dna_revision_id"]);
        const constraints = await pool.query(`SELECT rel.relname table_name,con.conname,pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace WHERE ns.nspname=current_schema() AND rel.relname IN ('creative_references','creative_dna_revisions','creative_dna_provider_operations') ORDER BY rel.relname,con.conname`);
        expect(constraints.rows.some((row) => row.definition.includes("WINNER") && row.definition.includes("LOSER"))).toBe(true);
        expect(constraints.rows.filter((row) => row.definition.startsWith("FOREIGN KEY")).length).toBeGreaterThanOrEqual(5);
        fingerprints.push(JSON.stringify({ tables: tables.rows, projectColumns: projectColumns.rows, constraints: constraints.rows }));
      }
      expect(fingerprints[1]).toBe(fingerprints[0]);
    } finally { await Promise.all(pools.map((pool) => pool.end())); }
  });

  it("retains referenced source media across DNA states and closes the selection/claim race", async () => {
    const provider = new FakeCreativeProvider();
    const setup = await harness(runtimeUrl!, provider);
    const catalog = new PostgresDurableMediaAssetCatalog(setup.pool);
    const expire = async (assetId:string) => setup.pool.query(
      `UPDATE media_assets SET storage_provider='s3',storage_bucket='private-test',purpose='CREATIVE_REFERENCE',
        lifecycle_status='AVAILABLE',status='AVAILABLE',delete_after=now()-interval '1 hour' WHERE id=$1`,
      [assetId]
    );
    const assertProtected = async (assetId:string) => {
      await catalog.reconcileRetention(new Date().toISOString(), 7, 7, 24);
      const retained = await setup.pool.query("SELECT status,lifecycle_status,delete_after FROM media_assets WHERE id=$1", [assetId]);
      expect(retained.rows[0]).toMatchObject({ status: "AVAILABLE", lifecycle_status: "AVAILABLE", delete_after: null });
      await expire(assetId);
      expect((await catalog.dueCleanup(new Date().toISOString(), 50)).map((asset) => asset.id)).not.toContain(assetId);
      expect(await catalog.markCleanupPending(assetId)).toBe(false);
      expect((await setup.pool.query("SELECT lifecycle_status FROM media_assets WHERE id=$1", [assetId])).rows[0]?.lifecycle_status).toBe("AVAILABLE");
      expect((await setup.storage.getAsset(assetId)).id).toBe(assetId);
    };
    try {
      // A stale schedule is rendered harmless immediately by claim-time ownership
      // rechecking, then canonical reconciliation clears it.
      await expire(setup.reference.sourceAssetId);
      await assertProtected(setup.reference.sourceAssetId);

      // Create an actual provider-produced DRAFT, then approve it through the
      // repository transaction; neither lifecycle transition weakens retention.
      const job = await setup.service.requestAnalysis(setup.reference.id, randomUUID());
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      const draft = (await setup.service.list()).find((record) => record.reference.id === setup.reference.id)?.revisions[0];
      expect(draft?.status).toBe("DRAFT");
      await expire(setup.reference.sourceAssetId);
      await assertProtected(setup.reference.sourceAssetId);
      await setup.service.approve(setup.reference.id, draft!.id, "integration");
      expect((await setup.dna.getReference(setup.reference.id)).analysisStatus).toBe("APPROVED");
      await expire(setup.reference.sourceAssetId);
      await assertProtected(setup.reference.sourceAssetId);

      // ARCHIVED remains a live reference state. There is intentionally no
      // application deletion endpoint for Creative References.
      const approved = await setup.dna.getReference(setup.reference.id);
      await setup.dna.updateReference({ ...approved, analysisStatus: "ARCHIVED", updatedAt: new Date().toISOString() });
      await expire(setup.reference.sourceAssetId);
      await assertProtected(setup.reference.sourceAssetId);

      // The schema currently permits many Creative References to point at one
      // source asset; one remaining row is sufficient to prohibit cleanup.
      await setup.service.register({
        projectId: setup.project.id, assetId: setup.reference.sourceAssetId,
        displayName: "Second reference to same source", operatorStatus: "REFERENCE", actor: "integration"
      });
      const references = await setup.pool.query("SELECT count(*)::int count FROM creative_references WHERE source_asset_id=$1", [setup.reference.sourceAssetId]);
      expect(references.rows[0]?.count).toBe(2);
      await expire(setup.reference.sourceAssetId);
      await assertProtected(setup.reference.sourceAssetId);

      // Selection/claim race: selection sees an unreferenced candidate, a
      // reference is linked, then claim rechecks current PostgreSQL ownership.
      const raced = await setup.storage.put("historical/raced.mp4", { bytes: new Uint8Array([3,4,5]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
      await expire(raced.id);
      expect((await catalog.dueCleanup(new Date().toISOString(), 50)).map((asset) => asset.id)).toContain(raced.id);
      await setup.service.register({
        projectId: setup.project.id, assetId: raced.id,
        displayName: "Linked after cleanup selection", operatorStatus: "REFERENCE", actor: "integration"
      });
      expect(await catalog.markCleanupPending(raced.id)).toBe(false);
      expect((await setup.pool.query("SELECT lifecycle_status FROM media_assets WHERE id=$1", [raced.id])).rows[0]?.lifecycle_status).toBe("AVAILABLE");

      // The fix does not disable cleanup globally: an unrelated expired asset
      // is still selected, claimed, and reaches the normal cleaned catalog state.
      const unreferenced = await setup.storage.put("historical/unreferenced.mp4", { bytes: new Uint8Array([6,7,8]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
      await expire(unreferenced.id);
      expect((await catalog.dueCleanup(new Date().toISOString(), 50)).map((asset) => asset.id)).toContain(unreferenced.id);
      expect(await catalog.markCleanupPending(unreferenced.id)).toBe(true);
      await catalog.markCleaned(unreferenced.id);
      expect((await setup.pool.query("SELECT status,lifecycle_status FROM media_assets WHERE id=$1", [unreferenced.id])).rows[0]).toMatchObject({ status: "DELETED", lifecycle_status: "CLEANED" });
    } finally { await setup.dispose(); }
  });

  it("processes an explicit analysis through PostgreSQL, Redis and outbox without media provider calls or secrets", async () => {
    const base = new FakeCreativeProvider();
    const secret = "must-not-persist-provider-secret";
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitCreativeDnaAnalysis: async (input, context) => base.submitCreativeDnaAnalysis!(input, context),
      retrieveCreativeDnaAnalysis: base.retrieveCreativeDnaAnalysis.bind(base)
    };
    const setup = await harness(runtimeUrl!, provider);
    const connection = createRedisConnection(redisUrl!);
    const queue = new Queue(WORKFLOW_QUEUE_NAME, { connection });
    const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(setup.pool), queue);
    let worker: ReturnType<typeof createWorkflowWorker> | undefined;
    try {
      await connection.flushdb();
      const job = await setup.service.requestAnalysis(setup.reference.id, randomUUID());
      expect(base.calls).toHaveLength(0);
      worker = createWorkflowWorker(connection, setup.service, 1);
      expect(await dispatcher.dispatchAvailable()).toBeGreaterThanOrEqual(1);
      await waitFor(async () => (await setup.repository.getJob(job.id)).status === "COMPLETED");
      expect((await setup.repository.getJob(job.id)).lastError).toBeUndefined();
      const record = (await setup.service.list())[0]!;
      expect(record.reference.analysisStatus).toBe("DRAFT");
      expect(record.revisions).toHaveLength(1);
      const operation = await setup.pool.query("SELECT status,response_id,result_sha256,provider_metadata,result_payload FROM creative_dna_provider_operations WHERE creative_reference_id=$1", [setup.reference.id]);
      expect(operation.rows[0]).toMatchObject({ status: "SUCCEEDED" });
      expect(operation.rows[0].response_id).toMatch(/^fake-dna-/);
      expect(operation.rows[0].result_sha256).toHaveLength(64);
      expect(JSON.stringify(operation.rows[0])).not.toContain(secret);
      expect(JSON.stringify(operation.rows[0]).toLowerCase()).not.toContain("authorization");
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    } finally {
      await worker?.close(); await queue.close(); await connection.quit(); await setup.dispose();
    }
  }, 90_000);

  it("persists a known response ID and resumes retrieval after worker restart without another create", async () => {
    const base = new FakeCreativeProvider();
    let creates = 0;
    let retrieves = 0;
    let completed: StrategyProviderResponse | undefined;
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitCreativeDnaAnalysis: async (input, context) => {
        creates += 1; completed = await base.submitCreativeDnaAnalysis!(input, context);
        const { outputText: _outputText, ...submission } = completed;
        void _outputText;
        return { ...submission, status: "queued" };
      },
      retrieveCreativeDnaAnalysis: async (responseId) => {
        retrieves += 1;
        if (!completed || completed.responseId !== responseId) throw new Error("Unexpected response ID.");
        return { ...completed, responseId };
      }
    };
    const setup = await harness(runtimeUrl!, provider);
    try {
      const job = await setup.service.requestAnalysis(setup.reference.id, randomUUID());
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      const persisted = await setup.pool.query("SELECT status,response_id FROM creative_dna_provider_operations WHERE creative_reference_id=$1", [setup.reference.id]);
      expect(persisted.rows[0]).toMatchObject({ status: "POLLING" });
      expect(persisted.rows[0].response_id).toBeTruthy();
      // A later worker delivery reloads the durable operation and retrieves the known ID.
      const completedJob = await setup.service.processJob(job.id);
      expect(completedJob.status).toBe("COMPLETED");
      expect(completedJob.lastError).toBeUndefined();
      expect((await setup.repository.getJob(job.id)).lastError).toBeUndefined();
      expect({ creates, retrieves }).toEqual({ creates: 1, retrieves: 1 });
    } finally { await setup.dispose(); }
  });
});
