import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import {
  createPostgresPool,
  createRedisConnection,
  createWorkflowWorker,
  OutboxDispatcher,
  PostgresFactoryRepository,
  PostgresMediaAssetCatalog,
  PostgresOutboxStore,
  WORKFLOW_QUEUE_NAME
} from "@koolezt/infrastructure";
import {
  FakeExternalMediaDeliveryProvider,
  FfprobeMediaInspector,
  InlineCompositionOutputIngestor,
  LocalReadyPublisher,
  LocalStorageProvider
} from "@koolezt/media";
import {
  FakeCompositionProvider,
  FakeCreativeProvider,
  FakeVideoGenerationProvider,
  FakeVoiceProvider
} from "@koolezt/providers";

const baseDatabaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
let databaseUrl: string | undefined;
const redisUrl = process.env.KOOLEZT_TEST_REDIS_URL;
const integration = baseDatabaseUrl && redisUrl ? describe : describe.skip;
const schema = `persistent_workflow_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const fixture = resolve("tests/fixtures/vertical-1080x1920.mp4");
const ffprobe = process.env.FFPROBE_PATH ?? resolve(
  `node_modules/ffprobe-static/bin/${process.platform}/${process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64"}/ffprobe${process.platform === "win32" ? ".exe" : ""}`
);
const roots: string[] = [];

function withSchema(connectionString: string, schemaName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

async function migrateSchema(connectionString: string): Promise<void> {
  const pool = createPostgresPool(connectionString);
  try {
    await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const names = (await readdir(new URL("../../db/migrations", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
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

beforeAll(async () => {
  const admin = createPostgresPool(baseDatabaseUrl!);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  databaseUrl = withSchema(baseDatabaseUrl!, schema);
  await migrateSchema(databaseUrl);
});

afterAll(async () => {
  if (!baseDatabaseUrl) return;
  const admin = createPostgresPool(baseDatabaseUrl);
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => Promise<boolean>, dispatch: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await dispatch();
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for durable fake workflow completion.");
}

integration("persistent fake-provider workflow", () => {
  it("uses PostgreSQL truth and BullMQ scheduling through READY publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-factory-integration-"));
    roots.push(root);
    const pool = createPostgresPool(databaseUrl!);
    const connection = createRedisConnection(redisUrl!);
    const queue = new Queue(WORKFLOW_QUEUE_NAME, { connection });
    const catalog = new PostgresMediaAssetCatalog(pool);
    const creative = new FakeCreativeProvider();
    const video = new FakeVideoGenerationProvider(fixture);
    const voice = new FakeVoiceProvider(fixture);
    const composition = new FakeCompositionProvider(fixture);
    const externalMedia = new FakeExternalMediaDeliveryProvider();
    const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(pool), queue);
    const makeService = () => {
      const storage = new LocalStorageProvider(join(root, "media"), undefined, undefined, catalog);
      const readyPublisher = new LocalReadyPublisher(join(root, "ready"), storage);
      return {
        storage,
        readyPublisher,
        service: new CreativeFactoryService({
          repository: new PostgresFactoryRepository(pool),
          creativeProvider: creative,
          videoProvider: video,
          voiceProvider: voice,
          compositionProvider: composition,
          externalMediaDelivery: externalMedia,
          compositionOutputIngestor: new InlineCompositionOutputIngestor(),
          storage,
          mediaInspector: new FfprobeMediaInspector(join(root, "media"), ffprobe),
          readyPublisher
        })
      };
    };
    let worker: ReturnType<typeof createWorkflowWorker> | undefined;
    try {
      await connection.flushdb();
      // This shared integration database intentionally keeps prior project
      // fixtures. Undispatched rows from an interrupted earlier run are not
      // part of this scenario and would otherwise delay its single worker.
      await pool.query("DELETE FROM workflow_outbox WHERE dispatched_at IS NULL");
      const first = makeService();
      const mockup = await first.storage.put(`products/integration-${randomUUID()}.png`, {
        bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+XQAAAABJRU5ErkJggg==", "base64"),
        mimeType: "image/png",
        extension: "png",
        metadata: { integration: true }
      });
      const product = await first.service.createProduct({
        name: "Integration Sign",
        slug: `integration-sign-${mockup.id.slice(0, 8)}`,
        description: "Persistent fake workflow product.",
        claims: [{ kind: "RESTRICTION", text: "Preserve supplied product details." }],
        defaultCta: "Create yours",
        assets: [{ id: mockup.id, kind: "IMAGE", label: "Integration mockup", storageKey: mockup.storageKey, mimeType: mockup.mimeType }]
      });
      let project = await first.service.createProject({
        productId: product.id,
        selectedProductAssetIds: [mockup.id],
        preferredVoiceProfileId: "female-ugc",
        actor: "integration"
      });
      project = await first.service.generateConcept(project.id, "integration");
      project = await first.service.approveConcept(project.id, "integration");
      for (const scene of project.scenes) {
        if (scene.attempts[0]?.sourceType === "AI_VIDEO") {
          project = await first.service.setSceneGenerationMethod(project.id, scene.id, "API", "integration");
        }
      }

      const outboxBeforeDispatch = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workflow_outbox WHERE workflow_job_id IN (SELECT id FROM workflow_jobs WHERE project_id = $1)",
        [project.id]
      );
      expect(Number(outboxBeforeDispatch.rows[0]?.count)).toBe(3);
      worker = createWorkflowWorker(connection, first.service, 1);
      expect(await dispatcher.dispatchAvailable()).toBe(3);
      expect(await dispatcher.dispatchAvailable()).toBe(0);
      await waitFor(
        async () => (await first.service.getProject(project.id)).state === "SCENES_REVIEW",
        async () => { await dispatcher.dispatchAvailable(); }
      );
      project = await first.service.getProject(project.id);
      expect(video.submissions.filter((submission) => submission.projectId === project.id)).toHaveLength(3);
      const completedSceneJob = (await first.service.listJobs(project.id)).find((job) => job.type === "GENERATE_SCENE");
      expect(completedSceneJob?.status).toBe("COMPLETED");
      await first.service.processJob(completedSceneJob!.id);
      expect(video.submissions.filter((submission) => submission.projectId === project.id)).toHaveLength(3);

      const [scene1, scene2, scene3] = project.scenes;
      project = await first.service.approveScene(project.id, scene1!.id, scene1!.attempts[0]!.id, "integration");
      project = await first.service.approveScene(project.id, scene3!.id, scene3!.attempts[0]!.id, "integration");
      project = await first.service.rejectSceneAttempt(project.id, scene2!.id, scene2!.attempts[0]!.id, "integration");
      project = await first.service.regenerateScene(project.id, scene2!.id, "Revised durable Scene 2 prompt.", "integration");
      await waitFor(
        async () => (await first.service.getProject(project.id)).scenes.find((scene) => scene.id === scene2!.id)?.attempts.length === 2
          && (await first.service.getProject(project.id)).scenes.find((scene) => scene.id === scene2!.id)?.attempts[1]?.status === "REVIEW",
        async () => { await dispatcher.dispatchAvailable(); }
      );
      project = await first.service.getProject(project.id);
      expect(project.scenes.find((scene) => scene.id === scene1!.id)?.attempts).toHaveLength(1);
      expect(project.scenes.find((scene) => scene.id === scene3!.id)?.attempts).toHaveLength(1);
      expect(project.scenes.find((scene) => scene.id === scene2!.id)?.attempts[0]?.status).toBe("REJECTED");
      expect(video.submissions.filter((submission) => submission.projectId === project.id)).toHaveLength(4);

      await worker.close();
      worker = undefined;
      const restarted = makeService();
      project = await restarted.service.getProject(project.id);
      const regeneratedScene2 = project.scenes.find((scene) => scene.id === scene2!.id)!;
      project = await restarted.service.approveScene(project.id, regeneratedScene2.id, regeneratedScene2.attempts.at(-1)!.id, "integration");
      project = await restarted.service.generateVoice(project.id, "integration");
      worker = createWorkflowWorker(connection, restarted.service, 1);
      await waitFor(
        async () => (await restarted.service.getProject(project.id)).state === "VOICE_REVIEW",
        async () => { await dispatcher.dispatchAvailable(); }
      );
      project = await restarted.service.getProject(project.id);
      project = await restarted.service.approveVoice(project.id, project.currentVoiceGenerationId!, "integration");
      project = await restarted.service.markEditorWorkComplete(project.id, "integration-editor");
      expect(project.state).toBe("READY_FOR_RENDER");
      expect(project.renders).toHaveLength(0);
      expect((await restarted.service.listJobs(project.id)).filter((job) => job.type === "COMPOSE_RENDER")).toHaveLength(0);
      project = await restarted.service.renderFinal(project.id, "integration", "fake");
      await dispatcher.dispatchAvailable();
      await waitFor(
        async () => (await restarted.service.getProject(project.id)).state === "FINAL_REVIEW",
        async () => { await dispatcher.dispatchAvailable(); }
      );

      const recovered = makeService();
      project = await recovered.service.getProject(project.id);
      expect(project.renders.at(-1)?.inspection?.passed).toBe(true);
      expect(project.renders.at(-1)?.inspection).toMatchObject({
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "aac",
        hasAudio: true
      });
      expect(project.renders.at(-1)?.outputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(project.usageCosts).toHaveLength(7);
      expect(project.approvals).toHaveLength(6); // concept, four scenes, and explicit voice acceptance
      expect(project.auditEvents.length).toBeGreaterThan(5);
      const jobRows = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM provider_jobs WHERE project_id = $1", [project.id]);
      expect(Number(jobRows.rows[0]?.count)).toBeGreaterThanOrEqual(5);

      project = await recovered.service.approveAndSave(project.id, "integration");
      expect(project.state).toBe("READY");
      expect(project.readyFile?.sha256).toBe(project.renders.at(-1)?.outputSha256);
      expect((await stat(project.readyFile!.path)).size).toBeGreaterThan(0);
      const output = await recovered.storage.getAsset(project.renders.at(-1)!.outputAssetId!);
      const repeat = await recovered.readyPublisher.publish({
        source: output,
        productSlug: product.slug,
        projectPublicId: project.publicId,
        approvedSha256: project.renders.at(-1)!.outputSha256!
      });
      expect(repeat.sha256).toBe(project.readyFile?.sha256);
      expect(repeat.path).toBe(project.readyFile?.path);
    } finally {
      await worker?.close();
      await queue.close();
      await connection.quit();
      await pool.end();
    }
  }, 240_000);
});
