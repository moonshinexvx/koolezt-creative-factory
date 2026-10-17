import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresFactoryRepository, createPostgresPool } from "@koolezt/infrastructure";

const databaseUrl = process.env.KOOLEZT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL workflow persistence", () => {
  it("persists product and project state across repository instances", async () => {
    const pool = createPostgresPool(databaseUrl!);
    const repository = new PostgresFactoryRepository(pool);
    const suffix = randomUUID().slice(0, 8);
    const product = { id: randomUUID(), name: `Test ${suffix}`, slug: `test-${suffix}`, description: "Integration product", defaultCta: "Create", active: true, claims: [], personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED" as const,immutableStructure:["Silhouette","Mounting"],authorizedPersonalizationFields:["House number"]}, assets: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await repository.saveProduct(product);
    const restored=await new PostgresFactoryRepository(pool).getProduct(product.id);
    expect(restored.slug).toBe(product.slug);
    expect(restored.personalizationVisualAuthority).toEqual(product.personalizationVisualAuthority);
    await pool.end();
  });
});
