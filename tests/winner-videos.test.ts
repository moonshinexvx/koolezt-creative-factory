import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeVideoPlan, CreativeDnaService, CreativeFactoryService, WinnerJobRunner, WinnerVideoService } from "@koolezt/application";
import type { VideoRenderer } from "@koolezt/application";
import { InMemoryCreativeDnaStore, InMemoryCreativeStrategyStore, InMemoryFactoryRepository, InMemoryWinnerJobStore, InMemoryWinnerVideoStore } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector, PlanVideoRenderer, planTimeline, wrapText } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";
import type { CreativeDnaPreprocessor } from "@koolezt/domain";

const architecture = process.arch === "arm64" ? "arm64" : "x64";
const ffmpeg = resolve(`node_modules/ffmpeg-static/ffmpeg${process.platform === "win32" ? ".exe" : ""}`);
const ffprobe = resolve(`node_modules/ffprobe-static/bin/${process.platform}/${architecture}/ffprobe${process.platform === "win32" ? ".exe" : ""}`);
const preprocessor: CreativeDnaPreprocessor = { async preprocess() { return { mediaMetadata: { durationMs: 15_000, width: 720, height: 1280, hasAudio: true, mimeType: "video/mp4" }, frames: [{ timestampMs: 0, mimeType: "image/jpeg", bytesBase64: "a", sha256: "f" }] }; } };

describe("video plan clean-up", () => {
  it("maps photo numbers to product photos, drops unknown photos, and stretches scenes to the target length", () => {
    const plan = canonicalizeVideoPlan({
      title: "  Night porch  ", keepsFromWinner: "Product first", changes: "New hook", hookText: "one two three four five six seven eight nine ten", voiceover: "Hello there.", ctaText: "Shop now please today friends forever",
      scenes: [{ photo: 1, motion: "ZOOM_IN", caption: "First", seconds: 2 }, { photo: 9, motion: "PAN_LEFT", caption: "Missing photo", seconds: 5 }, { photo: 2, motion: "SPIN", caption: "Second", seconds: 2 }]
    }, ["photo-a", "photo-b"], 15_000)!;
    expect(plan.title).toBe("Night porch");
    expect(plan.scenes.map((scene) => [scene.photoAssetId, scene.motion])).toEqual([["photo-a", "ZOOM_IN"], ["photo-b", "ZOOM_IN"]]);
    expect(plan.scenes.reduce((sum, scene) => sum + scene.durationMs, 0)).toBe(15_000);
    expect(plan.hookText.split(" ")).toHaveLength(8);
    expect(plan.ctaText.split(" ")).toHaveLength(6);
    expect(canonicalizeVideoPlan({ voiceover: "x", scenes: [{ photo: 1 }] }, ["photo-a"], 15_000)).toBeUndefined();
  });

  it("wraps captions on word boundaries and lengthens the video when the voiceover is long", () => {
    expect(wrapText("Laser-cut steel built for the outdoors", 18, 3)).toEqual(["Laser-cut steel", "built for the", "outdoors"]);
    expect(wrapText("one two three four five six", 7, 2)).toEqual(["one two", "three…"]);
    expect(planTimeline([{ durationMs: 5_000 }, { durationMs: 5_000 }, { durationMs: 5_000 }], 15_000, 9_000)).toEqual({ totalMs: 15_000, sceneMs: [5_000, 5_000, 5_000] });
    expect(planTimeline([{ durationMs: 5_000 }, { durationMs: 10_000 }], 15_000, 17_000).totalMs).toBe(18_000);
  });
});

async function harness(options: Readonly<{ renderer?: VideoRenderer; loadAverage?: () => number }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "winner-videos-"));
  const repository = new InMemoryFactoryRepository();
  const dna = new InMemoryCreativeDnaStore();
  const jobs = new InMemoryWinnerJobStore();
  const videos = new InMemoryWinnerVideoStore();
  const storage = new LocalStorageProvider(join(root, "media"));
  const provider = new FakeCreativeProvider();
  const factory = new CreativeFactoryService({ repository, strategyRepository: new InMemoryCreativeStrategyStore(repository), creativeDnaRepository: dna, creativeProvider: provider, videoProvider: new FakeVideoGenerationProvider(), voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
  const project = await factory.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Dog address sign", creativeTopic: "Winners", productDetails: "A personalized address sign.", verifiedClaims: ["Laser-cut steel"], targetDurationSeconds: 15, actor: "owner" });
  const product = await repository.getProduct(project.productId);
  // A real JPEG product photo so the real-render test can use it.
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1200x1500:d=1", "-frames:v", "1", "-y", join(root, "photo.jpg")]);
  const photo = await storage.put(`products/${product.id}/photo.jpg`, { bytes: new Uint8Array(await readFile(join(root, "photo.jpg"))), mimeType: "image/jpeg", extension: "jpg", metadata: {} });
  await repository.saveProduct({ ...product, assets: [{ id: photo.id, kind: "IMAGE", label: "Front", storageKey: photo.storageKey, mimeType: "image/jpeg" }] });
  const dnaService = new CreativeDnaService({ repository, dna, jobs, provider, storage, preprocessor });
  const source = await storage.put("history/winner.mp4", { bytes: new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypisom")]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
  const reference = await dnaService.register({ productId: product.id, assetId: source.id, displayName: "Ad1", operatorStatus: "WINNER", actor: "owner" });
  const renderer: VideoRenderer = options.renderer ?? { probe: vi.fn(async () => ({ width: 1200, height: 1500, durationMs: 4_000 })), render: vi.fn(async () => ({ bytes: new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypisom")]), durationMs: 15_000 })) };
  const service = new WinnerVideoService({ repository, dna, videos, jobs, provider, voice: new FakeVoiceProvider(resolve("tests/fixtures/vertical-1080x1920.mp4")), storage, renderer, ...(options.loadAverage ? { loadAverage: options.loadAverage } : {}) });
  const runner = new WinnerJobRunner({ jobs, handlers: { ANALYZE_WINNER: (job) => dnaService.runJob(job), WRITE_VIDEO_PLANS: (job) => service.writePlans(job), RENDER_VIDEO: (job) => service.renderVideo(job) } });
  const drain = async () => { let count = 0; while (await runner.runOnce()) count++; return count; };
  return { root, repository, dna, jobs, videos, storage, provider, product, photo, reference, dnaService, service, runner, renderer, drain, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe("winner to videos", () => {
  it("analyzes a winner, writes plans from it, and makes only the chosen videos", async () => {
    const setup = await harness();
    try {
      await expect(setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" })).rejects.toMatchObject({ code: "WINNER_REPORT_REQUIRED" });
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      expect(await setup.drain()).toBe(1);
      const batch = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await expect(setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" })).rejects.toMatchObject({ code: "VIDEO_PLANS_IN_PROGRESS" });
      await setup.drain();
      const [{ batch: written, videos }] = await setup.service.list(setup.reference.id) as unknown as [{ batch: { status: string }; videos: { id: string; status: string; plan: { scenes: { photoAssetId: string }[] } }[] }];
      expect(written.status).toBe("READY");
      expect(videos).toHaveLength(3);
      expect(videos.every((video) => video.status === "PLANNED" && video.plan.scenes.every((scene) => scene.photoAssetId === setup.photo.id))).toBe(true);
      await setup.service.makeVideos(batch.id, [videos[0]!.id, videos[2]!.id]);
      await setup.drain();
      const made = await setup.videos.listVideos(batch.id);
      expect(made.map((video) => video.status)).toEqual(["READY", "PLANNED", "READY"]);
      expect(made[0]!.outputAssetId).toBeDefined();
      expect(setup.renderer.render).toHaveBeenCalledTimes(2);
      await expect(setup.service.makeVideos(batch.id, [videos[0]!.id])).rejects.toMatchObject({ code: "NO_VIDEOS_SELECTED" });
    } finally { await setup.dispose(); }
  });

  it("waits instead of rendering while the server is busy", async () => {
    let load = 5;
    const setup = await harness({ loadAverage: () => load });
    try {
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      await setup.drain();
      const batch = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await setup.drain();
      const [first] = await setup.videos.listVideos(batch.id);
      await setup.service.makeVideos(batch.id, [first!.id]);
      await setup.drain();
      expect(setup.renderer.render).not.toHaveBeenCalled();
      expect((await setup.jobs.list(first!.id))[0]).toMatchObject({ status: "PENDING", lastError: expect.stringContaining("Server busy") });
      expect((await setup.videos.getVideo(first!.id)).status).toBe("QUEUED");
      load = 0.3;
      const due = (await setup.jobs.list(first!.id))[0]!;
      await setup.jobs.finish(due.id, { status: "PENDING" }, new Date().toISOString());
      await setup.drain();
      expect((await setup.videos.getVideo(first!.id)).status).toBe("READY");
    } finally { await setup.dispose(); }
  });

  it("never retries a failed plan request and records why a video failed", async () => {
    const setup = await harness({ renderer: { probe: async () => ({ width: 100, height: 100, durationMs: 1000 }), render: async () => { throw Object.assign(new Error("boom"), { name: "DomainError" }); } } });
    try {
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      await setup.drain();
      vi.spyOn(setup.provider, "planWinnerVideos").mockRejectedValueOnce(new Error("socket hang up"));
      const batch = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await setup.drain();
      expect(await setup.videos.getBatch(batch.id)).toMatchObject({ status: "FAILED", failureMessage: "socket hang up" });
      expect(setup.provider.planWinnerVideos).toHaveBeenCalledTimes(1);
      const second = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await setup.drain();
      const [video] = await setup.videos.listVideos(second.id);
      await setup.service.makeVideos(second.id, [video!.id]);
      for (let i = 0; i < 6; i++) { await setup.drain(); const job = (await setup.jobs.list(video!.id))[0]!; if (job.status === "PENDING") await setup.jobs.finish(job.id, { status: "PENDING" }, new Date().toISOString()); }
      expect(await setup.videos.getVideo(video!.id)).toMatchObject({ status: "FAILED", failureMessage: "boom" });
    } finally { await setup.dispose(); }
  });

  it("renders a real vertical MP4 with FFmpeg from a product photo and voiceover", async () => {
    const setup = await harness({ renderer: new PlanVideoRenderer({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, lowPriority: false }) });
    try {
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      await setup.drain();
      const batch = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await setup.drain();
      const [video] = await setup.videos.listVideos(batch.id);
      await setup.service.makeVideos(batch.id, [video!.id]);
      await setup.drain();
      const made = await setup.videos.getVideo(video!.id);
      expect(made.status).toBe("READY");
      const asset = await setup.storage.getAsset(made.outputAssetId!);
      const bytes = await setup.storage.read(asset.storageKey);
      const out = join(setup.root, "made.mp4");
      await (await import("node:fs/promises")).writeFile(out, bytes);
      const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", out]).toString()) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
      expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
      expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
      expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(14.5);
    } finally { await setup.dispose(); }
  }, 120_000);

  it("lets the owner change a plan's photos and scenes, and keeps edits off videos being made", async () => {
    const setup = await harness();
    try {
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      await setup.drain();
      await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, actor: "owner" });
      await setup.drain();
      const [first] = await setup.videos.listVideos();
      const scenes = [{ photoAssetId: setup.photo.id, motion: "PAN_LEFT" as const, caption: "My own caption", durationMs: 4000 }, { photoAssetId: setup.photo.id, motion: "ZOOM_OUT" as const, caption: "", durationMs: 2000 }];
      const edited = await setup.service.editPlan(first!.id, { ...first!.plan, title: "Edited", scenes });
      expect((await setup.videos.getVideo(first!.id)).plan).toMatchObject({ title: "Edited", scenes });
      expect(edited.status).toBe("PLANNED");
      await expect(setup.service.editPlan(first!.id, { ...first!.plan, scenes: [{ ...scenes[0]!, photoAssetId: crypto.randomUUID() }, scenes[1]!] })).rejects.toMatchObject({ code: "VIDEO_PHOTO_MISSING" });
      await setup.service.makeVideos(first!.batchId, [first!.id]);
      await expect(setup.service.editPlan(first!.id, edited.plan)).rejects.toMatchObject({ code: "VIDEO_BUSY" });
    } finally { await setup.dispose(); }
  });

  it("writes stop-motion plans with image and video prompts per scene and renders them for real", async () => {
    const setup = await harness({ renderer: new PlanVideoRenderer({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, lowPriority: false }) });
    try {
      await setup.dnaService.requestAnalysis(setup.reference.id, crypto.randomUUID());
      await setup.drain();
      const plansSpy = vi.spyOn(setup.provider, "planWinnerVideos");
      const batch = await setup.service.requestPlans({ referenceId: setup.reference.id, count: 3, durationSeconds: 15, style: "STOP_MOTION", actor: "owner" });
      await setup.drain();
      expect(plansSpy.mock.calls[0]![0]).toMatchObject({ style: "STOP_MOTION" });
      const [video] = await setup.videos.listVideos(batch.id);
      expect(video!.plan.style).toBe("STOP_MOTION");
      expect(video!.plan.scenes[0]).toMatchObject({ imagePrompt: expect.stringContaining("exact product"), videoPrompt: expect.stringContaining("product stays still") });
      await setup.service.makeVideos(batch.id, [video!.id]);
      await setup.drain();
      const made = await setup.videos.getVideo(video!.id);
      expect(made).toMatchObject({ status: "READY" });
      expect(made.durationMs).toBeGreaterThanOrEqual(14_500);
    } finally { await setup.dispose(); }
  }, 120_000);
});
