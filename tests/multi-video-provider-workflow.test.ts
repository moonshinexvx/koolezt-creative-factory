import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreativeFactoryService, VideoProviderRegistry } from "@koolezt/application";
import { DomainError } from "@koolezt/domain";
import type { CreativeProvider, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, VideoGenerationOutput, VideoGenerationProvider } from "@koolezt/domain";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeVoiceProvider, UnavailableVideoGenerationProvider } from "@koolezt/providers";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MixedCreative implements CreativeProvider {
  constructor(private readonly firstSource: "AI_VIDEO" | "KLING_VIDEO" = "AI_VIDEO") {}
  async generateConcept(input: Parameters<CreativeProvider["generateConcept"]>[0], context: ProviderOperationContext) {
    const source = input.selectedAssets[0]!.id;
    return {
      concept: {
        angle: "Mixed provider", hook: "See it", targetDurationMs: 15_000, voiceScript: "A custom sign for your home.", cta: input.defaultCta, editingStyleKey: "UGC_FAST/v1", musicCategory: "none",
        scenes: [
          { sceneNumber: 1, intendedDurationMs: 5_000, purpose: "Hook", sourceType: this.firstSource, generationPrompt: "Opening video", overlayText: "LOOK", referenceAssetIds: [source], accuracyRequirements: [] },
          { sceneNumber: 2, intendedDurationMs: 5_000, purpose: "Detail", sourceType: "AI_VIDEO" as const, generationPrompt: "Detail video", overlayText: "DETAIL", referenceAssetIds: [source], accuracyRequirements: [] },
          { sceneNumber: 3, intendedDurationMs: 5_000, purpose: "CTA", sourceType: "PRODUCT_IMAGE" as const, generationPrompt: "Static product", overlayText: "CREATE", referenceAssetIds: [source], accuracyRequirements: [] }
        ]
      },
      submission: { providerTaskId: "concept", requestId: "concept", provider: "fake", model: "fake", metadata: { operationKey: context.operationKey } }
    };
  }
}

class NamedVideoProvider implements VideoGenerationProvider {
  readonly requiresExternalMedia = false;
  readonly submissions: ProviderOperationContext[] = [];
  readonly inputs: Parameters<VideoGenerationProvider["submit"]>[0][] = [];
  constructor(readonly providerKey: string, readonly defaultModel: string) {}
  async submit(input: Parameters<VideoGenerationProvider["submit"]>[0], context: ProviderOperationContext): Promise<ProviderSubmission> {
    this.inputs.push(input);
    this.submissions.push(context);
    return { providerTaskId: `${this.providerKey}-${context.targetId}`, requestId: context.targetId, provider: this.providerKey, model: this.defaultModel, metadata: { fake: true } };
  }
  async getStatus(): Promise<ProviderJobStatus<VideoGenerationOutput>> {
    return { state: "SUCCEEDED", result: { kind: "INLINE", payload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4", extension: "mp4", metadata: { width: 720, height: 1280, durationMs: 5_000, hasVideo: true, hasAudio: false, videoCodec: "h264" } } } };
  }
}

async function setup(creative = new MixedCreative()) {
  const root = await mkdtemp(join(tmpdir(), "koolezt-mixed-video-")); roots.push(root);
  const storage = new LocalStorageProvider(join(root, "media"));
  const image = await storage.put("products/mockup.png", { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png", extension: "png", metadata: {} });
  const fake = new NamedVideoProvider("fake", "fake-video-v1");
  const seedance = new NamedVideoProvider("seedance", "dreamina-seedance-2-5-260628");
  const kling = new NamedVideoProvider("kling", "kling-3.0-turbo");
  const service = new CreativeFactoryService({
    repository: new InMemoryFactoryRepository(), creativeProvider: creative, videoProvider: fake,
    videoProviders: new VideoProviderRegistry({ fake, seedance, kling }, "fake"), defaultVideoProviderKey: "fake",
    voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  const product = await service.createProduct({ name: "Sign", slug: "sign", description: "Address sign", claims: [], defaultCta: "Create yours", assets: [{ id: image.id, kind: "IMAGE", label: "Mockup", storageKey: image.storageKey, mimeType: image.mimeType }] });
  let project = await service.createProject({ productId: product.id, selectedProductAssetIds: [image.id], preferredVoiceProfileId: "voice", actor: "test" });
  project = await service.generateConcept(project.id, "test");
  project = await service.approveConcept(project.id, "test");
  return { service, project, fake, seedance, kling, storage };
}

describe("per-scene video provider workflow", () => {
  it("keeps provider/model immutable per attempt and composes accepted mixed-provider assets", async () => {
    const fixture = await setup();
    let project = await fixture.service.setSceneVideoProvider(fixture.project.id, fixture.project.scenes[0]!.id, "seedance", "test");
    project = await fixture.service.setSceneVideoProvider(project.id, project.scenes[1]!.id, "kling", "test");
    project = await fixture.service.setSceneGenerationMethod(project.id, project.scenes[0]!.id, "API", "test");
    project = await fixture.service.setSceneGenerationMethod(project.id, project.scenes[1]!.id, "API", "test");
    project = await fixture.service.setSceneGenerationMethod(project.id, fixture.project.scenes[2]!.id, "API", "test"); // Explicit legacy/static path; normal Phase 1 PRODUCT_IMAGE scenes remain manual.
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    const [scene1, scene2, scene3] = project.scenes;
    expect(scene1!.attempts[0]).toMatchObject({ provider: "seedance", providerModel: "dreamina-seedance-2-5-260628", sourceType: "AI_VIDEO", status: "REVIEW" });
    expect(scene2!.attempts[0]).toMatchObject({ provider: "kling", providerModel: "kling-3.0-turbo", status: "REVIEW" });
    expect(scene3!.attempts[0]).toMatchObject({ sourceType: "PRODUCT_IMAGE", status: "REVIEW" });
    expect(fixture.seedance.submissions).toHaveLength(1); expect(fixture.kling.submissions).toHaveLength(1); expect(fixture.fake.submissions).toHaveLength(0);

    project = await fixture.service.approveScene(project.id, scene2!.id, scene2!.attempts[0]!.id, "test");
    project = await fixture.service.approveScene(project.id, scene3!.id, scene3!.attempts[0]!.id, "test");
    project = await fixture.service.rejectSceneAttempt(project.id, scene1!.id, scene1!.attempts[0]!.id, "test");
    project = await fixture.service.setSceneVideoProvider(project.id, scene1!.id, "kling", "test");
    project = await fixture.service.regenerateScene(project.id, scene1!.id, "New opening", "test");
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    const regenerated = project.scenes.find((scene) => scene.id === scene1!.id)!;
    expect(regenerated.attempts).toHaveLength(2);
    expect(regenerated.attempts[0]).toMatchObject({ provider: "seedance", providerModel: "dreamina-seedance-2-5-260628", status: "REJECTED" });
    expect(regenerated.attempts[1]).toMatchObject({ provider: "kling", providerModel: "kling-3.0-turbo", status: "REVIEW" });
    expect(project.scenes.find((scene) => scene.id === scene2!.id)?.attempts).toHaveLength(1);
    expect(project.scenes.find((scene) => scene.id === scene3!.id)?.attempts).toHaveLength(1);

    project = await fixture.service.approveScene(project.id, regenerated.id, regenerated.attempts[1]!.id, "test");
    project = await fixture.service.generateVoice(project.id, "test");
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    project = await fixture.service.approveVoice(project.id, project.currentVoiceGenerationId!, "test");
    project = await fixture.service.markEditorWorkComplete(project.id, "editor");
    project = await fixture.service.renderFinal(project.id, "test", "fake");
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    expect(project.state).toBe("FINAL_REVIEW");
    expect(project.renders[0]?.inputSnapshot.sceneInputs).toHaveLength(3);
  });

  it("reads legacy KLING_VIDEO concepts without rewriting stored concept semantics", async () => {
    const fixture = await setup(new MixedCreative("KLING_VIDEO"));
    const project = await fixture.service.getProject(fixture.project.id);
    expect(project.concepts[0]?.scenes[0]?.sourceType).toBe("KLING_VIDEO");
    expect(project.scenes[0]?.requestedVideoProvider).toBe("kling");
    expect(project.scenes[0]?.attempts[0]).toMatchObject({ sourceType: "AI_VIDEO", provider: "kling", providerModel: "kling-3.0-turbo" });
  });

  it("binds an authorized context image to the attempt and submits that exact image identity", async () => {
    const fixture = await setup();
    const scene = fixture.project.scenes[0]!;
    const attempt = scene.attempts[0]!;
    const sourceReferenceAssetIds = fixture.project.concepts[0]!.scenes[0]!.referenceAssetIds;
    const stored = await fixture.storage.put(`projects/${fixture.project.id}/scenes/${scene.id}/context.png`, {
      bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png", extension: "png", metadata: {}
    });
    const context = {
      ...stored,
      projectId: fixture.project.id,
      purpose: "SCENE_CONTEXT_IMAGE",
      metadata: { sceneId: scene.id, attemptId: attempt.id, sourceReferenceAssetIds, productFidelityConfirmed: true }
    };
    let project = await fixture.service.attachSceneContextImage({ projectId: fixture.project.id, sceneId: scene.id, asset: context, actor: "editor" });
    expect(project.scenes[0]!.attempts[0]!.inputAssetId).toBe(context.id);
    project = await fixture.service.setSceneVideoProvider(project.id, scene.id, "seedance", "editor");
    project = await fixture.service.setSceneGenerationMethod(project.id, scene.id, "API", "editor");
    await fixture.service.processAllPendingJobs(project.id);
    expect(fixture.seedance.inputs).toHaveLength(1);
    expect(fixture.seedance.inputs[0]).toMatchObject({ referenceAssetIds: [context.id] });
  });

  it("fails configuration before a selected real provider can submit", async () => {
    const unavailable = new UnavailableVideoGenerationProvider("seedance", "dreamina-seedance-2-5-260628", "SEEDANCE_CONFIGURATION_MISSING", "Seedance key is missing.");
    await expect(unavailable.submit({ ...({ sceneNumber: 1, durationMs: 5_000, prompt: "x", sourceType: "AI_VIDEO", referenceAssetIds: [], generationMode: "TEXT_TO_VIDEO", accuracyRequirements: [] } as const) }, { operationKey: "op", projectId: "project", targetId: "attempt" })).rejects.toEqual(new DomainError("SEEDANCE_CONFIGURATION_MISSING", "Seedance key is missing."));
  });
});
