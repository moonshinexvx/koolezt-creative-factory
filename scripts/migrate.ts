import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for migrations.");
const pool = new Pool({ connectionString: url });
await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
for (const name of (await readdir("db/migrations")).filter((item) => item.endsWith(".sql")).sort()) {
  if ((await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name])).rowCount) continue;
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(await readFile(join("db/migrations", name), "utf8")); await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
await pool.end();
