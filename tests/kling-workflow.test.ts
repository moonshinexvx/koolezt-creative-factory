import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import { DomainError } from "@koolezt/domain";
import type { CreativeProvider, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, VideoGenerationOutput, VideoGenerationProvider } from "@koolezt/domain";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeVoiceProvider } from "@koolezt/providers";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class OneSceneCreative implements CreativeProvider {
  constructor(private readonly sourceType: "AI_VIDEO" | "PRODUCT_IMAGE" = "AI_VIDEO") {}
  async generateConcept(input: Parameters<CreativeProvider["generateConcept"]>[0], context: ProviderOperationContext) {
    return { concept: { angle: "Accuracy", hook: "Look", targetDurationMs: 15_000, voiceScript: "Look at this.", cta: input.defaultCta, editingStyleKey: "UGC_FAST/v1", musicCategory: "No music", scenes: [1, 2, 3].map((sceneNumber) => ({ sceneNumber, intendedDurationMs: 5_000, purpose: "Reveal", sourceType: this.sourceType, generationPrompt: "Slow product reveal", overlayText: "LOOK", referenceAssetIds: [input.selectedAssets[0]!.id], accuracyRequirements: ["Keep all visible text unchanged"] })) }, submission: { providerTaskId: "concept", requestId: "concept", provider: "fake-openai", model: "fake", metadata: { operationKey: context.operationKey } } };
  }
}

class AsyncKlingStub implements VideoGenerationProvider {
  readonly requiresExternalMedia = true; submissions = 0; polls = 0; submittedInput?: Parameters<VideoGenerationProvider["submit"]>[0];
  async submit(input: Parameters<VideoGenerationProvider["submit"]>[0]): Promise<ProviderSubmission> { this.submissions += 1; this.submittedInput = input; return { providerTaskId: "kling-task", requestId: "kling-request", provider: "kling", model: "kling-3.0-turbo", metadata: { promptVersion: "koolezt-kling-scene/v1" } }; }
  async getStatus(): Promise<ProviderJobStatus<VideoGenerationOutput>> { this.polls += 1; return this.polls === 1 ? { state: "PROCESSING" } : { state: "SUCCEEDED", result: { kind: "INLINE", payload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4", extension: "mp4", metadata: { width: 720, height: 1280, durationMs: 5_000, hasVideo: true, hasAudio: false, videoCodec: "h264" } } } }; }
}

async function setup(videoProvider: VideoGenerationProvider, creativeProvider: CreativeProvider = new OneSceneCreative()) {
  const root = await mkdtemp(join(tmpdir(), "koolezt-kling-workflow-")); roots.push(root);
  const storage = new LocalStorageProvider(join(root, "working"));
  const image = await storage.put("products/source.png", { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png", extension: "png", metadata: {} });
  const repository = new InMemoryFactoryRepository(); const delivery = new FakeExternalMediaDeliveryProvider();
  const service = new CreativeFactoryService({ repository, creativeProvider, videoProvider, defaultVideoProviderKey: "kling", voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: delivery, compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
  const product = await service.createProduct({ name: "Product", slug: "product", description: "Description", claims: [{ kind: "RESTRICTION", text: "Keep visible text unchanged" }], defaultCta: "Create yours", assets: [{ id: image.id, kind: "IMAGE", label: "Mockup", storageKey: image.storageKey, mimeType: image.mimeType }] });
  let project = await service.createProject({ productId: product.id, selectedProductAssetIds: [image.id], preferredVoiceProfileId: "voice", actor: "test" });
  project = await service.generateConcept(project.id, "test"); project = await service.approveConcept(project.id, "test");
  if (project.scenes[0]?.attempts[0]?.sourceType === "AI_VIDEO") {
    project = await service.setSceneGenerationMethod(project.id, project.scenes[0].id, "API", "test");
  }
  return { service, repository, delivery, project };
}

describe("Kling scene workflow", () => {
  it("stages the authorized image, submits once, polls durably, QA gates, and cleans staging", async () => {
    const provider = new AsyncKlingStub(); const fixture = await setup(provider); const job = (await fixture.service.listJobs(fixture.project.id))[0]!;
    expect((await fixture.service.processJob(job.id)).status).toBe("PENDING");
    expect((await fixture.service.processJob(job.id)).status).toBe("COMPLETED");
    await fixture.service.processJob(job.id);
    const project = await fixture.service.getProject(fixture.project.id); const attempt = project.scenes[0]!.attempts[0]!;
    expect(provider.submissions).toBe(1); expect(provider.polls).toBe(2); expect(provider.submittedInput?.generationMode).toBe("IMAGE_TO_VIDEO");
    expect(provider.submittedInput?.referenceImage?.reference.url).toMatch(/^fake-media:/); expect(JSON.stringify(provider.submittedInput)).not.toContain("products/source.png");
    expect(attempt).toMatchObject({ status: "REVIEW", provider: "kling", providerTaskId: "kling-task", providerModel: "kling-3.0-turbo" });
    expect(attempt.inspection?.passed).toBe(true); expect(fixture.delivery.staged).toHaveLength(1); expect(fixture.delivery.cleanedOperationIds).toEqual([attempt.operationKey]);
  });

  it("persists SUBMISSION_UNKNOWN and never blindly resubmits the paid operation", async () => {
    let calls = 0;
    const provider: VideoGenerationProvider = { requiresExternalMedia: true, async submit() { calls += 1; throw new DomainError("KLING_SUBMISSION_UNKNOWN", "response lost"); }, async getStatus() { throw new Error("must not poll"); } };
    const fixture = await setup(provider); const job = (await fixture.service.listJobs(fixture.project.id))[0]!;
    expect((await fixture.service.processJob(job.id)).status).toBe("COMPLETED"); await fixture.service.processJob(job.id);
    const attempt = (await fixture.service.getProject(fixture.project.id)).scenes[0]!.attempts[0]!;
    expect(calls).toBe(1); expect(attempt.status).toBe("SUBMISSION_UNKNOWN"); expect(attempt.provider).toBe("kling");
  });

  it("defaults a product-image scene to manual external work without calling Kling", async () => {
    let calls = 0; const provider: VideoGenerationProvider = { async submit() { calls += 1; throw new Error("must not submit"); }, async getStatus() { throw new Error("must not poll"); } };
    const fixture = await setup(provider, new OneSceneCreative("PRODUCT_IMAGE")); const attempt = (await fixture.service.getProject(fixture.project.id)).scenes[0]!.attempts[0]!;
    expect(await fixture.service.listJobs(fixture.project.id)).toHaveLength(0); expect(calls).toBe(0); expect(attempt).toMatchObject({ sourceType: "PRODUCT_IMAGE", generationMethod: "MANUAL", status: "PENDING" });
  });
});
