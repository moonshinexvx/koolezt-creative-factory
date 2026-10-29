import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "@koolezt/domain";
import type {
  DurableMediaStore,
  DurableUploadTarget,
  ExternalMediaReference,
  GeneratedAsset,
  MediaInspection,
  MediaInspector,
  MediaPayload,
  ReadyFile,
  ReadyPublisher,
  StorageProvider
} from "@koolezt/domain";
import { FfprobeMediaInspector } from "./index.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const allowedExtension = /^(?:mp4|webm|mp3|wav|aac|png|jpe?g|webp)$/;
const controlledKey = /^creative-factory\/(working|final)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]+$/;

export interface DurableAssetCatalog {
  createPending(asset: GeneratedAsset, originalFilename?: string): Promise<void>;
  get(assetId: string, includeUnavailable?: boolean): Promise<GeneratedAsset | undefined>;
  markAvailable(assetId: string): Promise<void>;
  markFailed(assetId: string, safeReason: string): Promise<void>;
  reconcileRetention(now: string, rejectedGraceDays: number, readyGraceDays: number, abandonedHours: number): Promise<void>;
  dueCleanup(now: string, limit: number): Promise<readonly GeneratedAsset[]>;
  markCleanupPending(assetId: string): Promise<boolean>;
  markCleaned(assetId: string): Promise<void>;
  markCleanupFailed(assetId: string, safeReason: string): Promise<void>;
}

type S3Config = Readonly<{
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  ttlSeconds?: number;
}>;

function validateConfig(config: S3Config): void {
  if (!config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw new DomainError("DURABLE_MEDIA_CONFIGURATION_MISSING", "S3 durable media requires region, bucket, and credentials.");
  }
}

function validateExtension(extension: string): string {
  const value = extension.replace(/^\./, "").toLowerCase();
  if (!allowedExtension.test(value)) throw new DomainError("DURABLE_MEDIA_EXTENSION_INVALID", "Unsupported durable media extension.");
  return value === "jpeg" ? "jpg" : value;
}

function safeKey(key: string): string {
  if (!controlledKey.test(key)) throw new DomainError("DURABLE_MEDIA_KEY_INVALID", "Durable media key is outside the controlled namespace.");
  return key;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "$metadata" in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

/** Media owned by a Product rather than a project; the product id is used only in the storage path. */
export const PRODUCT_SCOPED_PURPOSES: ReadonlySet<string> = new Set(["PRODUCT_ASSET", "WINNER_SOURCE_VIDEO", "WINNER_VIDEO", "SCENE_IMAGE", "SCENE_VIDEO"]);

export class S3DurableMediaStore implements DurableMediaStore {
  readonly providerKey = "s3";
  private readonly client: S3Client;

  constructor(
    private readonly config: S3Config,
    private readonly catalog: DurableAssetCatalog,
    client?: S3Client,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {
    validateConfig(config);
    this.client = client ?? new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED"
    });
  }

  async createUpload(input: Parameters<DurableMediaStore["createUpload"]>[0]): Promise<DurableUploadTarget> {
    if (!/^[0-9a-f-]{36}$/i.test(input.projectId)) throw new DomainError("DURABLE_MEDIA_PROJECT_INVALID", "A valid project identity is required.");
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) throw new DomainError("DURABLE_MEDIA_SIZE_INVALID", "Upload size must be positive.");
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new DomainError("DURABLE_MEDIA_CHECKSUM_INVALID", "Upload SHA-256 is invalid.");
    const extension = validateExtension(input.extension);
    const assetId = this.id();
    const namespace = input.namespace ?? (input.kind === "RENDER" ? "final" : "working");
    const key = safeKey(`creative-factory/${namespace}/${input.projectId}/${assetId}/${this.id()}.${extension}`);
    const createdAt = this.now().toISOString();
    const asset: GeneratedAsset = {
      id: assetId,
      kind: input.kind,
      storageKey: key,
      storageProvider: "s3",
      storageBucket: this.config.bucket,
      ...(PRODUCT_SCOPED_PURPOSES.has(input.purpose) ? {} : { projectId: input.projectId }),
      purpose: input.purpose,
      lifecycleStatus: "PENDING_UPLOAD",
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      metadata: { ...(input.metadata ?? {}), purpose: input.purpose },
      createdAt
    };
    await this.catalog.createPending(asset, input.originalFilename);
    return this.getUploadTarget(asset.id);
  }

  async getUploadTarget(assetId: string): Promise<DurableUploadTarget> {
    const asset = await this.catalog.get(assetId, true);
    if (!asset || asset.storageProvider !== "s3") throw new DomainError("ASSET_NOT_FOUND", "Durable upload claim was not found.");
    if (!["PENDING_UPLOAD", "FAILED"].includes(asset.lifecycleStatus ?? "")) {
      throw new DomainError("DURABLE_MEDIA_UPLOAD_LOCKED", "This durable upload is no longer writable.");
    }
    const ttl = this.config.ttlSeconds ?? 900;
    const headers = {
      "content-type": asset.mimeType,
      "x-amz-meta-asset-id": asset.id,
      "x-amz-meta-sha256": asset.sha256
    };
    const url = await getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: safeKey(asset.storageKey),
      ContentType: asset.mimeType,
      Metadata: { "asset-id": asset.id, sha256: asset.sha256 }
    }), { expiresIn: ttl, unhoistableHeaders: new Set(["x-amz-meta-asset-id", "x-amz-meta-sha256"]) });
    return { asset, method: "PUT", url, headers, expiresAt: new Date(this.now().getTime() + ttl * 1000).toISOString() };
  }

  async completeUpload(assetId: string): Promise<GeneratedAsset> {
    const pending = await this.catalog.get(assetId, true);
    if (!pending) throw new DomainError("ASSET_NOT_FOUND", "Durable media asset was not found.");
    if (pending.storageProvider !== "s3") throw new DomainError("DURABLE_MEDIA_PROVIDER_MISMATCH", "Asset is not stored by the S3 durable store.");
    if (pending.lifecycleStatus === "AVAILABLE") return pending;
    safeKey(pending.storageKey);
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: pending.storageKey }));
      const authoritativeBytes = await this.read(pending.storageKey);
      if (Number(head.ContentLength ?? -1) !== pending.byteSize || authoritativeBytes.byteLength !== pending.byteSize || digest(authoritativeBytes) !== pending.sha256 || head.Metadata?.sha256 !== pending.sha256 || head.Metadata?.["asset-id"] !== pending.id) {
        await this.catalog.markFailed(assetId, "Object size or checksum metadata mismatch.");
        throw new DomainError("DURABLE_MEDIA_VERIFICATION_FAILED", "Uploaded object does not match its durable asset claim.");
      }
      await this.catalog.markAvailable(assetId);
      return (await this.catalog.get(assetId))!;
    } catch (error) {
      if (isNotFound(error)) throw new DomainError("DURABLE_MEDIA_UPLOAD_INCOMPLETE", "Uploaded object is not available yet.");
      throw error;
    }
  }

  async put(_requestedKey: string, payload: MediaPayload): Promise<GeneratedAsset> {
    const projectId = String(payload.metadata.projectId ?? "");
    const kind: GeneratedAsset["kind"] = payload.mimeType.startsWith("image/")
      ? "IMAGE"
      : payload.mimeType.startsWith("audio/")
        ? "AUDIO"
        : payload.metadata.purpose === "FINAL_RENDER"
          ? "RENDER"
          : "VIDEO";
    const target = await this.createUpload({
      projectId,
      purpose: String(payload.metadata.purpose ?? (kind === "AUDIO" ? "VOICE" : kind === "RENDER" ? "FINAL_RENDER" : "GENERATED_MEDIA")),
      kind,
      mimeType: payload.mimeType,
      extension: payload.extension,
      byteSize: payload.bytes.byteLength,
      sha256: digest(payload.bytes),
      namespace: kind === "RENDER" ? "final" : "working",
      metadata: payload.metadata
    });
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: target.asset.storageKey,
        Body: payload.bytes,
        ContentType: payload.mimeType,
        Metadata: { "asset-id": target.asset.id, sha256: target.asset.sha256 }
      }));
      return await this.completeUpload(target.asset.id);
    } catch (error) {
      await this.catalog.markFailed(target.asset.id, error instanceof DomainError ? error.code : "S3 durable upload failed.");
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: safeKey(key) }));
    if (!result.Body) throw new DomainError("DURABLE_MEDIA_READ_FAILED", "Durable media object returned no body.");
    return result.Body.transformToByteArray();
  }

  async getAsset(assetId: string): Promise<GeneratedAsset> {
    const asset = await this.catalog.get(assetId);
    if (!asset) throw new DomainError("ASSET_NOT_FOUND", `Generated asset ${assetId} was not found or is no longer available.`);
    return asset;
  }

  async rejectUpload(assetId: string, safeReason: string): Promise<void> {
    await this.catalog.markFailed(assetId, safeReason);
  }

  async getDownloadReference(assetId: string, options?: Readonly<{ downloadFilename?: string }>): Promise<ExternalMediaReference> {
    const asset = await this.getAsset(assetId);
    const ttl = this.config.ttlSeconds ?? 900;
    const downloadFilename = options?.downloadFilename?.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
    return {
      url: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: safeKey(asset.storageKey), ...(downloadFilename ? { ResponseContentType: "video/mp4", ResponseContentDisposition: `attachment; filename="${downloadFilename}"` } : {}) }), { expiresIn: ttl }),
      expiresAt: new Date(this.now().getTime() + ttl * 1000).toISOString(),
      contentType: asset.mimeType,
      size: asset.byteSize
    };
  }

  async deleteAsset(assetId: string): Promise<void> {
    const asset = await this.catalog.get(assetId, true);
    if (!asset) return;
    if (asset.storageProvider !== "s3") throw new DomainError("DURABLE_MEDIA_PROVIDER_MISMATCH", "Cleanup may only delete S3 durable media.");
    if (!(await this.catalog.markCleanupPending(assetId))) return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: safeKey(asset.storageKey) }));
      await this.catalog.markCleaned(assetId);
    } catch (error) {
      await this.catalog.markCleanupFailed(assetId, error instanceof Error ? error.name : "S3 delete failed.");
      throw error;
    }
  }

  async runDueCleanup(input: Readonly<{ rejectedGraceDays?: number; readyGraceDays?: number; abandonedHours?: number; limit?: number }> = {}): Promise<number> {
    const now = this.now().toISOString();
    await this.catalog.reconcileRetention(now, input.rejectedGraceDays ?? 7, input.readyGraceDays ?? 7, input.abandonedHours ?? 24);
    const due = await this.catalog.dueCleanup(now, input.limit ?? 50);
    for (const asset of due) await this.deleteAsset(asset.id);
    return due.length;
  }
}

/** Routes new writes to S3 while retaining read compatibility for legacy local keys. */
export class HybridDurableMediaStore implements DurableMediaStore {
  readonly providerKey = "s3";
  constructor(private readonly s3: S3DurableMediaStore, private readonly local: StorageProvider) {}
  put(key: string, payload: MediaPayload): Promise<GeneratedAsset> { return this.s3.put(key, payload); }
  read(key: string): Promise<Uint8Array> { return key.startsWith("creative-factory/") ? this.s3.read(key) : this.local.read(key); }
  getAsset(assetId: string): Promise<GeneratedAsset> { return this.s3.getAsset(assetId); }
  createUpload(input: Parameters<DurableMediaStore["createUpload"]>[0]): Promise<DurableUploadTarget> { return this.s3.createUpload(input); }
  getUploadTarget(assetId: string): Promise<DurableUploadTarget> { return this.s3.getUploadTarget(assetId); }
  completeUpload(assetId: string): Promise<GeneratedAsset> { return this.s3.completeUpload(assetId); }
  rejectUpload(assetId: string, safeReason: string): Promise<void> { return this.s3.rejectUpload(assetId, safeReason); }
  async getDownloadReference(assetId: string, options?: Readonly<{ downloadFilename?: string }>): Promise<ExternalMediaReference> {
    const asset = await this.getAsset(assetId);
    if (asset.storageProvider !== "s3") throw new DomainError("DIRECT_DOWNLOAD_UNAVAILABLE", "Legacy local media uses the authenticated proxy endpoint.");
    return this.s3.getDownloadReference(assetId, options);
  }
  deleteAsset(assetId: string): Promise<void> { return this.s3.deleteAsset(assetId); }
  runDueCleanup(input?: Parameters<S3DurableMediaStore["runDueCleanup"]>[0]): Promise<number> { return this.s3.runDueCleanup(input); }
}

export class StorageBackedMediaInspector implements MediaInspector {
  constructor(
    private readonly storage: DurableMediaStore,
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
  ) {}

  private async inspectWith<T>(asset: GeneratedAsset, operation: (inspector: FfprobeMediaInspector, local: GeneratedAsset) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "koolezt-media-qa-"));
    const extension = extname(asset.storageKey) || ".bin";
    const localKey = `asset${extension}`;
    try {
      await writeFile(join(root, localKey), await this.storage.read(asset.storageKey));
      return await operation(new FfprobeMediaInspector(root, this.ffprobePath), { ...asset, storageKey: localKey });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  inspect(asset: GeneratedAsset, expectation: Parameters<MediaInspector["inspect"]>[1]): Promise<MediaInspection> {
    return this.inspectWith(asset, (inspector, local) => inspector.inspect(local, expectation));
  }

  inspectAudio(asset: GeneratedAsset, expectation: Parameters<MediaInspector["inspectAudio"]>[1]): Promise<MediaInspection> {
    return this.inspectWith(asset, (inspector, local) => inspector.inspectAudio(local, expectation));
  }

  inspectVideo(asset: GeneratedAsset, expectation: Parameters<MediaInspector["inspectVideo"]>[1]): Promise<MediaInspection> {
    return this.inspectWith(asset, (inspector, local) => inspector.inspectVideo(local, expectation));
  }
}

/** READY is a checksum-bound logical promotion for an already durable final object. */
export class DurableReadyPublisher implements ReadyPublisher {
  constructor(private readonly storage: DurableMediaStore, private readonly now: () => Date = () => new Date()) {}
  async publish(input: Parameters<ReadyPublisher["publish"]>[0]): Promise<ReadyFile> {
    if (input.source.sha256 !== input.approvedSha256) throw new DomainError("RENDER_CHECKSUM_CHANGED", "The selected render no longer matches the approved checksum.");
    const source = await this.storage.getAsset(input.source.id);
    if (source.kind !== "RENDER" || source.storageProvider !== this.storage.providerKey) throw new DomainError("READY_ASSET_INVALID", "READY requires a durable final render asset.");
    return {
      path: `asset:${source.id}`,
      assetId: source.id,
      storageProvider: source.storageProvider,
      storageKey: source.storageKey,
      sha256: source.sha256,
      byteSize: source.byteSize,
      publishedAt: this.now().toISOString()
    };
  }
}
