import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { fixture } from "./support/factory-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function conceptReviewApp() {
  const setup = await fixture();
  let project = await setup.service.createProject({
    productId: setup.product.id,
    selectedProductAssetIds: [setup.product.assets[0]!.id],
    preferredVoiceProfileId: "female-ugc",
    actor: "browser-test"
  });
  project = await setup.service.generateConcept(project.id, "browser-test");
  const app = buildServer({ service: setup.service, storage: setup.storage } as Parameters<typeof buildServer>[0]);
  cleanups.push(async () => { await app.close(); await setup.dispose(); });
  return { app, project, setup };
}

describe("concept approval HTTP contract", () => {
  it("accepts the browser-equivalent bodyless POST and creates scene work once", async () => {
    const { app, project, setup } = await conceptReviewApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "x-koolezt-actor": "web-user" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("SCENES_GENERATING");
    const persisted = await setup.service.getProject(project.id);
    expect(persisted.approvals).toHaveLength(1);
    expect(persisted.scenes).toHaveLength(3);
    expect(persisted.scenes.map((scene) => scene.sceneNumber)).toEqual([1, 2, 3]);
    expect(persisted.scenes.map((scene) => scene.attempts[0]?.prompt)).toEqual(project.concepts[0]?.scenes.map((scene) => scene.generationPrompt));
    // AI_VIDEO is manual/external by default; approval creates durable scene
    // attempts, while only explicitly selected API generation enqueues work.
    expect(await setup.service.listJobs(project.id)).toHaveLength(0);

    const duplicate = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "x-koolezt-actor": "web-user" } });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().state).toBe("SCENES_GENERATING");
    expect((await setup.service.getProject(project.id)).scenes).toHaveLength(3);
    expect((await setup.service.getProject(project.id)).approvals).toHaveLength(1);
    expect(await setup.service.listJobs(project.id)).toHaveLength(0);
  });

  it("shows that an empty JSON request is rejected before the route handler", async () => {
    const { app, project, setup } = await conceptReviewApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "content-type": "application/json" } });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("INTERNAL_ERROR");
    expect((await setup.service.getProject(project.id)).state).toBe("CONCEPT_REVIEW");
  });

  it("accepts an explicit empty JSON object when a caller intentionally sends JSON", async () => {
    const { app, project } = await conceptReviewApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "content-type": "application/json" }, payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("SCENES_GENERATING");
  });

  it("rejects incomplete reviewed concepts without creating scenes", async () => {
    const { app, project, setup } = await conceptReviewApp();
    await setup.repository.saveProject({
      ...project,
      concepts: project.concepts.map((concept) => ({ ...concept, scenes: concept.scenes.slice(0, 2) })),
      version: project.version + 1,
      updatedAt: new Date().toISOString()
    });

    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "x-koolezt-actor": "web-user" } });
    expect(response.statusCode).toBe(409);
    const persisted = await setup.service.getProject(project.id);
    expect(persisted.state).toBe("CONCEPT_REVIEW");
    expect(persisted.scenes).toHaveLength(0);
    expect(persisted.approvals).toHaveLength(0);
  });
});
