import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@koolezt/infrastructure";

const baseDatabaseUrl=process.env.KOOLEZT_TEST_DATABASE_URL;
const integration=baseDatabaseUrl?describe.sequential:describe.skip;
const prefix=`concept_7c15d_${randomUUID().replaceAll("-","").slice(0,12)}`;
const schemas={fresh:`${prefix}_fresh`,upgrade:`${prefix}_upgrade`} as const;
const urls:{fresh?:string;upgrade?:string}={};

function withSchema(connectionString:string,schema:string):string{
  const url=new URL(connectionString);
  url.searchParams.set("options",`-csearch_path=${schema},public`);
  return url.toString();
}

async function migrate(connectionString:string,through?:string):Promise<void>{
  const pool=createPostgresPool(connectionString);
  try{
    await pool.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    const names=(await readdir(new URL("../../db/migrations",import.meta.url))).filter((name)=>name.endsWith(".sql")).sort();
    for(const name of names){
      if(through&&name>through)break;
      await pool.query(await readFile(new URL(`../../db/migrations/${name}`,import.meta.url),"utf8"));
      await pool.query("INSERT INTO schema_migrations(name) VALUES($1)",[name]);
    }
  }finally{await pool.end();}
}

integration("Milestone 7C.15D additive PostgreSQL migration",()=>{
  beforeAll(async()=>{
    const admin=createPostgresPool(baseDatabaseUrl!);
    try{
      for(const schema of Object.values(schemas)){
        if(!/^concept_7c15d_[a-f0-9]{12}_(?:fresh|upgrade)$/.test(schema))throw new Error("Unsafe integration schema name.");
        await admin.query(`CREATE SCHEMA ${schema}`);
      }
    }finally{await admin.end();}
    urls.fresh=withSchema(baseDatabaseUrl!,schemas.fresh);
    urls.upgrade=withSchema(baseDatabaseUrl!,schemas.upgrade);
    await migrate(urls.fresh,"0020_background_creative_concept.sql");
    await migrate(urls.upgrade,"0019_winning_creative_dna.sql");
    const upgrade=createPostgresPool(urls.upgrade);
    try{
      const name="0020_background_creative_concept.sql";
      await upgrade.query(await readFile(new URL(`../../db/migrations/${name}`,import.meta.url),"utf8"));
      await upgrade.query("INSERT INTO schema_migrations(name) VALUES($1)",[name]);
    }finally{await upgrade.end();}
  },90_000);

  afterAll(async()=>{
    if(!baseDatabaseUrl)return;
    const admin=createPostgresPool(baseDatabaseUrl);
    try{for(const schema of Object.values(schemas))await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
    finally{await admin.end();}
  },60_000);

  it("produces equivalent fresh and 0019-to-0020 workflow constraints without changing provider_jobs",async()=>{
    const pools=[createPostgresPool(urls.fresh!),createPostgresPool(urls.upgrade!)];
    try{
      const definitions:string[]=[];
      for(const pool of pools){
        const migration=await pool.query<{name:string}>("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
        expect(migration.rows[0]?.name).toBe("0020_background_creative_concept.sql");
        const constraint=await pool.query<{definition:string}>("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='workflow_jobs'::regclass AND conname='workflow_jobs_type_check'");
        expect(constraint.rows[0]?.definition).toContain("GENERATE_CONCEPT");
        expect(constraint.rows[0]?.definition).toContain("ANALYZE_CREATIVE_DNA");
        definitions.push(constraint.rows[0]!.definition);
        const providerColumns=await pool.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='provider_jobs' ORDER BY ordinal_position");
        expect(providerColumns.rows.map((row)=>row.column_name)).toEqual(expect.arrayContaining(["provider_task_id","provider_request_id","response_metadata","submitted_at","completed_at"]));
      }
      expect(definitions[1]).toBe(definitions[0]);
    }finally{await Promise.all(pools.map((pool)=>pool.end()));}
  });
});
