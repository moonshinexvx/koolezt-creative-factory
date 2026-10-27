import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CreativeFactoryService } from "@koolezt/application";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";
import { buildServer } from "../apps/api/src/server.js";
import type { CreativeProvider, GeneratedAsset } from "@koolezt/domain";
import { createNewProjectWorkflow, validateNewProject } from "../apps/web/src/project-create.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const sha256 = createHash("sha256").update(png).digest("hex");

async function setupService(provider?: CreativeProvider) {
  const creativeProvider = provider ?? new FakeCreativeProvider();
  const root = await mkdtemp(join(tmpdir(), "koolezt-create-project-"));
  const repository = new InMemoryFactoryRepository();
  const storage = new LocalStorageProvider(join(root, "media"));
  const service = new CreativeFactoryService({
    repository,
    creativeProvider,
    videoProvider: new FakeVideoGenerationProvider(),
    voiceProvider: new FakeVoiceProvider(),
    compositionProvider: new FakeCompositionProvider(),
    externalMediaDelivery: new FakeExternalMediaDeliveryProvider(),
    compositionOutputIngestor: new InlineCompositionOutputIngestor(),
    storage,
    mediaInspector: new MetadataMediaInspector(),
    readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  return { service, repository, creativeProvider, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe("operator project creation", () => {
  it("creates a DRAFT product/project atomically without provider work and deduplicates retries", async () => {
    const { service, repository, creativeProvider, dispose } = await setupService();
    try {
      const input = { requestId, name: " Vertical Pet Ornament ", creativeTopic: " Christmas gift for dog lovers ", productDetails: "Personalized pet photo", verifiedClaims: ["Uses the supplied pet photo"], targetDurationSeconds: 15, actor: "editor" };
      const [first, duplicate] = await Promise.all([service.createProjectFromBrief(input), service.createProjectFromBrief(input)]);
      expect(duplicate.id).toBe(first.id);
      expect(duplicate.publicId).toBe(first.publicId);
      expect(first).toMatchObject({ state: "DRAFT", campaignWorkspace: true, selectedProductAssetIds: [], concepts: [], scenes: [], voiceGenerations: [], renders: [] });
      expect(await repository.listProjects()).toHaveLength(1);
      const product = await service.getProduct(first.productId);
      expect(product).toMatchObject({ name: "Vertical Pet Ornament", description: "Personalized pet photo", creativeNotes: "Christmas gift for dog lovers", assets: [] });
      expect(product.claims).toEqual([{ kind: "FEATURE", text: "Uses the supplied pet photo" }]);
      expect(first.creativeBrief).toEqual({ creativeTopic: "Christmas gift for dog lovers", productDetails: "Personalized pet photo", targetDurationSeconds: 15 });
      expect(await service.listJobs(first.id)).toEqual([]);
    } finally { await dispose(); }
      expect((creativeProvider as FakeCreativeProvider).calls).toHaveLength(0);
  });

  it("allocates unique server-side public IDs for concurrent distinct requests", async () => {
    const { service, dispose } = await setupService();
    try {
      const create = (id: string) => service.createProjectFromBrief({ requestId: id, name: "Project", creativeTopic: "Angle", productDetails: "", targetDurationSeconds: 15, actor: "editor" });
      const projects = await Promise.all([
        create("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        create("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      ]);
      expect(new Set(projects.map((project) => project.publicId)).size).toBe(2);
    } finally { await dispose(); }
  });

  it("validates the API contract and never creates on invalid input", async () => {
    const createProjectFromBrief = vi.fn();
    const app = buildServer({ service: { createProjectFromBrief } } as never);
    const invalid = await app.inject({ method: "POST", url: "/api/projects/from-brief", payload: { requestId, name: " ", creativeTopic: "", targetDurationSeconds: 1 } });
    expect(invalid.statusCode).toBe(400);
    expect(createProjectFromBrief).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorizes, verifies, and attaches only image references scoped to the DRAFT project", async () => {
    const pending = { id: assetId, kind: "IMAGE", storageKey: `creative-factory/working/${projectId}/${assetId}/33333333-3333-4333-8333-333333333333.png`, storageProvider: "s3", projectId, purpose: "PRODUCT_REFERENCE", lifecycleStatus: "PENDING_UPLOAD", mimeType: "image/png", byteSize: png.byteLength, sha256, metadata: { referenceOrder: 0 }, createdAt: "2026-09-14T00:00:00.000Z" } as const;
    const createUpload = vi.fn(async () => ({ asset: pending, method: "PUT", url: "https://private.example/exact-object?redacted", headers: { "x-amz-meta-sha256": sha256 }, expiresAt: "2026-09-14T00:15:00.000Z" }));
    const completeUpload = vi.fn(async () => ({ ...pending, lifecycleStatus: "AVAILABLE" as const }));
    const rejectUpload = vi.fn();
    const attachProductReference = vi.fn(async () => ({ id: projectId, state: "DRAFT", selectedProductAssetIds: [assetId] }));
    const service = { getProject: vi.fn(async () => ({ id: projectId, state: "DRAFT", concepts: [], selectedProductAssetIds: [] })), attachProductReference };
    const app = buildServer({ durableMediaStore: { createUpload, completeUpload, rejectUpload }, storage: { read: vi.fn(async () => png) }, service } as never);
    const authorized = await app.inject({ method: "POST", url: `/api/projects/${projectId}/product-references/upload`, payload: { filename: "../pet.png", mimeType: "image/png", byteSize: png.byteLength, sha256, order: 0 } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).not.toHaveProperty("storageKey");
    expect(JSON.stringify(authorized.json())).not.toContain("secret");
    expect(createUpload).toHaveBeenCalledWith(expect.objectContaining({ projectId, purpose: "PRODUCT_REFERENCE", kind: "IMAGE", metadata: { referenceOrder: 0, uploadedBy: "development-user" } }));
    const completed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/product-references/complete`, payload: { assetId, label: "Primary Product Reference", order: 0 } });
    expect(completed.statusCode).toBe(200);
    expect(attachProductReference).toHaveBeenCalledWith(expect.objectContaining({ projectId, order: 0, label: "Primary Product Reference" }));
    const video = await app.inject({ method: "POST", url: `/api/projects/${projectId}/product-references/upload`, payload: { filename: "x.mp4", mimeType: "video/mp4", byteSize: 10, sha256, order: 1 } });
    expect(video.statusCode).toBe(400);
    await app.close();
  });

  it("routes Campaign primary-reference selection through the application service", async () => {
    const setPrimaryProductReference = vi.fn(async () => ({ id: projectId, selectedProductAssetIds: [assetId] }));
    const app = buildServer({ service: { setPrimaryProductReference } } as never);
    const response = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/product-references/${assetId}/primary` });
    expect(response.statusCode).toBe(200);
    expect(setPrimaryProductReference).toHaveBeenCalledWith(projectId, assetId, "development-user");
    await app.close();
  });

  it("rejects malformed image bytes after object verification", async () => {
    const pending = { id: assetId, kind: "IMAGE", storageKey: `creative-factory/working/${projectId}/${assetId}/33333333-3333-4333-8333-333333333333.png`, storageProvider: "s3", projectId, purpose: "PRODUCT_REFERENCE", lifecycleStatus: "AVAILABLE", mimeType: "image/png", byteSize: 4, sha256, metadata: { referenceOrder: 0 }, createdAt: "2026-09-14T00:00:00.000Z" } as const;
    const rejectUpload = vi.fn();
    const app = buildServer({ durableMediaStore: { completeUpload: vi.fn(async () => pending), rejectUpload }, storage: { read: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) }, service: { getProject: vi.fn(async () => ({ id: projectId, state: "DRAFT", concepts: [], selectedProductAssetIds: [] })) } } as never);
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/product-references/complete`, payload: { assetId, label: "Primary", order: 0 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("INVALID_MEDIA_SIGNATURE");
    expect(rejectUpload).toHaveBeenCalledWith(assetId, "Image signature verification failed.");
    await app.close();
  });
});

describe("creative concept project isolation", () => {
  const conceptFor = (productName: string, creativeTopic?: string) => ({
    angle: creativeTopic ?? `Angle for ${productName}`,
    hook: `Hook for ${productName}`,
    targetDurationMs: 15_000,
    voiceScript: `Voice for ${productName}`,
    cta: "Create yours today",
    editingStyleKey: "UGC_FAST/v1",
    musicCategory: "UGC upbeat",
    scenes: [1, 2, 3].map((sceneNumber) => ({ sceneNumber, intendedDurationMs: 5_000,
      purpose: `${productName} scene ${sceneNumber}`, sourceType: "AI_VIDEO" as const,
      generationPrompt: `Show only ${productName}`, overlayText: `SCENE ${sceneNumber}`,
      referenceAssetIds: [], accuracyRequirements: [`Keep ${productName} accurate`] }))
  });

  it("binds brief, references, attempts, and operation keys to the current project", async () => {
    const calls: Array<{ input: Parameters<CreativeProvider["generateConcept"]>[0]; context: Parameters<CreativeProvider["generateConcept"]>[1] }> = [];
    const provider: CreativeProvider = { generateConcept: async (input, context) => {
      calls.push({ input, context });
      return { concept: conceptFor(input.productName, input.creativeTopic), submission: { provider: "mock-openai", model: "mock", requestId: `request-${context.projectId}`, providerTaskId: `task-${context.projectId}`, metadata: {} } };
    } };
    const { service, repository, dispose } = await setupService(provider);
    try {
      const first = await service.createProjectFromBrief({ requestId, name: "Pet Ornament", creativeTopic: "Christmas gift for pet lovers", productDetails: "Personalized pet photo", targetDurationSeconds: 15, actor: "editor" });
      const second = await service.createProjectFromBrief({ requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Metal Address Sign", creativeTopic: "Whole family sign", productDetails: "Steel sign", targetDurationSeconds: 15, actor: "editor" });
      // Simulate projects created before the strategy-first flag existed. Legacy/direct
      // Video Maker projects must remain able to generate concepts unchanged.
      await repository.saveProject({ ...first, strategyRequired: false, version: first.version + 1 });
      await repository.saveProject({ ...second, strategyRequired: false, version: second.version + 1 });
      const reference = (id: string, project: string): GeneratedAsset => ({ id, projectId: project, purpose: "PRODUCT_REFERENCE", kind: "IMAGE", storageKey: `private/${id}`, mimeType: "image/png", byteSize: png.byteLength, sha256, lifecycleStatus: "AVAILABLE", metadata: { referenceOrder: 0 }, createdAt: "2026-09-14T00:00:00.000Z" });
      await service.attachProductReference({ projectId: first.id, asset: reference("33333333-3333-4333-8333-333333333333", first.id), label: "Pet reference", order: 0, actor: "editor" });
      await service.attachProductReference({ projectId: second.id, asset: reference("44444444-4444-4444-8444-444444444444", second.id), label: "Sign reference", order: 0, actor: "editor" });
      const firstGenerated = await service.generateConcept(first.id, "editor");
      const secondGenerated = await service.generateConcept(second.id, "editor");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toMatchObject({ productName: "Pet Ornament", creativeTopic: "Christmas gift for pet lovers", selectedAssets: [{ id: "33333333-3333-4333-8333-333333333333" }] });
      expect(calls[1]?.input).toMatchObject({ productName: "Metal Address Sign", creativeTopic: "Whole family sign", selectedAssets: [{ id: "44444444-4444-4444-8444-444444444444" }] });
      expect(calls[0]?.context.operationKey).toContain(first.id);
      expect(calls[1]?.context.operationKey).toContain(second.id);
      expect(firstGenerated.concepts.find((item) => item.id === firstGenerated.currentConceptId)?.hook).toBe("Hook for Pet Ornament");
      expect(secondGenerated.concepts.find((item) => item.id === secondGenerated.currentConceptId)?.hook).toBe("Hook for Metal Address Sign");
      const reset = await service.resetConceptForRegeneration(first.id, "editor");
      expect(reset).toMatchObject({ state: "DRAFT", currentConceptId: undefined });
      expect(reset.concepts[0]?.status).toBe("SUPERSEDED");
      expect(reset.selectedProductAssetIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    } finally { await dispose(); }
  });

  it("rejects partial concepts, restores a retryable state, and never persists stale output", async () => {
    const generateConcept = vi.fn(async (input: Parameters<CreativeProvider["generateConcept"]>[0], context: Parameters<CreativeProvider["generateConcept"]>[1]) => ({
      concept: { ...conceptFor(input.productName, input.creativeTopic), scenes: conceptFor(input.productName).scenes.slice(0, 2) },
      submission: { provider: "mock-openai", model: "mock", requestId: "request", providerTaskId: "task", metadata: { operationKey: context.operationKey } }
    }));
    const { service, repository, dispose } = await setupService({ generateConcept });
    try {
      const project = await service.createProjectFromBrief({ requestId, name: "Invalid Response Test", creativeTopic: "Current brief", productDetails: "", targetDurationSeconds: 15, actor: "editor" });
      // Existing direct-workflow projects remain supported after the additive migration.
      await repository.saveProject({ ...project, strategyRequired: false, version: project.version + 1 });
      await expect(service.generateConcept(project.id, "editor")).rejects.toThrow("exactly three scenes");
      expect(generateConcept).toHaveBeenCalledTimes(1);
      const recovered = await service.getProject(project.id);
      expect(recovered).toMatchObject({ state: "DRAFT", concepts: [] });
      expect(recovered.currentConceptId).toBeUndefined();
    } finally { await dispose(); }
  });
});

describe("create-project browser workflow", () => {
  it("shows the dashboard action and validates required fields", async () => {
    const source = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    expect(source.match(/\+ Create Campaign/g)).toHaveLength(1);
    expect(source.match(/\+ Create Project/g)).toHaveLength(1);
    expect(source).toContain("Winner Analysis");
    expect(source).toContain("Concepts");
    expect(source).toContain("Campaign Product References");
    expect(source).toContain("Campaign Product Visual Authority");
    expect(source).toContain("Approved winners for this Product from <a href=\"/winners\">Winner Analysis</a> are available.");
    expect(source).not.toContain("/api/creative-references?projectId=");
    expect(source).toContain("/api/creative-references/approved?projectId=");
    expect(source).toContain("Make Primary");
    expect(source).toContain("Existing immutable snapshots and historical executions are never rewritten.");
    expect(source).toContain("campaignWorkspaceView ? campaignTabs : executionTabs");
    expect(source).toContain('className="campaign-chevron-button"');
    expect(source).not.toContain("campaign-tool-actions");
    expect(source).toContain("Creating…");
    expect(source).toContain("history.pushState");
    expect(source).toContain("refresher.current!.cancel()");
    expect(source).toContain("concept-scene-");
    expect(source).toContain("Approve Concept & Continue");
    expect(source).toContain("Canonical Product Reference");
    expect(source).toContain("Background-only image prompt");
    expect(source).toContain("Upload Final Composite Context Image");
    expect(source).toContain("productFidelityConfirmed: true");
    expect(source).toContain("Video generation prompt");
    expect(source).toContain("Copy Saved Video Prompt");
    expect(source).toContain("Save Revised Prompt as New Manual Attempt");
    expect(source).toContain("New Manual Attempt");
    expect(source).toContain('generationMethod: "manual"');
    expect(source).toContain("Approving…");
    expect(source).toContain("Planned Scenes");
    expect(source).toContain("Discard Concept and Regenerate");
    expect(source).toContain("/api/projects/${projectId}");
    const draft = { requestId, name: "", creativeTopic: "", productDetails: "", targetDurationSeconds: 15 };
    expect(validateNewProject(draft, [])).toBe("Product / Project Name is required.");
  });

  it("creates, uploads references in order, and reports progress without exposing credentials", async () => {
    const file = new File([png], "pet.png", { type: "image/png" });
    const project = { id: projectId, publicId: "CF-000005", state: "DRAFT" };
    const responses = [
      new Response(JSON.stringify(project), { status: 200 }),
      new Response(JSON.stringify({ assetId, url: "https://private.example/exact?redacted", headers: { "x-amz-meta-sha256": sha256 } }), { status: 200 }),
      new Response(null, { status: 200 }),
      new Response(JSON.stringify({ ...project, selectedProductAssetIds: [assetId] }), { status: 200 })
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const stages: string[] = [];
    const result = await createNewProjectWorkflow({ draft: { requestId, name: "Pet Ornament", creativeTopic: "Gift", productDetails: "", targetDurationSeconds: 15 }, files: [file], fetcher: fetcher as typeof fetch, onStage: (stage) => stages.push(stage) });
    expect(result.selectedProductAssetIds).toEqual([assetId]);
    expect(stages).toEqual(["Creating…", "Uploading reference 1…", "Verifying reference 1…", "Ready"]);
    expect(String((fetcher.mock.calls as unknown[][])[2]?.[0])).toContain("private.example");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("AWS_SECRET");
  });

  it("surfaces network failure and preserves the request identity for a safe retry", async () => {
    const draft = { requestId, name: "Pet Ornament", creativeTopic: "Gift", productDetails: "", targetDurationSeconds: 15 };
    await expect(createNewProjectWorkflow({ draft, files: [], fetcher: vi.fn(async () => new Response(JSON.stringify({ message: "API unavailable" }), { status: 503 })) as typeof fetch })).rejects.toThrow("API unavailable");
    expect(draft.requestId).toBe(requestId);
  });
});
