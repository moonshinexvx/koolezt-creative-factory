import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError, VIDEO_PLAN_MOTIONS, VIDEO_PLAN_STYLES } from "@koolezt/domain";
import type { CreativeDnaRepository, CreativeProvider, FactoryRepository, SceneImageProvider, StorageProvider, VideoPlan, VideoPlanMotion, VideoPlanScene, VideoPlanStyle, VoiceProvider, WinnerJob, WinnerJobRepository, WinnerVideo, WinnerVideoBatch, WinnerVideoRepository } from "@koolezt/domain";

/** The renderer the service needs; implemented by PlanVideoRenderer in @koolezt/media. */
export interface VideoRenderer {
  probe(path: string): Promise<Readonly<{ width?: number; height?: number; durationMs?: number }>>;
  render(input: Readonly<{
    scenes: readonly Readonly<{ photoPath: string; photoWidth: number; photoHeight: number; motion: VideoPlanMotion; caption: string; durationMs: number; fullFrame?: boolean }>[];
    hookText: string; ctaText: string; voicePath: string; voiceDurationMs: number; targetDurationMs: number; style?: VideoPlanStyle;
  }>): Promise<Readonly<{ bytes: Uint8Array; durationMs: number }>>;
}

export type JobOutcome = Readonly<{ status: "COMPLETED" | "FAILED" | "PENDING"; lastError?: string; nextAttemptAt?: string }>;

const MAX_PHOTOS = 8;
const MAX_RENDER_ATTEMPTS = 4;
const SCENE_IMAGE_CONCURRENCY = 4;
/** The scene without its AI image state (status, error, and the image itself). */
const plainScene = (scene: VideoPlanScene): VideoPlanScene => ({ photoAssetId: scene.photoAssetId, motion: scene.motion, caption: scene.caption, durationMs: scene.durationMs, ...(scene.imagePrompt !== undefined ? { imagePrompt: scene.imagePrompt } : {}), ...(scene.videoPrompt !== undefined ? { videoPrompt: scene.videoPrompt } : {}) });
const generating = (video: WinnerVideo) => video.plan.scenes.some((scene) => scene.imageStatus === "GENERATING");
type Raw = Record<string, unknown>;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const words = (value: string, max: number) => value.split(" ").filter(Boolean).slice(0, max).join(" ");

/** Turns the model's plan into something the renderer can always build; photo numbers outside the list are dropped. */
export function canonicalizeVideoPlan(value: unknown, photoAssetIds: readonly string[], targetDurationMs: number, style: VideoPlanStyle = "PHOTO_MOTION"): VideoPlan | undefined {
  const raw = (value && typeof value === "object" ? value : {}) as Raw;
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).flatMap((item) => {
    const scene = (item && typeof item === "object" ? item : {}) as Raw;
    const photo = Number(scene.photo);
    const photoAssetId = Number.isInteger(photo) ? photoAssetIds[photo - 1] : undefined;
    if (!photoAssetId) return [];
    const motion = VIDEO_PLAN_MOTIONS.includes(scene.motion as VideoPlanMotion) ? scene.motion as VideoPlanMotion : "ZOOM_IN";
    const seconds = Number(scene.seconds);
    const imagePrompt = text(scene.imagePrompt, 1500);
    const videoPrompt = text(scene.videoPrompt, 1500);
    return [{ photoAssetId, motion, caption: words(text(scene.caption, 80), 9), durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3000, ...(imagePrompt ? { imagePrompt } : {}), ...(videoPrompt ? { videoPrompt } : {}) }];
  }).slice(0, 5);
  const voiceover = text(raw.voiceover, 900);
  if (scenes.length < 2 || !voiceover) return undefined;
  const planned = scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
  const scaled = scenes.map((scene) => ({ ...scene, durationMs: Math.max(1500, Math.round((scene.durationMs / planned) * targetDurationMs)) }));
  return {
    title: text(raw.title, 120) || "New video", keepsFromWinner: text(raw.keepsFromWinner, 300), changes: text(raw.changes, 300),
    hookText: words(text(raw.hookText, 60), 8), voiceover, scenes: scaled, ctaText: words(text(raw.ctaText, 40), 6), style
  };
}

const batchStyle = (batch: WinnerVideoBatch): VideoPlanStyle => VIDEO_PLAN_STYLES.includes(batch.providerMetadata.style as VideoPlanStyle) ? batch.providerMetadata.style as VideoPlanStyle : "PHOTO_MOTION";

export class WinnerVideoService {
  constructor(private readonly d: Readonly<{
    repository: FactoryRepository; dna: CreativeDnaRepository; videos: WinnerVideoRepository; jobs: WinnerJobRepository;
    provider: CreativeProvider; voice: VoiceProvider; storage: StorageProvider; renderer: VideoRenderer; sceneImages?: SceneImageProvider;
    voiceProfileId?: string; maxLoadAverage?: number; loadAverage?: () => number; now?: () => Date; id?: () => string;
  }>) {}

  private now() { return (this.d.now ?? (() => new Date()))().toISOString(); }
  private id() { return (this.d.id ?? randomUUID)(); }

  private async productPhotos(productId: string, limit = MAX_PHOTOS) {
    const product = await this.d.repository.getProduct(productId);
    return { product, photos: product.assets.filter((asset) => asset.kind === "IMAGE").slice(0, limit) };
  }

  /** Starts writing new video plans from an analyzed winner. Writing runs in the worker; it costs one AI call. */
  async requestPlans(input: Readonly<{ referenceId: string; count: 3 | 6 | 12; durationSeconds: 15 | 30; style?: VideoPlanStyle; actor: string }>): Promise<WinnerVideoBatch> {
    const reference = await this.d.dna.getReference(input.referenceId);
    const report = (await this.d.dna.listWinnerReports()).find((item) => item.creativeReferenceId === reference.id);
    if (!report || report.status !== "READY") throw new DomainError("WINNER_REPORT_REQUIRED", "Finish the winner's analysis report before making new videos from it.");
    if (!reference.productId) throw new DomainError("CREATIVE_REFERENCE_PRODUCT_REQUIRED", "Link this winner to a product first.");
    const { photos } = await this.productPhotos(reference.productId);
    if (!photos.length) throw new DomainError("PRODUCT_PHOTOS_REQUIRED", "Add at least one product photo before making videos.");
    if ((await this.d.videos.listBatches(reference.id)).some((batch) => batch.status === "WRITING")) throw new DomainError("VIDEO_PLANS_IN_PROGRESS", "Plans for this winner are already being written.");
    const now = this.now();
    const batch: WinnerVideoBatch = { id: this.id(), creativeReferenceId: reference.id, productId: reference.productId, requestedCount: input.count, targetDurationMs: input.durationSeconds === 30 ? 30_000 : 15_000, status: "WRITING", providerMetadata: { style: input.style ?? "PHOTO_MOTION" }, createdBy: input.actor, createdAt: now, updatedAt: now };
    await this.d.videos.createBatch(batch);
    await this.d.jobs.enqueue({ id: this.id(), kind: "WRITE_VIDEO_PLANS", targetId: batch.id, operationKey: `plans:${batch.id}`, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    return batch;
  }

  async writePlans(job: WinnerJob): Promise<JobOutcome> {
    const batch = await this.d.videos.getBatch(job.targetId);
    if (batch.status !== "WRITING") return { status: "COMPLETED" };
    try {
      if (!this.d.provider.planWinnerVideos) throw new DomainError("VIDEO_PLANS_UNAVAILABLE", "The AI provider cannot write video plans.");
      const reference = await this.d.dna.getReference(batch.creativeReferenceId);
      const [{ product, photos }, reports, references, links] = await Promise.all([this.productPhotos(batch.productId), this.d.dna.listWinnerReports(), this.d.dna.listReferences(), this.d.dna.listMetaLinks()]);
      const report = reports.find((item) => item.creativeReferenceId === reference.id);
      const revisions = references.find((entry) => entry.reference.id === reference.id)?.revisions ?? [];
      const dna = revisions.find((revision) => revision.id === reference.approvedRevisionId) ?? revisions.at(-1);
      const photoPayload = await Promise.all(photos.map(async (photo, index) => ({ index: index + 1, label: photo.label, mimeType: photo.mimeType, bytesBase64: Buffer.from(await this.d.storage.read(photo.storageKey)).toString("base64") })));
      const style = batchStyle(batch);
      const { plans, submission } = await this.d.provider.planWinnerVideos({
        requestedCount: batch.requestedCount, targetDurationMs: batch.targetDurationMs, style,
        product: { name: product.name, description: product.description, facts: product.claims.map((claim) => claim.text), ...(product.personalizationVisualAuthority ? { lookRules: product.personalizationVisualAuthority } : {}) },
        photos: photoPayload,
        winner: { name: reference.displayName, ...(report?.report ? { report: report.report } : {}), ...(dna ? { dna: { preserveTraits: dna.preserveTraits, safeToVaryTraits: dna.safeToVaryTraits, avoidTraits: dna.avoidTraits, openingPattern: dna.openingPattern, pacingPattern: dna.pacingPattern, ctaPattern: dna.ctaPattern } } : {}), ...(report?.measurements ? { measurements: { durationMs: report.measurements.durationMs, shotCount: report.measurements.shotCount, wordsPerMinute: report.measurements.wordsPerMinute, transcriptText: report.measurements.transcriptText } } : {}), ...(links.find((link) => link.creativeReferenceId === reference.id)?.metrics ? { metaResults: links.find((link) => link.creativeReferenceId === reference.id)!.metrics } : {}) }
      }, { operationKey: `plans:${batch.id}`, projectId: batch.productId, targetId: batch.id });
      const photoIds = photos.map((photo) => photo.id);
      const now = this.now();
      const videos: WinnerVideo[] = plans.flatMap((value) => { const plan = canonicalizeVideoPlan(value, photoIds, batch.targetDurationMs, style); return plan ? [plan] : []; }).slice(0, batch.requestedCount)
        .map((plan, index) => ({ id: this.id(), batchId: batch.id, ordinal: index + 1, plan, status: "PLANNED" as const, createdAt: now, updatedAt: now }));
      if (!videos.length) throw new DomainError("VIDEO_PLANS_INVALID", "The AI did not return any usable video plans. Try again.");
      await this.d.videos.saveVideos(videos);
      await this.d.videos.updateBatch({ ...batch, status: "READY", providerMetadata: { style, provider: submission.provider, model: submission.model, ...submission.metadata }, updatedAt: now });
      return { status: "COMPLETED" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Writing plans failed.";
      // A paid request is never repeated automatically: any failure ends this batch and the owner can start a new one.
      await this.d.videos.updateBatch({ ...batch, status: "FAILED", failureMessage: message.slice(0, 500), updatedAt: this.now() });
      return { status: "FAILED", lastError: message };
    }
  }

  /** Saves the owner's changes to a plan (photos, captions, scene order, voiceover). A made video goes back to "Plan" until it is made again. */
  async editPlan(videoId: string, plan: VideoPlan): Promise<WinnerVideo> {
    const video = await this.d.videos.getVideo(videoId);
    if (video.status === "QUEUED" || video.status === "RENDERING") throw new DomainError("VIDEO_BUSY", "This video is being made. Edit it after it finishes.");
    if (generating(video)) throw new DomainError("SCENE_IMAGES_IN_PROGRESS", "AI scene images are being made for this plan. Edit it after they finish.");
    const batch = await this.d.videos.getBatch(video.batchId);
    const { photos } = await this.productPhotos(batch.productId, Number.POSITIVE_INFINITY);
    if (plan.scenes.some((scene) => !photos.some((photo) => photo.id === scene.photoAssetId))) throw new DomainError("VIDEO_PHOTO_MISSING", "Choose each scene's photo from this product's photos.");
    const { failureMessage: _f, ...rest } = video;
    void _f;
    // Only images this plan already made may be kept; anything else falls back to the product photo.
    const known = new Set(video.plan.scenes.flatMap((scene) => scene.sceneImageAssetId ? [scene.sceneImageAssetId] : []));
    const scenes = plan.scenes.map((scene) => scene.sceneImageAssetId && known.has(scene.sceneImageAssetId) ? { ...plainScene(scene), sceneImageAssetId: scene.sceneImageAssetId, imageStatus: "READY" as const } : plainScene(scene));
    const edited: WinnerVideo = { ...rest, plan: { ...plan, scenes }, status: "PLANNED", updatedAt: this.now() };
    await this.d.videos.updateVideo(edited);
    return edited;
  }

  /** Starts making AI scene images (OpenAI, from each scene's image prompt and the main product photo). One paid image per scene; never retried automatically. */
  async requestSceneImages(videoId: string, sceneIndexes?: readonly number[]): Promise<WinnerVideo> {
    if (!this.d.sceneImages) throw new DomainError("SCENE_IMAGES_UNAVAILABLE", "AI scene images need OPENAI_API_KEY on the server.");
    const video = await this.d.videos.getVideo(videoId);
    if (video.status === "QUEUED" || video.status === "RENDERING") throw new DomainError("VIDEO_BUSY", "This video is being made. Try again after it finishes.");
    if (generating(video)) throw new DomainError("SCENE_IMAGES_IN_PROGRESS", "AI scene images are already being made for this plan.");
    const wanted = new Set(sceneIndexes?.length ? sceneIndexes : video.plan.scenes.map((_, index) => index));
    const missing = video.plan.scenes.findIndex((scene, index) => wanted.has(index) && !scene.imagePrompt?.trim());
    if (missing >= 0) throw new DomainError("SCENE_IMAGE_PROMPT_REQUIRED", `Scene ${missing + 1} has no image prompt. Add one with Edit first.`);
    if (![...wanted].some((index) => index >= 0 && index < video.plan.scenes.length)) throw new DomainError("SCENE_IMAGE_PROMPT_REQUIRED", "Choose at least one scene.");
    const scenes = video.plan.scenes.map((scene, index) => wanted.has(index) ? { ...plainScene(scene), ...(scene.sceneImageAssetId ? { sceneImageAssetId: scene.sceneImageAssetId } : {}), imageStatus: "GENERATING" as const } : scene);
    const now = this.now();
    const updated: WinnerVideo = { ...video, plan: { ...video.plan, scenes }, updatedAt: now };
    await this.d.videos.updateVideo(updated);
    await this.d.jobs.enqueue({ id: this.id(), kind: "GENERATE_SCENE_IMAGES", targetId: video.id, operationKey: `scene-images:${video.id}:${randomUUID()}`, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    return updated;
  }

  async generateSceneImages(job: WinnerJob): Promise<JobOutcome> {
    const video = await this.d.videos.getVideo(job.targetId);
    if (!generating(video)) return { status: "COMPLETED" };
    const batch = await this.d.videos.getBatch(video.batchId);
    const { photos } = await this.productPhotos(batch.productId, 1);
    const main = photos[0];
    const reference = main && this.d.sceneImages ? { bytes: await this.d.storage.read(main.storageKey), mimeType: main.mimeType } : undefined;
    const scenes = [...video.plan.scenes];
    const make = async (index: number) => {
      const scene = plainScene(scenes[index]!);
      try {
        if (!this.d.sceneImages) throw new DomainError("SCENE_IMAGES_UNAVAILABLE", "AI scene images need OPENAI_API_KEY on the server.");
        if (!reference) throw new DomainError("PRODUCT_PHOTOS_REQUIRED", "Add a main product photo first.");
        const image = await this.d.sceneImages.generate({ prompt: scene.imagePrompt ?? "", referenceImages: [reference] });
        const asset = await this.d.storage.put(`scene-images/${video.id}/${index + 1}-${randomUUID()}.${image.extension}`, { bytes: image.bytes, mimeType: image.mimeType, extension: image.extension, metadata: { projectId: batch.productId, purpose: "SCENE_IMAGE", model: image.model, originalFilename: `scene-${index + 1}.${image.extension}` } });
        scenes[index] = { ...scene, sceneImageAssetId: asset.id, imageStatus: "READY" };
      } catch (error) {
        scenes[index] = { ...scene, imageStatus: "FAILED", imageError: (error instanceof Error ? error.message : "The image could not be made.").slice(0, 300) };
      }
    };
    const pending = scenes.flatMap((scene, index) => scene.imageStatus === "GENERATING" ? [index] : []);
    for (let start = 0; start < pending.length; start += SCENE_IMAGE_CONCURRENCY) await Promise.all(pending.slice(start, start + SCENE_IMAGE_CONCURRENCY).map(make));
    await this.d.videos.updateVideo({ ...video, plan: { ...video.plan, scenes }, updatedAt: this.now() });
    const failed = scenes.filter((scene) => scene.imageStatus === "FAILED").length;
    // Paid requests are never repeated automatically; failed scenes show why and can be made again by hand.
    return failed ? { status: "FAILED", lastError: `${failed} scene image(s) failed.` } : { status: "COMPLETED" };
  }

  /** Queues the chosen plans for rendering; each video is voiced and rendered on the server one at a time. */
  async makeVideos(batchId: string, videoIds: readonly string[]): Promise<readonly WinnerVideo[]> {
    const videos = await this.d.videos.listVideos(batchId);
    const chosen = videos.filter((video) => videoIds.includes(video.id) && (video.status === "PLANNED" || video.status === "FAILED"));
    if (!chosen.length) throw new DomainError("NO_VIDEOS_SELECTED", "Choose at least one plan that hasn't been made yet.");
    if (chosen.some(generating)) throw new DomainError("SCENE_IMAGES_IN_PROGRESS", "Wait until the AI scene images are finished, then make the video.");
    const now = this.now();
    for (const video of chosen) {
      const { failureMessage: _f, ...rest } = video;
      void _f;
      await this.d.videos.updateVideo({ ...rest, status: "QUEUED", updatedAt: now });
      await this.d.jobs.enqueue({ id: this.id(), kind: "RENDER_VIDEO", targetId: video.id, operationKey: `render:${video.id}:${randomUUID()}`, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    }
    return this.d.videos.listVideos(batchId);
  }

  async renderVideo(job: WinnerJob): Promise<JobOutcome> {
    const video = await this.d.videos.getVideo(job.targetId);
    if (video.status === "READY") return { status: "COMPLETED" };
    // Rendering is CPU heavy; when the server is busy (for example the Art Generator), wait and try again.
    const load = (this.d.loadAverage ?? (() => loadavg()[0] ?? 0))();
    if (load > (this.d.maxLoadAverage ?? 2.5)) return { status: "PENDING", lastError: `Server busy (load ${load.toFixed(2)}); waiting.`, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() };
    const batch = await this.d.videos.getBatch(video.batchId);
    await this.d.videos.updateVideo({ ...video, status: "RENDERING", updatedAt: this.now() });
    const root = await mkdtemp(join(tmpdir(), "koolezt-video-job-"));
    try {
      const { product } = await this.productPhotos(batch.productId);
      const voicePath = join(root, "voice");
      const submission = await this.d.voice.submit({ voiceProfileId: this.d.voiceProfileId ?? "default", script: video.plan.voiceover }, { operationKey: `voice:${video.id}:${job.id}`, projectId: batch.productId, targetId: video.id });
      const voiceResult = await this.d.voice.getStatus(submission.providerTaskId);
      if (voiceResult.state !== "SUCCEEDED") throw new DomainError("VIDEO_VOICE_FAILED", voiceResult.state === "FAILED" ? voiceResult.message : "The voiceover is not ready.");
      const voiceFile = `${voicePath}.${voiceResult.result.extension}`;
      await writeFile(voiceFile, voiceResult.result.bytes);
      const voiceDurationMs = (await this.d.renderer.probe(voiceFile)).durationMs ?? 0;
      const scenes = [];
      for (const [index, scene] of video.plan.scenes.entries()) {
        // A finished AI scene image is used full frame; otherwise the product photo sits on its blurred copy.
        const sceneImage = scene.sceneImageAssetId && scene.imageStatus === "READY" ? await this.d.storage.getAsset(scene.sceneImageAssetId) : undefined;
        const asset = sceneImage ?? product.assets.find((item) => item.id === scene.photoAssetId);
        if (!asset) throw new DomainError("VIDEO_PHOTO_MISSING", "A product photo used by this plan was removed. Choose another photo with Edit.");
        const photoPath = join(root, `photo-${index}.${asset.mimeType.split("/")[1] ?? "jpg"}`);
        await writeFile(photoPath, await this.d.storage.read(asset.storageKey));
        const size = await this.d.renderer.probe(photoPath);
        scenes.push({ photoPath, photoWidth: size.width ?? 1080, photoHeight: size.height ?? 1080, motion: scene.motion, caption: scene.caption, durationMs: scene.durationMs, ...(sceneImage ? { fullFrame: true } : {}) });
      }
      const rendered = await this.d.renderer.render({ scenes, hookText: video.plan.hookText, ctaText: video.plan.ctaText, voicePath: voiceFile, voiceDurationMs, targetDurationMs: batch.targetDurationMs, style: video.plan.style ?? "PHOTO_MOTION" });
      const asset = await this.d.storage.put(`winner-videos/${batch.id}/${video.id}.mp4`, { bytes: rendered.bytes, mimeType: "video/mp4", extension: "mp4", metadata: { projectId: batch.productId, purpose: "WINNER_VIDEO", originalFilename: `${video.plan.title.slice(0, 80)}.mp4` } });
      await this.d.videos.updateVideo({ ...video, status: "READY", outputAssetId: asset.id, durationMs: rendered.durationMs, updatedAt: this.now() });
      return { status: "COMPLETED" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rendering failed.";
      const giveUp = error instanceof DomainError || job.attempts >= MAX_RENDER_ATTEMPTS;
      await this.d.videos.updateVideo({ ...video, status: giveUp ? "FAILED" : "QUEUED", ...(giveUp ? { failureMessage: message.slice(0, 500) } : {}), updatedAt: this.now() });
      return giveUp ? { status: "FAILED", lastError: message } : { status: "PENDING", lastError: message, nextAttemptAt: new Date(Date.now() + 30_000 * job.attempts).toISOString() };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async list(referenceId?: string) {
    const batches = await this.d.videos.listBatches(referenceId);
    return Promise.all(batches.map(async (batch) => ({ batch, videos: await this.d.videos.listVideos(batch.id) })));
  }
}

/** Runs queued jobs one at a time. Each handler records its own domain state and returns how the job ended. */
export class WinnerJobRunner {
  private running = false;
  constructor(private readonly d: Readonly<{ jobs: WinnerJobRepository; handlers: Readonly<Record<WinnerJob["kind"], (job: WinnerJob) => Promise<JobOutcome>>>; staleAfterMs?: number; now?: () => Date }>) {}

  /** Returns true when a job was processed, so the caller can loop until the queue is empty. */
  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const now = (this.d.now ?? (() => new Date()))().toISOString();
      const job = await this.d.jobs.claimNext(now, this.d.staleAfterMs ?? 20 * 60_000);
      if (!job) return false;
      let outcome: JobOutcome;
      try { outcome = await this.d.handlers[job.kind](job); }
      catch (error) { outcome = { status: "FAILED", lastError: error instanceof Error ? error.message : "Job failed." }; }
      await this.d.jobs.finish(job.id, outcome, (this.d.now ?? (() => new Date()))().toISOString());
      return true;
    } finally {
      this.running = false;
    }
  }
}
