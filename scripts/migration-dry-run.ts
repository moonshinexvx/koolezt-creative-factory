// Runs every pending migration inside one transaction, prints row counts, then rolls everything back.
// Nothing is changed. Use it before a migration that removes data.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
const counted = ["products", "product_assets", "product_claims", "creative_references", "creative_dna_revisions", "creative_winner_reports", "creative_meta_ad_links", "media_assets", "creative_projects", "creative_strategy_batches", "variant_batches", "workflow_jobs"];
const counts = async () => Object.fromEntries(await Promise.all(counted.map(async (table) => {
  const exists = await client.query("SELECT to_regclass($1) AS name", [table]);
  return [table, exists.rows[0].name ? Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n) : "-"];
})));
try {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name as string));
  const pending = (await readdir("db/migrations")).filter((name) => name.endsWith(".sql") && !applied.has(name)).sort();
  console.log("pending migrations:", pending.length ? pending.join(", ") : "none");
  await client.query("BEGIN");
  const before = await counts();
  for (const name of pending) await client.query(await readFile(join("db/migrations", name), "utf8"));
  const after = await counts();
  console.table(counted.map((table) => ({ table, before: before[table], after: after[table] })));
  console.log("DRY RUN OK: every pending migration succeeded. All changes were rolled back.");
} catch (error) {
  console.error("DRY RUN FAILED (nothing was changed):", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
  await pool.end();
}
