import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("creative strategy additive migrations", () => {
  it("adds isolated strategy persistence, immutable revisions, durable provider results, handoffs, and project links", async () => {
    const names = (await readdir(new URL("../db/migrations", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
    expect(names.at(-1)).toBe("0028_scene_image_jobs.sql");
    const sql = await readFile(new URL("../db/migrations/0016_creative_strategy.sql", import.meta.url), "utf8");
    for (const table of ["creative_strategy_batches", "creative_strategy_concepts", "creative_strategy_concept_revisions", "creative_strategy_provider_operations", "creative_strategy_handoffs"]) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain("result_payload jsonb");
    expect(sql).toContain("strategy_concept_revision_id uuid");
    expect(sql).toContain("selection_order integer");
    expect(sql).toContain("'GENERATE_STRATEGY','REPLACE_STRATEGY'");
    expect(sql).toContain("'STRATEGY'");
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("adds recoverable background provider state without rewriting 0016", async () => {
    const sql = await readFile(new URL("../db/migrations/0017_strategy_background_execution.sql", import.meta.url), "utf8");
    for (const column of ["response_id", "model", "submitted_at", "latest_provider_status", "latest_poll_at", "terminal_at", "result_sha256", "next_attempt_at"]) expect(sql).toContain(column);
    expect(sql).toContain("'POLLING'");
    expect(sql).toContain("'RESULT_UNAVAILABLE'");
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("adds selectable strategy counts and creative-only visual notes in migration 0018", async () => {
    const sql = await readFile(new URL("../db/migrations/0018_canonical_strategy_constraints.sql", import.meta.url), "utf8");
    expect(sql).toContain("requested_count IN (3, 6, 12)");
    expect(sql).toContain("SET DEFAULT 6");
    expect(sql).toContain("creative_visual_execution_notes");
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("does not retrofit strategy data into historical Variant Factory migration 0012", async () => {
    const historical = await readFile(new URL("../db/migrations/0012_variant_factory.sql", import.meta.url), "utf8");
    expect(historical).not.toContain("creative_strategy");
  });

  it("adds the revisioned Winning Creative DNA library without rewriting historical media", async () => {
    const sql = await readFile(new URL("../db/migrations/0019_winning_creative_dna.sql", import.meta.url), "utf8");
    for (const table of ["creative_references", "creative_dna_revisions", "creative_dna_provider_operations"]) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain("winner_creative_reference_id");
    expect(sql).toContain("winner_dna_revision_id");
    expect(sql).toContain("'ANALYZE_CREATIVE_DNA'");
    expect(sql).toContain("'CREATIVE_DNA'");
    expect(sql).toContain("source_asset_id uuid NOT NULL REFERENCES media_assets");
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
    expect(sql).not.toMatch(/INSERT INTO creative_references/i);
  });

  it("adds only the Creative Concept workflow type in migration 0020", async () => {
    const sql = await readFile(new URL("../db/migrations/0020_background_creative_concept.sql", import.meta.url), "utf8");
    expect(sql).toContain("'GENERATE_CONCEPT'");
    for (const existing of ["'GENERATE_SCENE'","'GENERATE_VOICE'","'COMPOSE_RENDER'","'GENERATE_STRATEGY'","'REPLACE_STRATEGY'","'ANALYZE_CREATIVE_DNA'"]) expect(sql).toContain(existing);
    expect(sql).not.toMatch(/(?:DROP TABLE|TRUNCATE|DELETE FROM)/i);
    expect(sql).not.toMatch(/ALTER TABLE provider_jobs/i);
  });

  it("adds optional Product personalization visual authority without changing historical rows", async () => {
    const sql = await readFile(new URL("../db/migrations/0021_product_personalization_visual_authority.sql", import.meta.url), "utf8");
    expect(sql).toContain("personalization_visual_authority jsonb");
    expect(sql).toContain("personalization_visual_authority IS NULL");
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|UPDATE products|INSERT INTO/i);
    expect(sql).not.toMatch(/(?:DROP TABLE|TRUNCATE|DELETE FROM)/i);
  });

  it("widens AI source labels in migration 0022 while keeping legacy OPENAI rows valid and untouched", async () => {
    const sql = await readFile(new URL("../db/migrations/0022_provider_neutral_ai_source.sql", import.meta.url), "utf8");
    for (const table of ["variant_creative_package_revisions", "creative_strategy_concept_revisions", "creative_dna_revisions"]) expect(sql).toContain(`ADD CONSTRAINT ${table}_source_check`);
    expect(sql.match(/'AI_PROVIDER','OPENAI'/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT INTO|DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("adds Winner Analysis reports in their own table without touching DNA revisions", async () => {
    const sql = await readFile(new URL("../db/migrations/0023_winner_reports.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE creative_winner_reports");
    expect(sql).toContain("creative_reference_id uuid PRIMARY KEY REFERENCES creative_references(id)");
    expect(sql).toContain("'PENDING','READY','FAILED'");
    expect(sql).not.toMatch(/ALTER TABLE creative_dna_revisions|ALTER TABLE creative_references/i);
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT INTO|DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("links winners to Meta ads read-only, one winner per ad", async () => {
    const sql = await readFile(new URL("../db/migrations/0024_meta_ad_links.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE creative_meta_ad_links");
    expect(sql).toContain("ad_id text NOT NULL UNIQUE");
    expect(sql).not.toMatch(/token|secret/i);
    expect(sql).not.toMatch(/ALTER TABLE|\bUPDATE\b|INSERT INTO|DROP TABLE|TRUNCATE|DELETE FROM/i);
  });

  it("archives winners reversibly without deleting rows", async () => {
    const sql = await readFile(new URL("../db/migrations/0025_creative_reference_archive.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN archived_at timestamptz");
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|TRUNCATE|NOT NULL/i);
  });

  it("adds the winner-to-video tables and lets winners exist without a campaign", async () => {
    const sql = await readFile(new URL("../db/migrations/0026_winner_video_app.sql", import.meta.url), "utf8");
    for (const table of ["winner_jobs", "winner_video_batches", "winner_videos"]) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain("ALTER TABLE creative_references ALTER COLUMN source_project_id DROP NOT NULL");
    expect(sql).toContain("operation_key text NOT NULL UNIQUE");
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT INTO|DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it("removes campaign data only after unlinking winners, without cascading, and aborts if kept data changes", async () => {
    const sql = await readFile(new URL("../db/migrations/0027_remove_campaign_data.sql", import.meta.url), "utf8");
    expect(sql.indexOf("UPDATE creative_references SET source_project_id = NULL")).toBeLessThan(sql.indexOf("TRUNCATE TABLE"));
    expect(sql).not.toMatch(/CASCADE|DROP TABLE/i);
    expect(sql).toContain("RAISE EXCEPTION 'Campaign cleanup would change kept data; nothing was removed.'");
    for (const kept of ["creative_references", "creative_dna_revisions", "creative_winner_reports", "creative_meta_ad_links", "products", "product_assets", "product_claims", "media_assets"]) {
      expect(sql).toContain(`FROM ${kept})`);
      expect(sql.slice(sql.indexOf("TRUNCATE TABLE"), sql.indexOf(";", sql.indexOf("TRUNCATE TABLE")))).not.toMatch(new RegExp(`\b${kept}\b`));
    }
  });
});
