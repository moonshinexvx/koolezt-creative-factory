import { createHash, randomUUID } from "node:crypto";
import { S3DurableMediaStore } from "@koolezt/media";
import { PostgresDurableMediaAssetCatalog, createPostgresPool } from "@koolezt/infrastructure";

if (process.env.KOOLEZT_ALLOW_LIVE_S3_TESTS !== "true") throw new Error("Set KOOLEZT_ALLOW_LIVE_S3_TESTS=true to authorize the disposable durable-media S3 smoke.");
const databaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("KOOLEZT_TEST_DATABASE_URL is required; production database use is forbidden.");
const required = ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required.`);
const pool = createPostgresPool(databaseUrl);
const catalog = new PostgresDurableMediaAssetCatalog(pool);
const store = new S3DurableMediaStore({
  endpoint: process.env.S3_ENDPOINT ?? "",
  region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true", ttlSeconds: 120
}, catalog);
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const checksum = createHash("sha256").update(fixture).digest("hex");
let assetId: string | undefined;
try {
  const target = await store.createUpload({ projectId: randomUUID(), purpose: "PRODUCT_ASSET", kind: "IMAGE", mimeType: "image/png", extension: "png", byteSize: fixture.byteLength, sha256: checksum, originalFilename: "aws-media-smoke.png", metadata: { smoke: true } });
  assetId = target.asset.id;
  if (target.asset.lifecycleStatus !== "PENDING_UPLOAD") throw new Error("Durable identity was not pending before PUT.");
  const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: fixture });
  if (!put.ok) throw new Error(`Signed PUT failed with HTTP ${put.status}.`);
  const available = await store.completeUpload(assetId);
  if (available.lifecycleStatus !== "AVAILABLE" || available.sha256 !== checksum || available.byteSize !== fixture.byteLength) throw new Error("HEAD/checksum verification failed.");
  const reference = await store.getDownloadReference(assetId);
  const get = await fetch(reference.url);
  if (!get.ok) throw new Error(`Signed GET failed with HTTP ${get.status}.`);
  const downloaded = new Uint8Array(await get.arrayBuffer());
  if (downloaded.byteLength !== fixture.byteLength || createHash("sha256").update(downloaded).digest("hex") !== checksum) throw new Error("Signed GET bytes did not match.");
  await pool.query("UPDATE media_assets SET delete_after=now()-interval '1 second' WHERE id=$1", [assetId]);
  await store.deleteAsset(assetId);
  let absent = false;
  try { await store.read(available.storageKey); } catch (error) { absent = Boolean(error && typeof error === "object" && (String((error as { name?: unknown }).name ?? "").includes("NoSuchKey") || Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) === 404)); }
  if (!absent) throw new Error("Deleted smoke object still exists.");
  await pool.query("DELETE FROM media_assets WHERE id=$1 AND lifecycle_status='CLEANED'", [assetId]);
  assetId = undefined;
  console.log(JSON.stringify({ ok: true, identityBeforePut: true, signedPut: true, headAndChecksum: true, signedGet: true, exactBytes: true, deleted: true, remainingObjects: 0, remainingRows: 0 }));
} finally {
  if (assetId) {
    await pool.query("UPDATE media_assets SET delete_after=now()-interval '1 second' WHERE id=$1", [assetId]).catch(() => undefined);
    await store.deleteAsset(assetId).catch(() => undefined);
    await pool.query("DELETE FROM media_assets WHERE id=$1", [assetId]).catch(() => undefined);
  }
  await pool.end();
}