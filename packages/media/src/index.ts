import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  open,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { DomainError } from "@koolezt/domain";
import type {
  GeneratedAsset,
  CompositionOutput,
  CompositionOutputIngestor,
  ExternalMediaDeliveryProvider,
  ExternalMediaReference,
  MediaInspection,
  MediaInspector,
  MediaPayload,
  ReadyFile,
  ReadyPublisher,
  StorageProvider,
  VideoOutputIngestor
} from "@koolezt/domain";
export { CREATIVE_DNA_SCENE_THRESHOLD, FfmpegCreativeDnaPreprocessor, creativeDnaPacing, creativeDnaSampleTimestamps, MAX_CREATIVE_DNA_FRAMES, parseAudioLevels, parseSceneCuts } from "./creative-dna-preprocessor.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containedPath(root: string, key: string): string {
  // Reject rooted paths in either supported host syntax. A Windows drive path
  // must not become a harmless-looking relative filename when this runs on Linux.
  if (isAbsolute(key) || win32.isAbsolute(key) || key.includes("\0")) {
    throw new DomainError("UNSAFE_STORAGE_KEY", "Storage key must be a safe relative path.");
  }
  const normalizedRoot = resolve(root);
  const destination = resolve(normalizedRoot, key);
  const rel = relative(normalizedRoot, destination);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DomainError("PATH_TRAVERSAL", "Resolved path escapes the configured storage root.");
  }
  return destination;
}

function sanitizeSegment(value: string): string {
  const clean = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 80);
  return clean || "creative";
}

export class LocalStorageProvider implements StorageProvider {
  private readonly assets = new Map<string, GeneratedAsset>();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly catalog?: Readonly<{
      save(asset: GeneratedAsset): Promise<void>;
      get(assetId: string): Promise<GeneratedAsset | undefined>;
    }>
  ) {}

  async put(key: string, payload: MediaPayload): Promise<GeneratedAsset> {
    const destination = containedPath(this.root, key);
    const expectedExtension = `.${payload.extension.replace(/^\./, "").toLowerCase()}`;
    if (extname(destination).toLowerCase() !== expectedExtension) {
      throw new DomainError("EXTENSION_MISMATCH", "Storage key extension does not match payload.");
    }
    await mkdir(resolve(destination, ".."), { recursive: true });
    const temporary = `${destination}.partial-${this.id()}`;
    await writeFile(temporary, payload.bytes, { flag: "wx" });
    await rename(temporary, destination);
    const asset: GeneratedAsset = {
      id: this.id(),
      kind: payload.mimeType.startsWith("image/")
        ? "IMAGE"
        : payload.mimeType.startsWith("audio/")
        ? "AUDIO"
        : key.includes("/renders/")
          ? "RENDER"
          : "VIDEO",
      storageKey: key,
      mimeType: payload.mimeType,
      byteSize: payload.bytes.byteLength,
      sha256: sha256(payload.bytes),
      metadata: payload.metadata,
      createdAt: this.now().toISOString()
    };
    this.assets.set(asset.id, asset);
    await this.catalog?.save(asset);
    return structuredClone(asset);
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(containedPath(this.root, key));
  }

  async getAsset(assetId: string): Promise<GeneratedAsset> {
    const asset = this.assets.get(assetId);
    const persisted = asset ?? (await this.catalog?.get(assetId));
    if (!persisted) {
      throw new DomainError("ASSET_NOT_FOUND", `Generated asset ${assetId} was not found.`);
    }
    return structuredClone(persisted);
  }

  absolutePath(key: string): string {
    return containedPath(this.root, key);
  }
}

type FfprobeFormat = Readonly<{
  format?: Readonly<{ duration?: string }>;
  streams?: readonly Readonly<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }> [];
}>;

export class FfprobeMediaInspector implements MediaInspector {
  async inspectVideo(asset: GeneratedAsset, expectation: Readonly<{ expectedDurationMs: number; toleranceMs: number }>): Promise<MediaInspection> {
    const filePath = containedPath(this.storageRoot, asset.storageKey); let fileStat;
    try { fileStat = await stat(filePath); } catch { return this.failed(asset.byteSize, { exists: false }); }
    if (!fileStat.isFile() || fileStat.size === 0) return this.failed(fileStat.size, { exists: true, nonEmpty: false });
    let probe: FfprobeFormat; try { probe = JSON.parse(await this.runFfprobe(filePath)) as FfprobeFormat; } catch (error) { if (error instanceof DomainError) throw error; return this.failed(fileStat.size, { exists: true, nonEmpty: true, parseable: false }); }
    const video = probe.streams?.find((stream) => stream.codec_type === "video"); const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1_000); const width = video?.width ?? 0; const height = video?.height ?? 0;
    const rules = { exists: true, nonEmpty: fileStat.size > 0, parseable: true, hasVideo: Boolean(video), positiveDuration: durationMs > 0, durationWithinTolerance: Math.abs(durationMs - expectation.expectedDurationMs) <= expectation.toleranceMs, dimensionsAvailable: width > 0 && height > 0, videoCodecAvailable: Boolean(video?.codec_name) };
    return { passed: Object.values(rules).every(Boolean), width, height, durationMs, videoCodec: video?.codec_name ?? "", ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}), hasVideo: Boolean(video), hasAudio: Boolean(audio), byteSize: fileStat.size, rules };
  }
  async inspectAudio(asset: GeneratedAsset, expectation: Readonly<{ maxDurationMs: number }>): Promise<MediaInspection> {
    const filePath = containedPath(this.storageRoot, asset.storageKey); let fileStat;
    try { fileStat = await stat(filePath); } catch { return this.failed(asset.byteSize, { exists: false }); }
    if (!fileStat.isFile() || fileStat.size === 0) return this.failed(fileStat.size, { exists: true, nonEmpty: false });
    let probe: FfprobeFormat; try { probe = JSON.parse(await this.runFfprobe(filePath)) as FfprobeFormat; } catch (error) { if (error instanceof DomainError) throw error; return this.failed(fileStat.size, { exists: true, nonEmpty: true, parseable: false }); }
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio"); const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1_000);
    const rules = { exists: true, nonEmpty: fileStat.size > 0, parseable: true, hasAudio: Boolean(audio), positiveDuration: durationMs > 0, durationWithinLimit: durationMs <= expectation.maxDurationMs, audioCodecAvailable: Boolean(audio?.codec_name) };
    return { passed: Object.values(rules).every(Boolean), width: 0, height: 0, durationMs, videoCodec: "", ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}), hasVideo: false, hasAudio: Boolean(audio), byteSize: fileStat.size, rules };
  }
  constructor(
    private readonly storageRoot: string,
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
  ) {}

  async inspect(
    asset: GeneratedAsset,
    expectation: Readonly<{
      width: number;
      height: number;
      durationMs: number;
      requireAudio: boolean;
    }>
  ): Promise<MediaInspection> {
    const filePath = containedPath(this.storageRoot, asset.storageKey);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return this.failed(asset.byteSize, { exists: false });
    }
    if (!fileStat.isFile() || fileStat.size === 0) {
      return this.failed(fileStat.size, { exists: true, nonEmpty: false });
    }
    let probe: FfprobeFormat;
    try {
      probe = JSON.parse(await this.runFfprobe(filePath)) as FfprobeFormat;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return this.failed(fileStat.size, { exists: true, nonEmpty: true, parseable: false });
    }
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const width = video?.width ?? 0;
    const height = video?.height ?? 0;
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1_000);
    const rules = {
      exists: true,
      nonEmpty: fileStat.size > 0,
      parseable: true,
      hasVideo: Boolean(video),
      hasExpectedAudio: !expectation.requireAudio || Boolean(audio),
      width: width === expectation.width,
      height: height === expectation.height,
      duration: Math.abs(durationMs - expectation.durationMs) <= 1_000,
      videoCodec: video?.codec_name === "h264"
    };
    return {
      passed: Object.values(rules).every(Boolean),
      width,
      height,
      durationMs,
      videoCodec: video?.codec_name ?? "",
      ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      byteSize: fileStat.size,
      rules
    };
  }

  private async runFfprobe(filePath: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        this.ffprobePath,
        [
          "-v", "error",
          "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
          "-of", "json",
          filePath
        ],
        { shell: false, windowsHide: true }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(new DomainError("FFPROBE_UNAVAILABLE", "ffprobe is not installed or FFPROBE_PATH is invalid."));
          return;
        }
        reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) resolvePromise(stdout);
        else reject(new Error(stderr || `ffprobe exited with code ${code ?? "unknown"}.`));
      });
    });
  }

  private failed(byteSize: number, extra: Readonly<Record<string, boolean>>): MediaInspection {
    return {
      passed: false,
      width: 0,
      height: 0,
      durationMs: 0,
      videoCodec: "",
      hasVideo: false,
      hasAudio: false,
      byteSize,
      rules: extra
    };
  }
}

export class MetadataMediaInspector implements MediaInspector {
  async inspectVideo(asset: GeneratedAsset, expectation: Readonly<{ expectedDurationMs: number; toleranceMs: number }>): Promise<MediaInspection> { const durationMs = Number(asset.metadata.durationMs ?? expectation.expectedDurationMs); const width = Number(asset.metadata.width ?? 1080); const height = Number(asset.metadata.height ?? 1920); const hasVideo = asset.metadata.hasVideo !== false; const videoCodec = String(asset.metadata.videoCodec ?? "fake"); const hasAudio = asset.metadata.hasAudio === true; const rules = { nonEmpty: asset.byteSize > 0, hasVideo, positiveDuration: durationMs > 0, durationWithinTolerance: Math.abs(durationMs - expectation.expectedDurationMs) <= expectation.toleranceMs, dimensionsAvailable: width > 0 && height > 0, videoCodecAvailable: Boolean(videoCodec) }; return { passed: Object.values(rules).every(Boolean), width, height, durationMs, videoCodec, hasVideo, hasAudio, byteSize: asset.byteSize, rules }; }
  async inspectAudio(asset: GeneratedAsset, expectation: Readonly<{ maxDurationMs: number }>): Promise<MediaInspection> { const durationMs = Number(asset.metadata.durationMs ?? 1); const hasAudio = asset.metadata.hasAudio !== false; return { passed: asset.byteSize > 0 && hasAudio && durationMs > 0 && durationMs <= expectation.maxDurationMs, width: 0, height: 0, durationMs, videoCodec: "", audioCodec: String(asset.metadata.audioCodec ?? "fake"), hasVideo: false, hasAudio, byteSize: asset.byteSize, rules: { nonEmpty: asset.byteSize > 0, hasAudio, positiveDuration: durationMs > 0, durationWithinLimit: durationMs <= expectation.maxDurationMs } }; }
  async inspect(
    asset: GeneratedAsset,
    expectation: Readonly<{
      width: number;
      height: number;
      durationMs: number;
      requireAudio: boolean;
    }>
  ): Promise<MediaInspection> {
    const width = Number(asset.metadata.width ?? 0);
    const height = Number(asset.metadata.height ?? 0);
    const durationMs = Number(asset.metadata.durationMs ?? 0);
    const hasVideo = asset.metadata.hasVideo === true;
    const hasAudio = asset.metadata.hasAudio === true;
    const videoCodec = String(asset.metadata.videoCodec ?? "");
    const audioCodec = asset.metadata.audioCodec
      ? String(asset.metadata.audioCodec)
      : undefined;
    const rules = {
      nonEmpty: asset.byteSize > 0,
      hasVideo,
      hasExpectedAudio: !expectation.requireAudio || hasAudio,
      width: width === expectation.width,
      height: height === expectation.height,
      duration: Math.abs(durationMs - expectation.durationMs) <= 1_000,
      videoCodec: videoCodec === "h264"
    };
    return {
      passed: Object.values(rules).every(Boolean),
      width,
      height,
      durationMs,
      videoCodec,
      ...(audioCodec ? { audioCodec } : {}),
      hasVideo,
      hasAudio,
      byteSize: asset.byteSize,
      rules
    };
  }
}

export class LocalReadyPublisher implements ReadyPublisher {
  constructor(
    private readonly readyRoot: string,
    private readonly storage: StorageProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {}

  async publish(input: Readonly<{
    source: GeneratedAsset;
    productSlug: string;
    projectPublicId: string;
    approvedSha256: string;
  }>): Promise<ReadyFile> {
    if (input.source.sha256 !== input.approvedSha256) {
      throw new DomainError(
        "RENDER_CHECKSUM_CHANGED",
        "The selected render no longer matches the approved checksum."
      );
    }

    const date = this.now().toISOString().slice(0, 10);
    const filename = `${sanitizeSegment(input.productSlug)}_${sanitizeSegment(input.projectPublicId)}.mp4`;
    const destination = containedPath(this.readyRoot, join(date, filename));
    await mkdir(resolve(destination, ".."), { recursive: true });
    const bytes = await this.storage.read(input.source.storageKey);
    const copiedHash = sha256(bytes);
    if (copiedHash !== input.approvedSha256) {
      throw new DomainError("READY_COPY_CHECKSUM_FAILED", "READY copy checksum validation failed.");
    }

    try {
      await access(destination, constants.F_OK);
      const existing = await readFile(destination);
      if (sha256(existing) !== copiedHash) {
        throw new DomainError(
          "READY_FILENAME_CONFLICT",
          "READY destination already exists with different content."
        );
      }
      const existingStat = await stat(destination);
      return {
        path: destination,
        sha256: copiedHash,
        byteSize: existingStat.size,
        publishedAt: this.now().toISOString()
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
    }

    const temporary = join(
      resolve(destination, ".."),
      `.${filename}.partial-${sanitizeSegment(this.id())}`
    );
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    return {
      path: destination,
      sha256: copiedHash,
      byteSize: bytes.byteLength,
      publishedAt: this.now().toISOString()
    };
  }
}

export const mediaSecurity = {
  containedPath,
  sanitizeSegment
};

/** Zero-network delivery implementation for local development and automated tests. */
export class FakeExternalMediaDeliveryProvider implements ExternalMediaDeliveryProvider {
  readonly staged: Array<Readonly<{ projectId: string; operationId: string; assetId: string }>> = [];
  readonly cleanedOperationIds: string[] = [];
  async stage(input: Readonly<{ projectId: string; operationId: string; asset: GeneratedAsset; storage: StorageProvider }>): Promise<ExternalMediaReference> {
    this.staged.push({ projectId: input.projectId, operationId: input.operationId, assetId: input.asset.id });
    return { url: `fake-media://${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.operationId)}/${encodeURIComponent(input.asset.id)}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), contentType: input.asset.mimeType, size: input.asset.byteSize };
  }
  async cleanup(operationId: string): Promise<void> { this.cleanedOperationIds.push(operationId); }
}

/** Rejects arbitrary remote data; real adapters may only emit trusted output objects. */
export class InlineCompositionOutputIngestor implements CompositionOutputIngestor, VideoOutputIngestor {
  async ingest(output: CompositionOutput): Promise<MediaPayload> {
    if (output.kind !== "INLINE") throw new DomainError("UNTRUSTED_COMPOSITION_OUTPUT", "A remote composition output requires its configured trusted ingestor.");
    return output.payload;
  }
}
export { S3ExternalMediaDeliveryProvider } from "./external-media-delivery.js";
export { DurableReadyPublisher, S3DurableMediaStore, StorageBackedMediaInspector } from "./durable-media.js";
export type { DurableAssetCatalog } from "./durable-media.js";
export { HybridDurableMediaStore } from "./durable-media.js";
export { buildPlanVideoArguments, defaultRenderFontPath, filterPath, foregroundBox, planTimeline, PlanVideoRenderer, wrapText } from "./plan-video-renderer.js";
export type { PlanRenderInput, PlanRenderScene } from "./plan-video-renderer.js";
