import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildSceneContextImagePrompt } from "@koolezt/domain";
import { buildServer } from "../apps/api/src/server.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = createHash("sha256").update(png).digest("hex");

const project = {
  id: projectId,
  state: "SCENES_GENERATING",
  currentConceptId: "66666666-6666-4666-8666-666666666666",
  selectedProductAssetIds: [sourceId],
  concepts: [{ id: "66666666-6666-4666-8666-666666666666", scenes: [{ sceneNumber: 1, referenceAssetIds: [sourceId] }] }],
  scenes: [{ id: sceneId, sceneNumber: 1, attempts: [{ id: attemptId, sourceType: "AI_VIDEO", generationMethod: "MANUAL", status: "PENDING" }] }]
};

describe("scene context image workflow", () => {
  it("compiles a still-image prompt anchored to Product authority without asking the image model for overlays", () => {
    const prompt = buildSceneContextImagePrompt({
      productName: "Personalized Address Sign",
      purpose: "Show the installed Product immediately",
      generationPrompt: "Mount the supplied sign beside a front door.",
      accuracyRequirements: ["Keep the number 4107 unchanged"]
    });
    expect(prompt).toContain("9:16 BACKGROUND PLATE");
    expect(prompt).toContain("DO NOT draw, recreate, reinterpret, personalize, mount, or include the Product");
    expect(prompt).toContain("Mount the supplied sign beside a front door");
    expect(prompt).toContain("Keep the number 4107 unchanged");
    expect(prompt).toContain("the authoritative Product and deterministic overlays are added later");
  });

  it("authorizes, verifies, and attaches a scoped image with canonical reference provenance", async () => {
    const pending = {
      id: assetId, kind: "IMAGE", storageKey: `working/${projectId}/${assetId}.png`, storageProvider: "s3",
      projectId, purpose: "SCENE_CONTEXT_IMAGE", lifecycleStatus: "PENDING_UPLOAD", mimeType: "image/png",
      byteSize: png.byteLength, sha256,
      metadata: { sceneId, attemptId, sourceReferenceAssetIds: [sourceId], productFidelityConfirmed: true }, createdAt: "2026-09-30T00:00:00.000Z"
    } as const;
    const createUpload = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({ asset: { ...pending, metadata: input.metadata }, method: "PUT", url: "https://private.example/context", headers: { "x-amz-meta-sha256": sha256 }, expiresAt: "2026-09-30T00:15:00.000Z" }));
    const completeUpload = vi.fn(async () => ({ ...pending, lifecycleStatus: "AVAILABLE" as const }));
    const attachSceneContextImage = vi.fn(async () => ({ ...project, marker: "attached" }));
    const app = buildServer({
      durableMediaStore: { createUpload, completeUpload, rejectUpload: vi.fn() },
      storage: { read: vi.fn(async () => png), getAsset: vi.fn(async () => undefined) },
      service: { getProject: vi.fn(async () => project), attachSceneContextImage }
    } as never);

    const authorized = await app.inject({ method: "POST", url: `/api/projects/${projectId}/scenes/${sceneId}/context-image/upload`, payload: { filename: "installed-entry.png", mimeType: "image/png", byteSize: png.byteLength, sha256, productFidelityConfirmed: true } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).not.toHaveProperty("storageKey");
    expect(createUpload).toHaveBeenCalledWith(expect.objectContaining({
      projectId, purpose: "SCENE_CONTEXT_IMAGE", kind: "IMAGE",
      metadata: expect.objectContaining({ sceneId, attemptId, sourceReferenceAssetIds: [sourceId], productFidelityConfirmed: true })
    }));

    const completed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/scenes/${sceneId}/context-image/complete`, payload: { assetId } });
    expect(completed.statusCode).toBe(200);
    expect(attachSceneContextImage).toHaveBeenCalledWith(expect.objectContaining({ projectId, sceneId, asset: expect.objectContaining({ id: assetId }) }));

    const video = await app.inject({ method: "POST", url: `/api/projects/${projectId}/scenes/${sceneId}/context-image/upload`, payload: { filename: "clip.mp4", mimeType: "video/mp4", byteSize: 10, sha256, productFidelityConfirmed: true } });
    expect(video.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an image when its durable scope belongs to another attempt", async () => {
    const wrong = {
      id: assetId, kind: "IMAGE", storageKey: "wrong.png", projectId, purpose: "SCENE_CONTEXT_IMAGE", lifecycleStatus: "AVAILABLE",
      mimeType: "image/png", byteSize: png.byteLength, sha256, metadata: { sceneId, attemptId: "77777777-7777-4777-8777-777777777777", sourceReferenceAssetIds: [sourceId], productFidelityConfirmed: true }, createdAt: "2026-09-30T00:00:00.000Z"
    } as const;
    const attachSceneContextImage = vi.fn();
    const app = buildServer({
      durableMediaStore: { completeUpload: vi.fn(async () => wrong), rejectUpload: vi.fn() },
      storage: { read: vi.fn(async () => png) },
      service: { getProject: vi.fn(async () => project), attachSceneContextImage }
    } as never);
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/scenes/${sceneId}/context-image/complete`, payload: { assetId } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("DURABLE_MEDIA_SCOPE_MISMATCH");
    expect(attachSceneContextImage).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks a new API video submission until the context image is attached", async () => {
    const setSceneGenerationMethod = vi.fn();
    const app = buildServer({ service: { getProject: vi.fn(async () => project), setSceneGenerationMethod } } as never);
    const response = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/scenes/${sceneId}/generation-method`, payload: { method: "api" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("SCENE_CONTEXT_IMAGE_REQUIRED");
    expect(setSceneGenerationMethod).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks API video submission when an attached historical context lacks Product-fidelity confirmation", async () => {
    const unconfirmedProject = {
      ...project,
      scenes: [{
        ...project.scenes[0],
        attempts: [{ ...project.scenes[0]!.attempts[0], inputAssetId: assetId }]
      }]
    };
    const setSceneGenerationMethod = vi.fn();
    const app = buildServer({ service: { getProject: vi.fn(async () => unconfirmedProject), setSceneGenerationMethod } } as never);
    const response = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/scenes/${sceneId}/generation-method`, payload: { method: "api" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("SCENE_CONTEXT_FIDELITY_UNCONFIRMED");
    expect(setSceneGenerationMethod).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows API video submission only after Product-fidelity confirmation is bound to the attempt", async () => {
    const confirmedProject = {
      ...project,
      scenes: [{
        ...project.scenes[0],
        attempts: [{
          ...project.scenes[0]!.attempts[0],
          inputAssetId: assetId,
          providerMetadata: { contextProductFidelityConfirmed: true }
        }]
      }]
    };
    const setSceneGenerationMethod = vi.fn(async () => confirmedProject);
    const app = buildServer({ service: { getProject: vi.fn(async () => confirmedProject), setSceneGenerationMethod } } as never);
    const response = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/scenes/${sceneId}/generation-method`, payload: { method: "api" } });
    expect(response.statusCode).toBe(200);
    expect(setSceneGenerationMethod).toHaveBeenCalledWith(projectId, sceneId, "API", "development-user");
    await app.close();
  });
});
