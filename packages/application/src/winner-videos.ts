import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError, HOOK_TYPES, MUSIC_MOODS, REVIEW_CHECKS, sceneImagePrompt, VIDEO_CAPTION_STYLES, VIDEO_FORMATS, VIDEO_PLAN_MOTIONS, VIDEO_PLAN_STYLES, VIDEO_TRANSITIONS, VOICE_NAMES } from "@koolezt/domain";
import type { CreativeBrief, CreativeDnaRepository, CreativeProvider, FactoryRepository, SceneImageProvider, StorageProvider, VideoCaptionStyle, VideoPlan, VideoPlanInput, VideoPlanMotion, VideoPlanScene, VideoPlanStyle, VideoTransition, VoiceProvider, WinnerJob, WinnerJobRepository, WinnerVideo, WinnerVideoBatch, WinnerVideoRepository } from "@koolezt/domain";

/** The renderer the service needs; implemented by PlanVideoRenderer in @koolezt/media. */
export interface VideoRenderer {
  probe(path: string): Promise<Readonly<{ width?: number; height?: number; durationMs?: number }>>;
  render(input: Readonly<{
    scenes: readonly Readonly<{ photoPath: string; photoWidth: number; photoHeight: number; motion: VideoPlanMotion; caption: string; durationMs: number; fullFrame?: boolean; transition?: VideoTransition; clip?: Readonly<{ startMs: number }> }>[];
    hookText: string; ctaText: string; voicePath: string; voiceDurationMs: number; targetDurationMs: number; style?: VideoPlanStyle;
    captionStyle?: VideoCaptionStyle; musicPath?: string;
  }>): Promise<Readonly<{ bytes: Uint8Array; durationMs: number }>>;
}

export type JobOutcome = Readonly<{ status: "COMPLETED" | "FAILED" | "PENDING"; lastError?: string; nextAttemptAt?: string }>;

const MAX_PHOTOS = 12;
const MAX_RENDER_ATTEMPTS = 4;
const SCENE_IMAGE_CONCURRENCY = 4;
/** The scene without its AI image state (status, error, and the image itself). */
const plainScene = (scene: VideoPlanScene): VideoPlanScene => {
  const { sceneImageAssetId: _a, imageStatus: _s, imageError: _e, ...rest } = scene;
  void _a; void _s; void _e;
  return rest;
};
const generating = (video: WinnerVideo) => video.plan.scenes.some((scene) => scene.imageStatus === "GENERATING");
type Raw = Record<string, unknown>;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const words = (value: string, max: number) => value.split(" ").filter(Boolean).slice(0, max).join(" ");
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.includes(value as T) ? value as T : undefined;
const asRaw = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Raw;
const MAX_SCENES = 7;
const MIN_SCENE_MS = 1000;

/** Optional creative fields of a scene (shot, spoken line, transition, prompts), shared by model output and owner edits. */
function sceneExtras(scene: Raw): Partial<VideoPlanScene> {
  const imagePrompt = text(scene.imagePrompt, 1500);
  const videoPrompt = text(scene.videoPrompt, 1500);
  const shotType = text(scene.shotType, 60);
  const voiceLine = text(scene.voiceLine, 300);
  const transition = oneOf(VIDEO_TRANSITIONS, scene.transition);
  return { ...(imagePrompt ? { imagePrompt } : {}), ...(videoPrompt ? { videoPrompt } : {}), ...(shotType ? { shotType } : {}), ...(voiceLine ? { voiceLine } : {}), ...(transition ? { transition } : {}) };
}

/** Optional creative fields of a plan (format, angle, hook type, caption style, music, voice, review). */
function planExtras(raw: Raw): Partial<VideoPlan> {
  const angle = text(raw.angle, 120);
  const format = oneOf(VIDEO_FORMATS, raw.format);
  const hookType = oneOf(HOOK_TYPES, raw.hookType);
  const captionStyle = oneOf(VIDEO_CAPTION_STYLES, raw.captionStyle);
  const musicMood = oneOf(MUSIC_MOODS, raw.musicMood);
  const voice = oneOf(VOICE_NAMES, typeof raw.voice === "string" ? raw.voice.toLowerCase() : raw.voice);
  const voiceStyle = text(raw.voiceStyle, 200);
  const review = asRaw(raw.review);
  const checkValues = asRaw(review.checks);
  const checks = Object.fromEntries(REVIEW_CHECKS.flatMap((check) => {
    const value = text(checkValues[check], 20).toUpperCase();
    return ["STRONG", "OK", "WEAK", "VERIFIED", "FIXED"].includes(value) ? [[check, value]] : [];
  }));
  const changed = text(review.changed, 300);
  const watchOut = text(review.watchOut, 300);
  return {
    ...(angle ? { angle } : {}), ...(format ? { format } : {}), ...(hookType ? { hookType } : {}), ...(captionStyle ? { captionStyle } : {}),
    ...(musicMood ? { musicMood } : {}), ...(voice ? { voice } : {}), ...(voiceStyle ? { voiceStyle } : {}),
    ...(Object.keys(checks).length || changed || watchOut ? { review: { checks, changed, watchOut } } : {})
  };
}

/** Turns the model's script into something the renderer can always build; photo numbers outside the list are dropped. */
export function canonicalizeVideoPlan(value: unknown, photoAssetIds: readonly string[], targetDurationMs: number, style: VideoPlanStyle = "PHOTO_MOTION"): VideoPlan | undefined {
  const raw = asRaw(value);
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).flatMap((item) => {
    const scene = asRaw(item);
    const photo = Number(scene.photo);
    // A shot without a usable photo number falls back to the main photo; AI scene images replace it later anyway.
    const photoAssetId = (Number.isInteger(photo) ? photoAssetIds[photo - 1] : undefined) ?? photoAssetIds[0];
    if (!photoAssetId) return [];
    const motion = oneOf(VIDEO_PLAN_MOTIONS, scene.motion) ?? "ZOOM_IN";
    const seconds = Number(scene.seconds);
    return [{ photoAssetId, motion, caption: words(text(scene.caption, 80), 9), durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3000, ...sceneExtras(scene) }];
  }).slice(0, MAX_SCENES);
  const voiceover = text(raw.voiceover, 900) || text(scenes.map((scene) => scene.voiceLine ?? "").join(" "), 900);
  if (scenes.length < 2 || !voiceover) return undefined;
  const planned = scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
  const scaled = scenes.map((scene) => ({ ...scene, durationMs: Math.max(MIN_SCENE_MS, Math.round((scene.durationMs / planned) * targetDurationMs)) }));
  // Rounding leftovers go to the last scene so the lengths add up to the target exactly.
  const rest = targetDurationMs - scaled.slice(0, -1).reduce((sum, scene) => sum + scene.durationMs, 0);
  if (rest >= MIN_SCENE_MS) scaled[scaled.length - 1] = { ...scaled[scaled.length - 1]!, durationMs: rest };
  return {
    title: text(raw.title, 120) || "New video", keepsFromWinner: text(raw.keepsFromWinner, 300), changes: text(raw.changes, 300),
    hookText: words(text(raw.hookText, 60), 8), voiceover, scenes: scaled, ctaText: words(text(raw.ctaText, 40), 6), style, ...planExtras(raw)
  };
}

/** Validates a plan edited by the owner. Core fields are required; creative fields are kept when valid. */
export function normalizeEditedPlan(value: unknown): VideoPlan {
  const raw = asRaw(value);
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).map((item) => {
    const scene = asRaw(item);
    const motion = oneOf(VIDEO_PLAN_MOTIONS, scene.motion);
    const durationMs = Number(scene.durationMs);
    if (typeof scene.photoAssetId !== "string" || !motion || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 15_000) throw new DomainError("VIDEO_PLAN_INVALID", "Each scene needs a photo, a motion and a length between 1 and 15 seconds.");
    const sceneImageAssetId = typeof scene.sceneImageAssetId === "string" ? scene.sceneImageAssetId : undefined;
    const sceneVideoAssetId = typeof scene.sceneVideoAssetId === "string" ? scene.sceneVideoAssetId : undefined;
    const videoDurationMs = Number(scene.videoDurationMs);
    const videoStartMs = Math.max(0, Math.min(Number.isFinite(videoDurationMs) ? videoDurationMs : 600_000, Math.round(Number(scene.videoStartMs) || 0)));
    return {
      photoAssetId: scene.photoAssetId, motion, caption: text(scene.caption, 80), durationMs, ...sceneExtras(scene), ...(sceneImageAssetId ? { sceneImageAssetId } : {}),
      ...(sceneVideoAssetId ? { sceneVideoAssetId, videoStartMs, ...(Number.isFinite(videoDurationMs) && videoDurationMs > 0 ? { videoDurationMs: Math.round(videoDurationMs) } : {}) } : {})
    };
  });
  const title = text(raw.title, 120);
  const voiceover = text(raw.voiceover, 900);
  if (!title || !voiceover) throw new DomainError("VIDEO_PLAN_INVALID", "A plan needs a title and a voiceover.");
  if (scenes.length < 2 || scenes.length > 8) throw new DomainError("VIDEO_PLAN_INVALID", "A plan needs 2 to 8 scenes.");
  const style = oneOf(VIDEO_PLAN_STYLES, raw.style) ?? "PHOTO_MOTION";
  return { title, keepsFromWinner: text(raw.keepsFromWinner, 300), changes: text(raw.changes, 300), hookText: text(raw.hookText, 60), voiceover, scenes, ctaText: text(raw.ctaText, 40), style, ...planExtras(raw) };
}

/** Keeps only well-formed parts of the director's brief. */
export function canonicalizeCreativeBrief(value: unknown): CreativeBrief | undefined {
  const raw = asRaw(value);
  const angles = (Array.isArray(raw.angles) ? raw.angles : []).flatMap((item, index) => {
    const angle = asRaw(item);
    const name = text(angle.name, 80);
    return name ? [{ id: text(angle.id, 20) || `a${index + 1}`, name, insight: text(angle.insight, 400), whyItCouldWork: text(angle.whyItCouldWork, 400) }] : [];
  }).slice(0, 8);
  // Ids must be unique because the owner picks angles by id.
  const unique = angles.map((angle, index) => angles.findIndex((other) => other.id === angle.id) === index ? angle : { ...angle, id: `a${index + 1}` });
  const hooks = (Array.isArray(raw.hooks) ? raw.hooks : []).flatMap((item) => {
    const hook = asRaw(item);
    const type = oneOf(HOOK_TYPES, hook.type);
    const line = text(hook.text, 120);
    return type && line ? [{ type, text: line }] : [];
  }).slice(0, 16);
  if (!unique.length) return undefined;
  return { audience: text(raw.audience, 600), buyerInsights: (Array.isArray(raw.buyerInsights) ? raw.buyerInsights : []).map((item) => text(item, 300)).filter(Boolean).slice(0, 8), angles: unique, hooks, directorNotes: text(raw.directorNotes, 800) };
}

const batchStyle = (batch: WinnerVideoBatch): VideoPlanStyle => VIDEO_PLAN_STYLES.includes(batch.providerMetadata.style as VideoPlanStyle) ? batch.providerMetadata.style as VideoPlanStyle : "PHOTO_MOTION";

export class WinnerVideoService {
  constructor(private readonly d: Readonly<{
    repository: FactoryRepository; dna: CreativeDnaRepository; videos: WinnerVideoRepository; jobs: WinnerJobRepository;
    provider: CreativeProvider; voice: VoiceProvider; storage: StorageProvider; renderer: VideoRenderer; sceneImages?: SceneImageProvider;
    /** Folder with one subfolder per music mood (upbeat, warm, emotional, calm) holding licensed tracks; videos have no music without it. */
    musicRoot?: string;
    voiceProfileId?: string; maxLoadAverage?: number; loadAverage?: () => number; now?: () => Date; id?: () => string;
  }>) {}

  private now() { return (this.d.now ?? (() => new Date()))().toISOString(); }
  private id() { return (this.d.id ?? randomUUID)(); }

  private async productPhotos(productId: string, limit = MAX_PHOTOS) {
    const product = await this.d.repository.getProduct(productId);
    return { product, photos: product.assets.filter((asset) => asset.kind === "IMAGE").slice(0, limit) };
  }

  /**
   * Starts a new set of videos. With a director-capable provider, Claude first writes a creative brief and the owner
   * picks angles before scripts are written; otherwise scripts are written straight away.
   */
  async requestPlans(input: Readonly<{ referenceId: string; count: 3 | 6 | 12; durationSeconds: 15 | 30; style?: VideoPlanStyle; actor: string }>): Promise<WinnerVideoBatch> {
    const reference = await this.d.dna.getReference(input.referenceId);
    const report = (await this.d.dna.listWinnerReports()).find((item) => item.creativeReferenceId === reference.id);
    if (!report || report.status !== "READY") throw new DomainError("WINNER_REPORT_REQUIRED", "Finish the winner's analysis report before making new videos from it.");
    if (!reference.productId) throw new DomainError("CREATIVE_REFERENCE_PRODUCT_REQUIRED", "Link this winner to a product first.");
    const { photos } = await this.productPhotos(reference.productId);
    if (!photos.length) throw new DomainError("PRODUCT_PHOTOS_REQUIRED", "Add at least one product photo before making videos.");
    if ((await this.d.videos.listBatches(reference.id)).some((batch) => batch.status === "WRITING" || batch.status === "WRITING_BRIEF")) throw new DomainError("VIDEO_PLANS_IN_PROGRESS", "Plans for this winner are already being written.");
    const now = this.now();
    const director = Boolean(this.d.provider.writeCreativeBrief);
    const batch: WinnerVideoBatch = { id: this.id(), creativeReferenceId: reference.id, productId: reference.productId, requestedCount: input.count, targetDurationMs: input.durationSeconds === 30 ? 30_000 : 15_000, status: director ? "WRITING_BRIEF" : "WRITING", providerMetadata: { style: input.style ?? "PHOTO_MOTION" }, createdBy: input.actor, createdAt: now, updatedAt: now };
    await this.d.videos.createBatch(batch);
    await this.d.jobs.enqueue({ id: this.id(), kind: director ? "WRITE_CREATIVE_BRIEF" : "WRITE_VIDEO_PLANS", targetId: batch.id, operationKey: `${director ? "brief" : "plans"}:${batch.id}`, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    return batch;
  }

  /** Everything Claude needs about the winner and the product, shared by the brief, script and review steps. */
  private async planInput(batch: WinnerVideoBatch): Promise<Readonly<{ input: VideoPlanInput; photoIds: readonly string[] }>> {
    const reference = await this.d.dna.getReference(batch.creativeReferenceId);
    const [{ product, photos }, reports, references, links] = await Promise.all([this.productPhotos(batch.productId), this.d.dna.listWinnerReports(), this.d.dna.listReferences(), this.d.dna.listMetaLinks()]);
    const report = reports.find((item) => item.creativeReferenceId === reference.id);
    const revisions = references.find((entry) => entry.reference.id === reference.id)?.revisions ?? [];
    const dna = revisions.find((revision) => revision.id === reference.approvedRevisionId) ?? revisions.at(-1);
    const metrics = links.find((link) => link.creativeReferenceId === reference.id)?.metrics;
    const photoPayload = await Promise.all(photos.map(async (photo, index) => ({ index: index + 1, label: photo.label, mimeType: photo.mimeType, bytesBase64: Buffer.from(await this.d.storage.read(photo.storageKey)).toString("base64") })));
    return {
      photoIds: photos.map((photo) => photo.id),
      input: {
        requestedCount: batch.requestedCount, targetDurationMs: batch.targetDurationMs, style: batchStyle(batch),
        product: { name: product.name, description: product.description, facts: product.claims.map((claim) => claim.text), ...(product.personalizationVisualAuthority ? { lookRules: product.personalizationVisualAuthority } : {}) },
        photos: photoPayload,
        winner: { name: reference.displayName, ...(report?.report ? { report: report.report } : {}), ...(dna ? { dna: { preserveTraits: dna.preserveTraits, safeToVaryTraits: dna.safeToVaryTraits, avoidTraits: dna.avoidTraits, openingPattern: dna.openingPattern, pacingPattern: dna.pacingPattern, ctaPattern: dna.ctaPattern } } : {}), ...(report?.measurements ? { measurements: { durationMs: report.measurements.durationMs, shotCount: report.measurements.shotCount, wordsPerMinute: report.measurements.wordsPerMinute, transcriptText: report.measurements.transcriptText } } : {}), ...(metrics ? { metaResults: metrics } : {}) }
      }
    };
  }

  /** A paid request is never repeated automatically: any failure ends this batch and the owner can start a new one. */
  private async failBatch(batch: WinnerVideoBatch, error: unknown, fallback: string): Promise<JobOutcome> {
    const message = error instanceof Error ? error.message : fallback;
    await this.d.videos.updateBatch({ ...batch, status: "FAILED", failureMessage: message.slice(0, 500), updatedAt: this.now() });
    return { status: "FAILED", lastError: message };
  }

  /** Step 1, the marketing director: audience, insights, angles and hooks. The owner then picks angles. */
  async writeBrief(job: WinnerJob): Promise<JobOutcome> {
    const batch = await this.d.videos.getBatch(job.targetId);
    if (batch.status !== "WRITING_BRIEF") return { status: "COMPLETED" };
    try {
      if (!this.d.provider.writeCreativeBrief) throw new DomainError("VIDEO_PLANS_UNAVAILABLE", "The AI provider cannot write a creative brief.");
      const { input } = await this.planInput(batch);
      const { brief, submission } = await this.d.provider.writeCreativeBrief(input, { operationKey: `brief:${batch.id}`, projectId: batch.productId, targetId: batch.id });
      const canonical = canonicalizeCreativeBrief(brief);
      if (!canonical) throw new DomainError("CREATIVE_BRIEF_INVALID", "The AI did not return a usable creative brief. Try again.");
      await this.d.videos.updateBatch({ ...batch, status: "BRIEF_READY", providerMetadata: { ...batch.providerMetadata, brief: canonical, briefModel: submission.model, briefUsage: submission.metadata }, updatedAt: this.now() });
      return { status: "COMPLETED" };
    } catch (error) {
      return this.failBatch(batch, error, "Writing the creative brief failed.");
    }
  }

  /** The owner keeps the angles they like (and may change the brief's wording), then scripts are written. */
  async approveBrief(batchId: string, angleIds: readonly string[]): Promise<WinnerVideoBatch> {
    const batch = await this.d.videos.getBatch(batchId);
    if (batch.status !== "BRIEF_READY") throw new DomainError("CREATIVE_BRIEF_NOT_READY", "This brief is not waiting for approval.");
    const brief = batch.providerMetadata.brief as CreativeBrief;
    const kept = brief.angles.filter((angle) => angleIds.includes(angle.id));
    if (!kept.length) throw new DomainError("CREATIVE_BRIEF_ANGLES_REQUIRED", "Keep at least one angle.");
    const now = this.now();
    const updated: WinnerVideoBatch = { ...batch, status: "WRITING", providerMetadata: { ...batch.providerMetadata, approvedAngleIds: kept.map((angle) => angle.id) }, updatedAt: now };
    await this.d.videos.updateBatch(updated);
    await this.d.jobs.enqueue({ id: this.id(), kind: "WRITE_VIDEO_PLANS", targetId: batch.id, operationKey: `plans:${batch.id}`, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    return updated;
  }

  async discardBrief(batchId: string): Promise<WinnerVideoBatch> {
    const batch = await this.d.videos.getBatch(batchId);
    if (batch.status !== "BRIEF_READY") throw new DomainError("CREATIVE_BRIEF_NOT_READY", "This brief is not waiting for approval.");
    const updated: WinnerVideoBatch = { ...batch, status: "FAILED", failureMessage: "Discarded by the owner.", updatedAt: this.now() };
    await this.d.videos.updateBatch(updated);
    return updated;
  }

  /** Steps 2 and 3: the scriptwriter writes every script, then the critic scores and rewrites weak ones. */
  async writePlans(job: WinnerJob): Promise<JobOutcome> {
    const batch = await this.d.videos.getBatch(job.targetId);
    if (batch.status !== "WRITING") return { status: "COMPLETED" };
    try {
      if (!this.d.provider.planWinnerVideos) throw new DomainError("VIDEO_PLANS_UNAVAILABLE", "The AI provider cannot write video plans.");
      const { input: base, photoIds } = await this.planInput(batch);
      const fullBrief = batch.providerMetadata.brief as CreativeBrief | undefined;
      const approved = batch.providerMetadata.approvedAngleIds as readonly string[] | undefined;
      const brief = fullBrief ? { ...fullBrief, angles: fullBrief.angles.filter((angle) => !approved || approved.includes(angle.id)) } : undefined;
      const input: VideoPlanInput = { ...base, ...(brief ? { brief } : {}) };
      const context = { operationKey: `plans:${batch.id}`, projectId: batch.productId, targetId: batch.id };
      const draft = await this.d.provider.planWinnerVideos(input, context);
      let plans = draft.plans;
      let review: Record<string, unknown> = {};
      if (this.d.provider.reviewVideoPlans) {
        try {
          const reviewed = await this.d.provider.reviewVideoPlans({ ...input, plans }, { ...context, operationKey: `review:${batch.id}` });
          // The review only replaces the drafts when it returns a usable set of the same size.
          if (reviewed.plans.filter((value) => canonicalizeVideoPlan(value, photoIds, batch.targetDurationMs, input.style)).length >= Math.min(plans.length, batch.requestedCount)) plans = reviewed.plans;
          review = { reviewModel: reviewed.submission.model, reviewUsage: reviewed.submission.metadata };
        } catch (error) {
          // The drafts are still good scripts; record why the review was skipped instead of failing the set.
          review = { reviewError: (error instanceof Error ? error.message : "Review failed.").slice(0, 300) };
        }
      }
      const now = this.now();
      const videos: WinnerVideo[] = plans.flatMap((value) => { const plan = canonicalizeVideoPlan(value, photoIds, batch.targetDurationMs, input.style); return plan ? [plan] : []; }).slice(0, batch.requestedCount)
        .map((plan, index) => ({ id: this.id(), batchId: batch.id, ordinal: index + 1, plan, status: "PLANNED" as const, createdAt: now, updatedAt: now }));
      if (!videos.length) throw new DomainError("VIDEO_PLANS_INVALID", "The AI did not return any usable video plans. Try again.");
      await this.d.videos.saveVideos(videos);
      await this.d.videos.updateBatch({ ...batch, status: "READY", providerMetadata: { ...batch.providerMetadata, provider: draft.submission.provider, model: draft.submission.model, ...draft.submission.metadata, ...review }, updatedAt: now });
      return { status: "COMPLETED" };
    } catch (error) {
      return this.failBatch(batch, error, "Writing plans failed.");
    }
  }

  /** Saves the owner's changes to a plan (photos, captions, scene order, voiceover). A made video goes back to "Plan" until it is made again. */
  async editPlan(videoId: string, value: unknown): Promise<WinnerVideo> {
    const plan = normalizeEditedPlan(value);
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
    const clips = new Set([...(video.plan.uploadedClipIds ?? []), ...video.plan.scenes.flatMap((scene) => scene.sceneVideoAssetId ? [scene.sceneVideoAssetId] : [])]);
    const scenes = plan.scenes.map((edited) => {
      const { sceneVideoAssetId, videoStartMs: _start, videoDurationMs: _length, ...rest } = edited;
      void _start; void _length;
      const scene = sceneVideoAssetId && clips.has(sceneVideoAssetId) ? edited : rest;
      return scene.sceneImageAssetId && known.has(scene.sceneImageAssetId) ? { ...plainScene(scene), sceneImageAssetId: scene.sceneImageAssetId, imageStatus: "READY" as const } : plainScene(scene);
    });
    const edited: WinnerVideo = { ...rest, plan: { ...plan, scenes, ...(video.plan.uploadedClipIds ? { uploadedClipIds: video.plan.uploadedClipIds } : {}) }, status: "PLANNED", updatedAt: this.now() };
    await this.d.videos.updateVideo(edited);
    return edited;
  }

  /** Stores a clip the owner made elsewhere (for example in the Kling app) so a scene can use it; the editor then picks the scene and start time. */
  async uploadSceneClip(videoId: string, file: Readonly<{ bytes: Uint8Array; mimeType: string; extension: string; filename: string }>): Promise<Readonly<{ assetId: string; durationMs: number }>> {
    const video = await this.d.videos.getVideo(videoId);
    if (video.status === "QUEUED" || video.status === "RENDERING") throw new DomainError("VIDEO_BUSY", "This video is being made. Upload clips after it finishes.");
    const batch = await this.d.videos.getBatch(video.batchId);
    const root = await mkdtemp(join(tmpdir(), "koolezt-clip-"));
    let durationMs = 0;
    try {
      const path = join(root, `clip.${file.extension}`);
      await writeFile(path, file.bytes);
      const probed = await this.d.renderer.probe(path).catch(() => ({} as Readonly<{ width?: number; durationMs?: number }>));
      if (!probed.width || !probed.durationMs || probed.durationMs < 500) throw new DomainError("SCENE_CLIP_INVALID", "This file is not a playable video of at least half a second.");
      durationMs = probed.durationMs;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const asset = await this.d.storage.put(`scene-videos/${video.id}/${randomUUID()}.${file.extension}`, { bytes: file.bytes, mimeType: file.mimeType, extension: file.extension, metadata: { projectId: batch.productId, purpose: "SCENE_VIDEO", originalFilename: file.filename.slice(0, 255) } });
    const latest = await this.d.videos.getVideo(videoId);
    await this.d.videos.updateVideo({ ...latest, plan: { ...latest.plan, uploadedClipIds: [...(latest.plan.uploadedClipIds ?? []), asset.id] }, updatedAt: this.now() });
    return { assetId: asset.id, durationMs };
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
    // Each scene is made from the product photo (mockup) its script chose, so different scenes show different mockups.
    const { photos } = await this.productPhotos(batch.productId, Number.POSITIVE_INFINITY);
    const references = new Map<string, Promise<Readonly<{ bytes: Uint8Array; mimeType: string }>>>();
    const referenceFor = (photoAssetId: string) => {
      const photo = photos.find((item) => item.id === photoAssetId) ?? photos[0];
      if (!photo) return undefined;
      if (!references.has(photo.id)) references.set(photo.id, this.d.storage.read(photo.storageKey).then((bytes) => ({ bytes, mimeType: photo.mimeType })));
      return references.get(photo.id)!;
    };
    const scenes = [...video.plan.scenes];
    const make = async (index: number) => {
      const scene = plainScene(scenes[index]!);
      try {
        if (!this.d.sceneImages) throw new DomainError("SCENE_IMAGES_UNAVAILABLE", "AI scene images need OPENAI_API_KEY on the server.");
        const reference = referenceFor(scene.photoAssetId);
        if (!reference) throw new DomainError("PRODUCT_PHOTOS_REQUIRED", "Add a product photo first.");
        const image = await this.d.sceneImages.generate({ prompt: sceneImagePrompt(scene.imagePrompt ?? ""), referenceImages: [await reference] });
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
      const submission = await this.d.voice.submit({ voiceProfileId: video.plan.voice ?? this.d.voiceProfileId ?? "default", script: video.plan.voiceover, ...(video.plan.voiceStyle ? { instructions: `${video.plan.voiceStyle}. Natural social-media ad read.` } : {}) }, { operationKey: `voice:${video.id}:${job.id}`, projectId: batch.productId, targetId: video.id });
      const voiceResult = await this.d.voice.getStatus(submission.providerTaskId);
      if (voiceResult.state !== "SUCCEEDED") throw new DomainError("VIDEO_VOICE_FAILED", voiceResult.state === "FAILED" ? voiceResult.message : "The voiceover is not ready.");
      const voiceFile = `${voicePath}.${voiceResult.result.extension}`;
      await writeFile(voiceFile, voiceResult.result.bytes);
      const voiceDurationMs = (await this.d.renderer.probe(voiceFile)).durationMs ?? 0;
      const scenes = [];
      for (const [index, scene] of video.plan.scenes.entries()) {
        // An uploaded clip wins, then a finished AI scene image (both full frame); otherwise the product photo sits on its blurred copy.
        if (scene.sceneVideoAssetId) {
          const clip = await this.d.storage.getAsset(scene.sceneVideoAssetId);
          const clipPath = join(root, `clip-${index}.${clip.mimeType.includes("webm") ? "webm" : clip.mimeType.includes("quicktime") ? "mov" : "mp4"}`);
          await writeFile(clipPath, await this.d.storage.read(clip.storageKey));
          scenes.push({ photoPath: clipPath, photoWidth: 1080, photoHeight: 1920, motion: scene.motion, caption: scene.caption, durationMs: scene.durationMs, fullFrame: true, clip: { startMs: scene.videoStartMs ?? 0 }, ...(scene.transition ? { transition: scene.transition } : {}) });
          continue;
        }
        const sceneImage = scene.sceneImageAssetId && scene.imageStatus === "READY" ? await this.d.storage.getAsset(scene.sceneImageAssetId) : undefined;
        const asset = sceneImage ?? product.assets.find((item) => item.id === scene.photoAssetId);
        if (!asset) throw new DomainError("VIDEO_PHOTO_MISSING", "A product photo used by this plan was removed. Choose another photo with Edit.");
        const photoPath = join(root, `photo-${index}.${asset.mimeType.split("/")[1] ?? "jpg"}`);
        await writeFile(photoPath, await this.d.storage.read(asset.storageKey));
        const size = await this.d.renderer.probe(photoPath);
        scenes.push({ photoPath, photoWidth: size.width ?? 1080, photoHeight: size.height ?? 1080, motion: scene.motion, caption: scene.caption, durationMs: scene.durationMs, ...(sceneImage ? { fullFrame: true } : {}), ...(scene.transition ? { transition: scene.transition } : {}) });
      }
      const musicPath = await this.musicFor(video);
      const rendered = await this.d.renderer.render({ scenes, hookText: video.plan.hookText, ctaText: video.plan.ctaText, voicePath: voiceFile, voiceDurationMs, targetDurationMs: batch.targetDurationMs, style: video.plan.style ?? "PHOTO_MOTION", ...(video.plan.captionStyle ? { captionStyle: video.plan.captionStyle } : {}), ...(musicPath ? { musicPath } : {}) });
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

  /** Picks a track from the plan's mood folder; the same video always gets the same track. */
  private async musicFor(video: WinnerVideo): Promise<string | undefined> {
    const mood = video.plan.musicMood;
    if (!this.d.musicRoot || !mood || mood === "NONE") return undefined;
    const folder = join(this.d.musicRoot, mood.toLowerCase());
    const tracks = (await readdir(folder).catch(() => [] as string[])).filter((name) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(name)).sort();
    if (!tracks.length) return undefined;
    const pick = [...video.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tracks.length;
    return join(folder, tracks[pick]!);
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
