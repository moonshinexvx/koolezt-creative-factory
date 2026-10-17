import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresDesktopRenderJobStore, createPostgresPool } from "@koolezt/infrastructure";

const databaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("desktop render job durability", () => {
  it("deduplicates creation, enforces lease ownership, and reclaims an expired job", async () => {
    const pool = createPostgresPool(databaseUrl!); const store = new PostgresDesktopRenderJobStore(pool);
    const productId = randomUUID(); const projectId = randomUUID(); const voiceId = randomUUID(); const renderId = randomUUID(); const outputId = randomUUID(); const operationKey = `desktop:${randomUUID()}`;
    const now = new Date().toISOString();
    const snapshot = { templateVersion: "desktop/v1", sceneInputs: [], narration: { voiceGenerationId: voiceId, assetId: outputId, sha256: "a".repeat(64), captionTimings: [] }, marketingOverlays: [], cta: "Create", target: { width: 1080, height: 1920, durationMs: 15000 } } as const;
    try {
      await pool.query("INSERT INTO products(id,name,slug,description,default_cta,active,created_at,updated_at) VALUES($1,'Desktop Test',$2,'test','Create',true,$3,$3)", [productId, `desktop-${productId}`, now]);
      const number = 8_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      await pool.query("INSERT INTO creative_projects(id,project_number,public_id,product_id,state,preferred_voice_profile_id,version,created_at,updated_at) VALUES($1,$2,$3,$4,'DRAFT','test',1,$5,$5)", [projectId, number, `CF-DESKTOP-${number}`, productId, now]);
      await pool.query("INSERT INTO voice_generations(id,project_id,attempt_number,voice_profile_id,source_script,status,operation_key,voice_json,created_at,updated_at) VALUES($1,$2,1,'test','test','SUCCEEDED',$3,'{}',$4,$4)", [voiceId, projectId, `voice:${voiceId}`, now]);
      await pool.query("INSERT INTO renders(id,project_id,attempt_number,status,operation_key,voice_generation_id,composition_style_key,cta,render_json,created_at,updated_at) VALUES($1,$2,1,'PENDING',$3,$4,'desktop/v1','Create','{}',$5,$5)", [renderId, projectId, operationKey, voiceId, now]);
      const first = await store.ensure({ projectId, renderId, operationKey, snapshot }); const duplicate = await store.ensure({ projectId, renderId, operationKey, snapshot }); expect(duplicate.id).toBe(first.id);
      const claimed = await store.claim("worker-one", 30_000); expect(claimed?.job.id).toBe(first.id); expect(await store.claim("worker-two", 30_000)).toBeUndefined();
      await expect(store.renew(first.id, "wrong-worker", claimed!.leaseToken, 30_000)).rejects.toMatchObject({ code: "DESKTOP_RENDER_LEASE_INVALID" });
      await store.progress(first.id, "worker-one", claimed!.leaseToken, "Rendering", 40, "libx264");
      await pool.query("UPDATE desktop_render_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first.id]);
      const reclaimed = await store.claim("worker-two", 30_000); expect(reclaimed?.job.id).toBe(first.id);
      await expect(store.renew(first.id, "worker-one", claimed!.leaseToken, 30_000)).rejects.toMatchObject({ code: "DESKTOP_RENDER_LEASE_INVALID" });
      await pool.query("INSERT INTO media_assets(id,storage_provider,storage_key,kind,mime_type,byte_size,sha256,metadata,created_at) VALUES($1,'local',$2,'RENDER','video/mp4',1,$3,'{}',$4)", [outputId, `desktop-test/${outputId}.mp4`, "b".repeat(64), now]);
      await store.succeed(first.id, "worker-two", reclaimed!.leaseToken, outputId, "b".repeat(64)); expect((await store.get(first.id)).state).toBe("SUCCEEDED");
    } finally {
      await pool.query("DELETE FROM desktop_render_jobs WHERE project_id=$1", [projectId]); await pool.query("DELETE FROM renders WHERE id=$1", [renderId]); await pool.query("DELETE FROM voice_generations WHERE id=$1", [voiceId]); await pool.query("DELETE FROM creative_projects WHERE id=$1", [projectId]); await pool.query("DELETE FROM products WHERE id=$1", [productId]); await pool.query("DELETE FROM media_assets WHERE id=$1", [outputId]); await pool.end();
    }
  });
});
