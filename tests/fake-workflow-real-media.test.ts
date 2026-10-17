import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, FfprobeMediaInspector, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";

const ffprobe = process.env.FFPROBE_PATH ?? resolve(
  `node_modules/ffprobe-static/bin/${process.platform}/${process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64"}/ffprobe${process.platform === "win32" ? ".exe" : ""}`
);

describe("fake-provider workflow with real media QA", () => {
  it("publishes a valid vertical MP4 to READY", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-workflow-"));
    const storage = new LocalStorageProvider(join(root, "working"));
    const service = new CreativeFactoryService({ repository: new InMemoryFactoryRepository(), creativeProvider: new FakeCreativeProvider(), videoProvider: new FakeVideoGenerationProvider(resolve("tests/fixtures/vertical-1080x1920.mp4")), voiceProvider: new FakeVoiceProvider(resolve("tests/fixtures/vertical-1080x1920.mp4")), compositionProvider: new FakeCompositionProvider(resolve("tests/fixtures/vertical-1080x1920.mp4")), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new FfprobeMediaInspector(join(root, "working"), ffprobe), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
    const product = await service.createProduct({ name: "Sign", slug: "sign", description: "Personalized sign", claims: [], defaultCta: "Create", assets: [{ id: "mockup", kind: "IMAGE", label: "Mockup", storageKey: "mockup.png", mimeType: "image/png" }] });
    let project = await service.createProject({ productId: product.id, selectedProductAssetIds: ["mockup"], preferredVoiceProfileId: "female-ugc", actor: "test" });
    project = await service.generateConcept(project.id, "test");
    project = await service.approveConcept(project.id, "test");
    for (const scene of project.scenes) {
      if (scene.attempts[0]?.sourceType === "AI_VIDEO") project = await service.setSceneGenerationMethod(project.id, scene.id, "API", "test");
    }
    await service.processAllPendingJobs(project.id);
    project = await service.getProject(project.id);
    for (const scene of project.scenes) project = await service.approveScene(project.id, scene.id, scene.attempts.at(-1)!.id, "test");
    project = await service.generateVoice(project.id, "test");
    await service.processAllPendingJobs(project.id);
    project = await service.getProject(project.id);
    project = await service.approveVoice(project.id, project.currentVoiceGenerationId!, "test");
    project = await service.markEditorWorkComplete(project.id, "editor");
    project = await service.renderFinal(project.id, "test", "fake");
    await service.processAllPendingJobs(project.id);
    project = await service.approveAndSave(project.id, "test");
    expect(project.state).toBe("READY");
    expect(project.renders.at(-1)?.inspection?.passed).toBe(true);
    expect((await stat(project.readyFile!.path)).size).toBeGreaterThan(0);
  });
});
