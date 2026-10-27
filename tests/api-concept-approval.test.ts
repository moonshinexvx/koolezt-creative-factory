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
  it("shows that an empty JSON request is rejected before the route handler", async () => {
    const { app, project, setup } = await conceptReviewApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/concept/approve`, headers: { "content-type": "application/json" } });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("INTERNAL_ERROR");
    expect((await setup.service.getProject(project.id)).state).toBe("CONCEPT_REVIEW");
  });

});
