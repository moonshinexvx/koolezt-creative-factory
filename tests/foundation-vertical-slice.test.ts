import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import { DomainError } from "@koolezt/domain";
import type { VoiceProvider } from "@koolezt/domain";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import {
  LocalReadyPublisher,
  LocalStorageProvider,
  FakeExternalMediaDeliveryProvider,
  InlineCompositionOutputIngestor,
  MetadataMediaInspector,
  mediaSecurity
} from "@koolezt/media";
import {
  FakeCompositionProvider,
  FakeCreativeProvider,
  FakeVideoGenerationProvider,
  FakeVoiceProvider
} from "@koolezt/providers";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(options: Readonly<{ voiceProvider?: VoiceProvider }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "koolezt-factory-test-"));
  temporaryRoots.push(root);
  const workingRoot = join(root, "working");
  const readyRoot = join(root, "Ready");
  const repository = new InMemoryFactoryRepository();
  const creativeProvider = new FakeCreativeProvider();
  const videoProvider = new FakeVideoGenerationProvider();
  const voiceProvider = options.voiceProvider ?? new FakeVoiceProvider();
  const compositionProvider = new FakeCompositionProvider();
  const externalMediaDelivery = new FakeExternalMediaDeliveryProvider();
  const fixedDate = new Date("2026-08-29T08:00:00.000Z");
  const now = () => fixedDate;
  const storage = new LocalStorageProvider(workingRoot, now);
  const readyPublisher = new LocalReadyPublisher(readyRoot, storage, now);
  const service = new CreativeFactoryService({
    repository,
    creativeProvider,
    videoProvider,
    voiceProvider: voiceProvider as FakeVoiceProvider,
    compositionProvider,
    externalMediaDelivery,
    compositionOutputIngestor: new InlineCompositionOutputIngestor(),
    storage,
    mediaInspector: new MetadataMediaInspector(),
    readyPublisher,
    now
  });

  const product = await service.createProduct({
    name: "Personalized Metal Address Sign",
    slug: "personalized-metal-address-sign",
    description: "A personalized powder-coated metal address sign.",
    claims: [
      { kind: "FEATURE", text: "Black powder-coated steel" },
      { kind: "FEATURE", text: "Personalized house number and street name" },
      { kind: "SELLING_POINT", text: "Live personalization preview" },
      { kind: "RESTRICTION", text: "Do not change names or house numbers in mockups" }
    ],
    defaultCta: "Create yours",
    assets: [
      {
        id: "product-mockup-1",
        kind: "IMAGE",
        label: "Six-dog address sign mockup",
        storageKey: "library/products/sign/mockup.png",
        mimeType: "image/png"
      }
    ]
  });
  return {
    root,
    readyRoot,
    repository,
    creativeProvider,
    videoProvider,
    voiceProvider: voiceProvider as FakeVoiceProvider,
    compositionProvider,
    externalMediaDelivery,
    service,
    product
  };
}

describe("Phase 1 foundation vertical slice", () => {
  it("preserves the approved, independently regenerated workflow through atomic READY save", async () => {
    const setup = await fixture();
    let project = await setup.service.createProject({
      productId: setup.product.id,
      selectedProductAssetIds: ["product-mockup-1"],
      additionalInstructions: "Keep the product mockup accurate.",
      preferredVoiceProfileId: "female-ugc",
      actor: "owner"
    });

    expect(project.publicId).toBe("CF-000001");
    expect(project.state).toBe("DRAFT");

    project = await setup.service.generateConcept(project.id, "owner");
    expect(project.state).toBe("CONCEPT_REVIEW");
    expect(project.concepts).toHaveLength(1);
    expect(project.concepts[0]?.scenes).toHaveLength(3);
    expect(setup.videoProvider.submissions).toHaveLength(0);
    expect(await setup.service.listJobs(project.id)).toHaveLength(0);

    project = await setup.service.approveConcept(project.id, "owner");
    for (const scene of project.scenes) project = await setup.service.setSceneGenerationMethod(project.id, scene.id, "API", "owner");
    expect(project.state).toBe("SCENES_GENERATING");
    expect(project.scenes).toHaveLength(3);
    const sceneJobs = await setup.service.listJobs(project.id);
    expect(sceneJobs).toHaveLength(3);

    const firstJob = sceneJobs[0];
    expect(firstJob).toBeDefined();
    await setup.service.processJob(firstJob!.id);
    await setup.service.processJob(firstJob!.id);
    await setup.service.processAllPendingJobs(project.id);
    expect(setup.videoProvider.submissions).toHaveLength(3);

    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("SCENES_REVIEW");
    const [scene1, scene2, scene3] = project.scenes;
    expect(scene1 && scene2 && scene3).toBeTruthy();
    const firstScene2Attempt = scene2!.attempts[0]!;
    project = await setup.service.approveScene(
      project.id,
      scene1!.id,
      scene1!.attempts[0]!.id,
      "owner"
    );
    project = await setup.service.approveScene(
      project.id,
      scene3!.id,
      scene3!.attempts[0]!.id,
      "owner"
    );
    project = await setup.service.rejectSceneAttempt(
      project.id,
      scene2!.id,
      firstScene2Attempt.id,
      "owner"
    );
    project = await setup.service.regenerateScene(
      project.id,
      scene2!.id,
      "Revised scene 2 prompt preserving the exact house number.",
      "owner"
    );
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);

    const regeneratedScene2 = project.scenes.find((scene) => scene.id === scene2!.id)!;
    expect(regeneratedScene2.attempts).toHaveLength(2);
    expect(regeneratedScene2.attempts[0]?.status).toBe("REJECTED");
    expect(project.scenes.find((scene) => scene.id === scene1!.id)?.attempts).toHaveLength(1);
    expect(project.scenes.find((scene) => scene.id === scene3!.id)?.attempts).toHaveLength(1);
    expect(setup.videoProvider.submissions).toHaveLength(4);

    project = await setup.service.approveScene(
      project.id,
      regeneratedScene2.id,
      regeneratedScene2.attempts[1]!.id,
      "owner"
    );
    expect(project.state).toBe("VOICE_REVIEW");

    project = await setup.service.generateVoice(project.id, "owner");
    expect(project.state).toBe("VOICE_GENERATING");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    project = await setup.service.approveVoice(project.id, project.currentVoiceGenerationId!, "owner");
    expect(project.state).toBe("VOICE_REVIEW");
    expect(project.renders).toHaveLength(0);
    expect(setup.compositionProvider.submissions).toHaveLength(0);
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    expect(project.state).toBe("READY_FOR_RENDER");
    project = await setup.service.renderFinal(project.id, "owner", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);

    expect(setup.voiceProvider.submissions).toHaveLength(1);
    expect(setup.compositionProvider.submissions).toHaveLength(1);
    expect(project.state).toBe("FINAL_REVIEW");
    expect(project.renders).toHaveLength(1);
    expect(project.renders[0]?.requestedProvider).toBe("fake");
    expect(project.renders[0]?.inspection?.passed).toBe(true);
    expect(project.renders[0]?.inputSnapshot.sceneInputs).toHaveLength(3);
    expect(project.renders[0]?.inputSnapshot.narration.captionTimings.length).toBeGreaterThan(0);
    expect(setup.externalMediaDelivery.staged).toHaveLength(4);
    expect(setup.externalMediaDelivery.cleanedOperationIds).toContain(project.renders[0]?.operationKey);
    expect(project.usageCosts.map((cost) => cost.operationType)).toEqual([
      "CONCEPT",
      "VIDEO",
      "VIDEO",
      "VIDEO",
      "VIDEO",
      "VOICE",
      "COMPOSITION"
    ]);

    project = await setup.service.approveAndSave(project.id, "owner");
    expect(project.state).toBe("READY");
    expect(project.readyFile?.path).toBe(
      join(
        setup.readyRoot,
        "2026-08-29",
        "personalized-metal-address-sign_CF-000001.mp4"
      )
    );
    expect(project.readyFile?.sha256).toBe(project.renders[0]?.outputSha256);
    const published = await readFile(project.readyFile!.path, "utf8");
    expect(published).toContain("FAKE_RENDER_NOT_A_REAL_MP4");
    expect(project.approvals.filter((approval) => approval.stage === "SCENE")).toHaveLength(4);
    expect(project.approvals.some((approval) => approval.stage === "FINAL")).toBe(true);
    expect(project.auditEvents.at(-1)?.type).toBe("PROJECT_PUBLISHED_READY");
  });

  it("keeps an immutable render snapshot when Render Again creates a new operation", async () => {
    const setup = await fixture();
    let project = await setup.service.createProject({ productId: setup.product.id, selectedProductAssetIds: ["product-mockup-1"], preferredVoiceProfileId: "female-ugc", actor: "owner" });
    project = await setup.service.generateConcept(project.id, "owner");
    project = await setup.service.approveConcept(project.id, "owner");
    for (const scene of project.scenes) project = await setup.service.setSceneGenerationMethod(project.id, scene.id, "API", "owner");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    for (const scene of project.scenes) project = await setup.service.approveScene(project.id, scene.id, scene.attempts[0]!.id, "owner");
    project = await setup.service.generateVoice(project.id, "owner");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    project = await setup.service.approveVoice(project.id, project.currentVoiceGenerationId!, "owner");
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "owner", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    const original = structuredClone(project.renders[0]!.inputSnapshot);
    project = await setup.service.renderAgain(project.id, "owner");
    expect(project.renders).toHaveLength(2);
    expect(project.renders[0]!.inputSnapshot).toEqual(original);
    expect(project.renders[1]!.operationKey).not.toBe(project.renders[0]!.operationKey);
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("FINAL_REVIEW");
    expect(project.renders[1]!.inspection?.passed).toBe(true);
  });

  it("continues through composition when the voice provider has no native word timings", async () => {
    const untimedVoice: VoiceProvider = {
      submit: async (_input, context) => ({ providerTaskId: `openai-tts:${context.operationKey}`, requestId: "req_tts", provider: "openai", model: "gpt-4o-mini-tts", metadata: { nativeWordTimings: false } }),
      getStatus: async () => ({ state: "SUCCEEDED", result: { bytes: new TextEncoder().encode("audio"), mimeType: "audio/mpeg", extension: "mp3", metadata: { hasAudio: true, durationMs: 1_000, captionTimings: [] } } })
    };
    const setup = await fixture({ voiceProvider: untimedVoice });
    let project = await setup.service.createProject({ productId: setup.product.id, selectedProductAssetIds: ["product-mockup-1"], preferredVoiceProfileId: "female-ugc", actor: "owner" });
    project = await setup.service.generateConcept(project.id, "owner");
    project = await setup.service.approveConcept(project.id, "owner");
    for (const scene of project.scenes) project = await setup.service.setSceneGenerationMethod(project.id, scene.id, "API", "owner");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    for (const scene of project.scenes) project = await setup.service.approveScene(project.id, scene.id, scene.attempts[0]!.id, "owner");
    project = await setup.service.generateVoice(project.id, "owner");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    project = await setup.service.approveVoice(project.id, project.currentVoiceGenerationId!, "owner");
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "owner", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("FINAL_REVIEW");
    expect(project.renders[0]?.inputSnapshot.narration.captionTimings).toEqual([]);
  });

  it("enforces concept approval before generation jobs or downstream work", async () => {
    const setup = await fixture();
    let project = await setup.service.createProject({
      productId: setup.product.id,
      selectedProductAssetIds: ["product-mockup-1"],
      preferredVoiceProfileId: "female-warm",
      actor: "staff"
    });
    project = await setup.service.generateConcept(project.id, "staff");
    expect(await setup.service.listJobs(project.id)).toHaveLength(0);
    await expect(setup.service.generateVoice(project.id, "staff")).rejects.toMatchObject({
      code: "INVALID_PROJECT_STATE"
    });
    expect(setup.videoProvider.submissions).toHaveLength(0);
  });

  it("creates a new immutable concept revision when staff edits the draft", async () => {
    const setup = await fixture();
    let project = await setup.service.createProject({
      productId: setup.product.id,
      selectedProductAssetIds: ["product-mockup-1"],
      preferredVoiceProfileId: "female-excited",
      actor: "staff"
    });
    project = await setup.service.generateConcept(project.id, "staff");
    const originalId = project.currentConceptId;
    project = await setup.service.editConcept(
      project.id,
      { hook: "A sign for every dog in the family" },
      "staff"
    );
    expect(project.concepts).toHaveLength(2);
    expect(project.concepts.find((concept) => concept.id === originalId)?.status).toBe("SUPERSEDED");
    expect(project.concepts.at(-1)?.source).toBe("USER_EDIT");
    expect(project.concepts.at(-1)?.hook).toBe("A sign for every dog in the family");
  });
});

describe("media path safety", () => {
  it("rejects absolute and traversal keys", () => {
    expect(() => mediaSecurity.containedPath("C:\\factory\\working", "..\\secret.txt")).toThrow(
      DomainError
    );
    expect(() => mediaSecurity.containedPath("C:\\factory\\working", "C:\\Windows\\x")).toThrow(
      DomainError
    );
  });

  it("sanitizes READY filename segments deterministically", () => {
    expect(mediaSecurity.sanitizeSegment(" Metal / Address : Sign ")).toBe("Metal_Address_Sign");
    expect(mediaSecurity.sanitizeSegment("../../")).toBe("creative");
  });
});
