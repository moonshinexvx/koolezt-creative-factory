import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { S3DurableMediaStore } from "@koolezt/media";
import { PostgresDurableMediaAssetCatalog } from "@koolezt/infrastructure";
import type { GeneratedAsset } from "@koolezt/domain";

const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const bytes = new TextEncoder().encode("tiny durable fixture");
const checksum = createHash("sha256").update(bytes).digest("hex");

function setup() {
  let stored: GeneratedAsset | undefined;
  const catalog = {
    createPending: vi.fn(async (asset: GeneratedAsset) => { stored = asset; }),
    get: vi.fn(async (_id: string, includeUnavailable = false) => includeUnavailable || stored?.lifecycleStatus === "AVAILABLE" ? stored : undefined),
    markAvailable: vi.fn(async () => { stored = { ...stored!, lifecycleStatus: "AVAILABLE" }; }),
    markFailed: vi.fn(async () => { stored = { ...stored!, lifecycleStatus: "FAILED" }; }),
    reconcileRetention: vi.fn(async () => undefined),
    dueCleanup: vi.fn(async () => stored ? [stored] : []),
    markCleanupPending: vi.fn(async () => true),
    markCleaned: vi.fn(async () => { stored = { ...stored!, lifecycleStatus: "CLEANED", deletedAt: new Date().toISOString() }; }),
    markCleanupFailed: vi.fn(async () => undefined)
  };
  const send = vi.fn(async (command: object) => {
    const name = command.constructor.name;
    if (name === "HeadObjectCommand") return { ContentLength: bytes.byteLength, Metadata: { sha256: checksum, "asset-id": assetId } };
    if (name === "GetObjectCommand") return { Body: { transformToByteArray: async () => bytes } };
    return {};
  });
  const ids = [assetId, objectId];
  const store = new S3DurableMediaStore(
    { region: "ap-southeast-2", bucket: "private-test", accessKeyId: "not-secret", secretAccessKey: "secret-never-exposed", ttlSeconds: 60 },
    catalog,
    undefined,
    () => new Date("2026-09-11T00:00:00.000Z"),
    () => ids.shift()!
  );
  (store as unknown as { client: { send: typeof send } }).client.send = send;
  return { store, catalog, send, getStored: () => stored };
}

describe("S3 durable media store", () => {
  it("persists a controlled pending identity before issuing an exact-object PUT", async () => {
    const { store, catalog } = setup();
    const target = await store.createUpload({ projectId, purpose: "SCENE_VIDEO", kind: "VIDEO", mimeType: "video/mp4", extension: ".MP4", byteSize: bytes.byteLength, sha256: checksum });
    expect(catalog.createPending).toHaveBeenCalledOnce();
    expect(target.asset.lifecycleStatus).toBe("PENDING_UPLOAD");
    expect(target.asset.storageKey).toBe(`creative-factory/working/${projectId}/${assetId}/${objectId}.mp4`);
    expect(target.headers["x-amz-meta-sha256"]).toBe(checksum);
    expect(target.url).not.toContain("secret-never-exposed");
    expect(new URL(target.url).searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(new URL(target.url).searchParams.has("x-amz-meta-sha256")).toBe(false);
    expect(new URL(target.url).searchParams.get("X-Amz-SignedHeaders")).toContain("x-amz-meta-sha256");
  });

  it("HEAD-checks metadata and independently hashes object bytes before AVAILABLE", async () => {
    const { store, catalog, send } = setup();
    const target = await store.createUpload({ projectId, purpose: "FINAL_RENDER", kind: "RENDER", mimeType: "video/mp4", extension: "mp4", byteSize: bytes.byteLength, sha256: checksum, namespace: "final" });
    const available = await store.completeUpload(target.asset.id);
    expect(available.lifecycleStatus).toBe("AVAILABLE");
    expect(catalog.markAvailable).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual(["HeadObjectCommand", "GetObjectCommand"]);
  });

  it("rejects checksum mismatch and never marks the object AVAILABLE", async () => {
    const { store, catalog, send } = setup();
    const target = await store.createUpload({ projectId, purpose: "SCENE_VIDEO", kind: "VIDEO", mimeType: "video/mp4", extension: "mp4", byteSize: bytes.byteLength, sha256: checksum });
    send.mockImplementationOnce(async () => ({ ContentLength: bytes.byteLength, Metadata: { sha256: "0".repeat(64), "asset-id": assetId } }));
    await expect(store.completeUpload(target.asset.id)).rejects.toMatchObject({ code: "DURABLE_MEDIA_VERIFICATION_FAILED" });
    expect(catalog.markFailed).toHaveBeenCalledOnce();
    expect(catalog.markAvailable).not.toHaveBeenCalled();
  });

  it("deletes only the catalog-controlled exact key and treats cleanup as idempotent", async () => {
    const { store, catalog, send } = setup();
    await store.createUpload({ projectId, purpose: "SCENE_VIDEO", kind: "VIDEO", mimeType: "video/mp4", extension: "mp4", byteSize: bytes.byteLength, sha256: checksum });
    await store.deleteAsset(assetId);
    expect(send.mock.calls.at(-1)?.[0].constructor.name).toBe("DeleteObjectCommand");
    expect(catalog.markCleaned).toHaveBeenCalledWith(assetId);
    catalog.markCleanupPending.mockResolvedValueOnce(false);
    await store.deleteAsset(assetId);
    expect(send.mock.calls.filter(([command]) => command.constructor.name === "DeleteObjectCommand")).toHaveLength(1);
  });

  it("reconciles all retention rules before selecting exact due objects", async () => {
    const query = vi.fn(async (...args: unknown[]) => { void args; return { rows: [], rowCount: 0 }; });
    const catalog = new PostgresDurableMediaAssetCatalog({ query } as never);
    await catalog.reconcileRetention("2026-09-11T00:00:00.000Z", 7, 7, 24);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("PENDING_UPLOAD");
    expect(sql).toContain("s.status IN ('REJECTED','FAILED')");
    expect(sql).toContain("p.state='READY'");
    expect(sql).toContain("publishedRenderIds");
    expect(sql.match(/\? r\.id::text/g)).toHaveLength(2);
    expect(sql).toContain("purpose='PRODUCT_REFERENCE'");
    expect(sql).toContain("creative_references");
    expect(sql).toContain("cr.source_asset_id=a.id");
    expect(sql).toContain("SET delete_after=NULL");
    expect(sql).not.toContain("DELETE FROM media_assets");
  });

  it("excludes referenced Creative DNA source videos at selection and cleanup-claim boundaries", async () => {
    const query = vi.fn(async (...args: unknown[]) => { void args; return { rows: [], rowCount: 0 }; });
    const catalog = new PostgresDurableMediaAssetCatalog({ query } as never);
    await catalog.dueCleanup("2026-09-11T00:00:00.000Z", 50);
    await catalog.markCleanupPending(assetId);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql.match(/NOT EXISTS \(SELECT 1 FROM creative_references/g)).toHaveLength(2);
    expect(sql).toContain("cr.source_asset_id=a.id");
    expect(sql).toContain("cr.source_asset_id=media_assets.id");
  });

});
