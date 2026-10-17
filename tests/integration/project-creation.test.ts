import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresFactoryRepository, createPostgresPool } from "@koolezt/infrastructure";
import type { CreativeProject, Product } from "@koolezt/domain";

const databaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL operator project creation", () => {
  it("allocates concurrent public numbers and atomically persists each product/project pair", async () => {
    const pool = createPostgresPool(databaseUrl!);
    const repository = new PostgresFactoryRepository(pool);
    const productIds = [randomUUID(), randomUUID()];
    const projectIds = [randomUUID(), randomUUID()];
    const numbers = await Promise.all([repository.nextProjectNumber(), repository.nextProjectNumber()]);
    const now = new Date().toISOString();
    const product = (index: number): Product => ({
      id: productIds[index]!,
      name: `Concurrent ${index}`,
      slug: `concurrent-${projectIds[index]}`,
      description: "Integration project",
      defaultCta: "Create yours today",
      active: true,
      claims: [],
      assets: [],
      createdAt: now,
      updatedAt: now
    });
    const project = (index: number): CreativeProject => ({
      id: projectIds[index]!,
      publicId: `CF-${String(numbers[index]).padStart(6, "0")}`,
      productId: productIds[index]!,
      selectedProductAssetIds: [],
      additionalInstructions: "Creative topic: Test",
      preferredVoiceProfileId: "marin",
      creativeBrief: { creativeTopic: "Test", productDetails: "", targetDurationSeconds: 15 },
      state: "DRAFT",
      concepts: [],
      scenes: [],
      voiceGenerations: [],
      renders: [],
      approvals: [],
      usageCosts: [],
      auditEvents: [],
      version: 1,
      createdAt: now,
      updatedAt: now
    });
    try {
      expect(new Set(numbers).size).toBe(2);
      await Promise.all([repository.saveProductAndProject!(product(0), project(0)), repository.saveProductAndProject!(product(1), project(1))]);
      expect((await repository.getProject(projectIds[0]!)).publicId).toBe(project(0).publicId);
      expect((await repository.getProject(projectIds[1]!)).publicId).toBe(project(1).publicId);
      await expect(repository.saveProductAndProject!(product(0), project(0))).rejects.toMatchObject({ code: "STALE_PROJECT_VERSION" });
      expect((await repository.listJobs(projectIds[0]!)).length).toBe(0);
    } finally {
      await pool.query("DELETE FROM creative_project_snapshots WHERE project_id = ANY($1::uuid[])", [projectIds]);
      await pool.query("DELETE FROM creative_projects WHERE id = ANY($1::uuid[])", [projectIds]);
      await pool.query("DELETE FROM products WHERE id = ANY($1::uuid[])", [productIds]);
      await pool.end();
    }
  });
});
