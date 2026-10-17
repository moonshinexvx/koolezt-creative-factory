import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import type { CreativeProvider, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, VideoGenerationOutput, VideoGenerationProvider } from "@koolezt/domain";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeVoiceProvider } from "@koolezt/providers";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class ManualCreative implements CreativeProvider {
  async generateConcept(input: Parameters<CreativeProvider["generateConcept"]>[0], context: ProviderOperationContext) {
    const source = input.selectedAssets[0]!.id;
    return { concept: { angle: "Manual", hook: "See it", targetDurationMs: 15_000, voiceScript: "A custom sign for your home.", cta: input.defaultCta, editingStyleKey: "UGC_FAST/v1", musicCategory: "none", scenes: [
      { sceneNumber: 1, intendedDurationMs: 5_000, purpose: "Hook", sourceType: "AI_VIDEO" as const, generationPrompt: "External clip one", overlayText: "LOOK", referenceAssetIds: [source], accuracyRequirements: ["No readable address"] },
      { sceneNumber: 2, intendedDurationMs: 5_000, purpose: "Product", sourceType: "PRODUCT_IMAGE" as const, generationPrompt: "Exact product", overlayText: "DETAIL", referenceAssetIds: [source], accuracyRequirements: [] },
      { sceneNumber: 3, intendedDurationMs: 5_000, purpose: "Close", sourceType: "AI_VIDEO" as const, generationPrompt: "External clip three", overlayText: "CREATE", referenceAssetIds: [source], accuracyRequirements: [] }
    ] }, submission: { providerTaskId: "concept", requestId: "concept", provider: "fake", model: "fake", metadata: { operationKey: context.operationKey } } };
  }
}

class NeverVideoProvider implements VideoGenerationProvider {
  calls = 0; readonly defaultModel = "fake"; readonly providerKey = "fake";
  async submit(): Promise<ProviderSubmission> { this.calls += 1; throw new Error("manual scenes must not submit a provider request"); }
  async getStatus(): Promise<ProviderJobStatus<VideoGenerationOutput>> { throw new Error("manual scenes must not poll a provider"); }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "koolezt-manual-video-")); roots.push(root);
  const storage = new LocalStorageProvider(join(root, "media"));
  const image = await storage.put("products/mockup.png", { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png", extension: "png", metadata: {} });
  const video = new NeverVideoProvider();
  const service = new CreativeFactoryService({ repository: new InMemoryFactoryRepository(), creativeProvider: new ManualCreative(), videoProvider: video, voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
  const product = await service.createProduct({ name: "Sign", slug: "sign", description: "Sign", claims: [], defaultCta: "Create", assets: [{ id: image.id, kind: "IMAGE", label: "mockup", storageKey: image.storageKey, mimeType: image.mimeType }] });
  let project = await service.createProject({ productId: product.id, selectedProductAssetIds: [image.id], preferredVoiceProfileId: "voice", actor: "test" });
  project = await service.generateConcept(project.id, "test");
  project = await service.approveConcept(project.id, "test");
  return { service, storage, video, project };
}

async function fixtureVideo(storage: LocalStorageProvider, key: string) {
  return storage.put(key, { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "video/mp4", extension: "mp4", metadata: { width: 1080, height: 1920, durationMs: 5_000, hasVideo: true, hasAudio: false, videoCodec: "h264" } });
}

describe("manual external AI-video workflow", () => {
  it("stores a revised operator prompt in a new manual attempt while retaining context-image provenance", async () => {
    const fixture = await setup();
    const scene = fixture.project.scenes[0]!;
    const original = scene.attempts[0]!;
    const stored = await fixture.storage.put(`projects/${fixture.project.id}/scenes/${scene.id}/context.png`, {
      bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png", extension: "png", metadata: {}
    });
    const context = {
      ...stored,
      projectId: fixture.project.id,
      purpose: "SCENE_CONTEXT_IMAGE",
      metadata: { sceneId: scene.id, attemptId: original.id, sourceReferenceAssetIds: fixture.project.concepts[0]!.scenes[0]!.referenceAssetIds, productFidelityConfirmed: true }
    };
    let project = await fixture.service.attachSceneContextImage({ projectId: fixture.project.id, sceneId: scene.id, asset: context, actor: "editor" });
    project = await fixture.service.regenerateScene(project.id, scene.id, "Subtle push-in only. No text, UI, icons, or Product changes.", "editor", "MANUAL");
    const attempts = project.scenes[0]!.attempts;
    expect(attempts[0]).toMatchObject({ id: original.id, prompt: "External clip one", inputAssetId: context.id });
    expect(attempts[1]).toMatchObject({
      prompt: "Subtle push-in only. No text, UI, icons, or Product changes.",
      generationMethod: "MANUAL",
      inputAssetId: context.id,
      replacesAttemptId: original.id,
      status: "PENDING"
    });
    expect(fixture.video.calls).toBe(0);
  });

  it("allows a pending manual scene to be replaced while other scenes are still generating", async () => {
    const fixture = await setup();
    const scene = fixture.project.scenes[0]!;
    const updated = await fixture.service.regenerateScene(fixture.project.id, scene.id, "Revised external brief", "editor");
    expect(updated.state).toBe("SCENES_REVIEW");
    expect(updated.scenes[0]?.attempts).toHaveLength(2);
    expect(updated.scenes[0]?.attempts[1]).toMatchObject({ generationMethod: "MANUAL", status: "PENDING", replacesAttemptId: scene.attempts[0]?.id });
    expect(fixture.video.calls).toBe(0);
  });

  it("keeps manual provider provenance immutable and composes accepted internal media without provider calls", async () => {
    const fixture = await setup();
    expect(await fixture.service.listJobs(fixture.project.id)).toHaveLength(0);
    let project = await fixture.service.getProject(fixture.project.id);
    const [one, two, three] = project.scenes;
    project = await fixture.service.uploadManualSceneVideo({ projectId: project.id, sceneId: one!.id, asset: await fixtureVideo(fixture.storage, "manual/one.mp4"), provider: "kling", actor: "editor" });
    project = await fixture.service.uploadManualSceneVideo({ projectId: project.id, sceneId: two!.id, asset: await fixtureVideo(fixture.storage, "manual/two.mp4"), provider: "kling", actor: "editor" });
    project = await fixture.service.uploadManualSceneVideo({ projectId: project.id, sceneId: three!.id, asset: await fixtureVideo(fixture.storage, "manual/three.mp4"), provider: "seedance", model: "seedance-test", actor: "editor" });
    project = await fixture.service.rejectSceneAttempt(project.id, one!.id, project.scenes.find((scene) => scene.id === one!.id)!.attempts[0]!.id, "editor");
    project = await fixture.service.uploadManualSceneVideo({ projectId: project.id, sceneId: one!.id, asset: await fixtureVideo(fixture.storage, "manual/one-replacement.mp4"), provider: "seedance", actor: "editor" });
    const current = await fixture.service.getProject(project.id); const sceneOne = current.scenes.find((scene) => scene.id === one!.id)!;
    expect(sceneOne.attempts).toMatchObject([{ generationMethod: "MANUAL", provider: "kling", status: "REJECTED" }, { generationMethod: "MANUAL", provider: "seedance", status: "REVIEW" }]);
    expect(current.scenes.find((scene) => scene.id === two!.id)!.attempts[0]).toMatchObject({ sourceType: "PRODUCT_IMAGE", generationMethod: "MANUAL", provider: "kling", status: "REVIEW" });
    expect(current.scenes.find((scene) => scene.id === three!.id)!.attempts[0]).toMatchObject({ generationMethod: "MANUAL", provider: "seedance", status: "REVIEW" });
    project = await fixture.service.approveScene(current.id, sceneOne.id, sceneOne.attempts[1]!.id, "editor");
    const sceneTwo = project.scenes.find((scene) => scene.id === two!.id)!; project = await fixture.service.approveScene(project.id, sceneTwo.id, sceneTwo.attempts[0]!.id, "editor");
    const sceneThree = project.scenes.find((scene) => scene.id === three!.id)!; project = await fixture.service.approveScene(project.id, sceneThree.id, sceneThree.attempts[0]!.id, "editor");
    project = await fixture.service.generateVoice(project.id, "editor"); await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id); project = await fixture.service.approveVoice(project.id, project.currentVoiceGenerationId!, "editor"); project = await fixture.service.markEditorWorkComplete(project.id, "editor"); project = await fixture.service.renderFinal(project.id, "owner", "fake"); await fixture.service.processAllPendingJobs(project.id);
    expect((await fixture.service.getProject(project.id)).state).toBe("FINAL_REVIEW");
    expect(fixture.video.calls).toBe(0);
  });
  it("reopens an accepted scene from final review for a manual replacement without losing history", async () => {
    const fixture = await setup();
    let project = await fixture.service.getProject(fixture.project.id);
    for (const scene of project.scenes) {
      project = await fixture.service.uploadManualSceneVideo({ projectId: project.id, sceneId: scene.id, asset: await fixtureVideo(fixture.storage, `manual/${scene.id}.mp4`), provider: "kling", actor: "editor" });
      const current = project.scenes.find((candidate) => candidate.id === scene.id)!;
      project = await fixture.service.approveScene(project.id, current.id, current.attempts.at(-1)!.id, "editor");
    }
    project = await fixture.service.generateVoice(project.id, "editor");
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    project = await fixture.service.approveVoice(project.id, project.currentVoiceGenerationId!, "editor");
    project = await fixture.service.markEditorWorkComplete(project.id, "editor");
    project = await fixture.service.renderFinal(project.id, "owner", "fake");
    await fixture.service.processAllPendingJobs(project.id);
    project = await fixture.service.getProject(project.id);
    expect(project.state).toBe("FINAL_REVIEW");

    const scene = project.scenes[0]!;
    const acceptedAttemptId = scene.approvedAttemptId;
    const replacement = await fixture.service.regenerateScene(project.id, scene.id, scene.attempts.at(-1)!.prompt, "editor", "MANUAL");
    const reopenedScene = replacement.scenes.find((candidate) => candidate.id === scene.id)!;

    expect(replacement.state).toBe("SCENES_REVIEW");
    expect(reopenedScene.approvedAttemptId).toBeUndefined();
    expect(reopenedScene.attempts).toHaveLength(2);
    expect(reopenedScene.attempts[0]).toMatchObject({ id: acceptedAttemptId, status: "ACCEPTED" });
    expect(reopenedScene.attempts[1]).toMatchObject({ generationMethod: "MANUAL", status: "PENDING", replacesAttemptId: acceptedAttemptId });
    expect(replacement.renders).toHaveLength(1);
    expect(fixture.video.calls).toBe(0);
  });
});
