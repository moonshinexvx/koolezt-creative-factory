// Permanently removes every winner (with its analysis), video plan, made video, AI scene image and product photo,
// and deletes their files from S3 and local storage. Products and their facts are kept.
// Dry run by default; pass --apply to delete. Take a pg_dump backup first.
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createRuntime } from "../apps/api/src/runtime.js";

const apply = process.argv.includes("--apply");
const runtime = createRuntime();
const pool = runtime.pool;
const mediaRoot = resolve(process.env.WORKING_MEDIA_ROOT ?? "var/media");
// Children before parents, so no foreign key blocks a delete.
const tables = ["winner_jobs", "winner_videos", "winner_video_batches", "creative_meta_ad_links", "creative_winner_reports", "creative_dna_revisions", "creative_references", "product_assets"];
const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

try {
  console.table(await Promise.all([...tables, "media_assets", "products", "product_claims"].map(async (table) => ({ table, rows: await count(table) }))));
  const media = (await pool.query("SELECT id, storage_provider, storage_key FROM media_assets")).rows as { id: string; storage_provider: string; storage_key: string }[];
  console.log(`media files: ${media.filter((item) => item.storage_provider === "s3").length} in S3, ${media.filter((item) => item.storage_provider !== "s3").length} local`);
  if (!apply) {
    console.log("DRY RUN: nothing was deleted. Everything above except products and product_claims will be removed with --apply.");
  } else {
    const running = Number((await pool.query("SELECT count(*)::int AS n FROM winner_jobs WHERE status='RUNNING' AND updated_at > now() - interval '20 minutes'")).rows[0].n);
    if (running) throw new Error(`${running} background job(s) are still running. Wait a few minutes and try again.`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of tables) await client.query(`DELETE FROM ${table}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.log("database rows removed:", tables.join(", "));
    // The S3 store only deletes files that are due for cleanup, so mark every file due now.
    await pool.query("UPDATE media_assets SET delete_after=now() WHERE storage_provider='s3'");
    const removed: string[] = [];
    let failed = 0;
    for (const item of media) {
      try {
        if (item.storage_provider === "s3") {
          if (!runtime.durableMediaStore) throw new Error("S3 is not configured.");
          await runtime.durableMediaStore.deleteAsset(item.id);
        } else {
          const path = resolve(mediaRoot, item.storage_key);
          if (path.startsWith(mediaRoot + sep)) await rm(path, { force: true });
        }
        removed.push(item.id);
      } catch (error) {
        failed++;
        console.error("could not delete file", item.id, error instanceof Error ? error.message : error);
      }
    }
    // Rows whose file could not be deleted are kept so the cleanup can be run again.
    if (removed.length) await pool.query("DELETE FROM media_assets WHERE id = ANY($1::uuid[])", [removed]);
    console.log(`media files deleted: ${removed.length}, failed: ${failed}`);
    console.log("RESET DONE. Products and their facts were kept.");
  }
} catch (error) {
  console.error("RESET FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
