import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, PostgresFactoryRepository } from "@koolezt/infrastructure";

const baseDatabaseUrl=process.env.KOOLEZT_TEST_DATABASE_URL;
const integration=baseDatabaseUrl?describe.sequential:describe.skip;
const prefix=`visual_authority_7c15f_${randomUUID().replaceAll("-","").slice(0,12)}`;
const schemas={fresh:`${prefix}_fresh`,upgrade:`${prefix}_upgrade`} as const;
const urls:{fresh?:string;upgrade?:string}={};

function withSchema(connectionString:string,schema:string):string{
  const url=new URL(connectionString);
  url.searchParams.set("options",`-csearch_path=${schema},public`);
  return url.toString();
}

async function migrate(connectionString:string,through:string):Promise<void>{
  const pool=createPostgresPool(connectionString);
  try{
    await pool.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    const names=(await readdir(new URL("../../db/migrations",import.meta.url))).filter((name)=>name.endsWith(".sql")).sort();
    for(const name of names){
      if(name>through)break;
      await pool.query(await readFile(new URL(`../../db/migrations/${name}`,import.meta.url),"utf8"));
      await pool.query("INSERT INTO schema_migrations(name) VALUES($1)",[name]);
    }
  }finally{await pool.end();}
}

integration("Milestone 7C.15F Product personalization visual authority",()=>{
  const legacyProductId=randomUUID();
  beforeAll(async()=>{
    const admin=createPostgresPool(baseDatabaseUrl!);
    try{
      for(const schema of Object.values(schemas)){
        if(!/^visual_authority_7c15f_[a-f0-9]{12}_(?:fresh|upgrade)$/.test(schema))throw new Error("Unsafe integration schema name.");
        await admin.query(`CREATE SCHEMA ${schema}`);
      }
    }finally{await admin.end();}
    urls.fresh=withSchema(baseDatabaseUrl!,schemas.fresh);
    urls.upgrade=withSchema(baseDatabaseUrl!,schemas.upgrade);
    await migrate(urls.fresh,"0021_product_personalization_visual_authority.sql");
    await migrate(urls.upgrade,"0020_background_creative_concept.sql");
    const upgrade=createPostgresPool(urls.upgrade);
    try{
      const now=new Date().toISOString();
      await upgrade.query("INSERT INTO products(id,name,slug,description,default_cta,active,created_at,updated_at) VALUES($1,'Legacy Product',$2,'Legacy','Create',true,$3,$3)",[legacyProductId,`legacy-${legacyProductId}`,now]);
      const name="0021_product_personalization_visual_authority.sql";
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

  it("produces equivalent fresh and 0020-to-0021 optional authority schemas",async()=>{
    for(const connectionString of [urls.fresh!,urls.upgrade!]){
      const pool=createPostgresPool(connectionString);
      try{
        const migration=await pool.query<{name:string}>("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
        expect(migration.rows[0]?.name).toBe("0021_product_personalization_visual_authority.sql");
        const column=await pool.query<{data_type:string;is_nullable:string}>("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='products' AND column_name='personalization_visual_authority'");
        expect(column.rows[0]).toEqual({data_type:"jsonb",is_nullable:"YES"});
        const constraint=await pool.query<{definition:string}>("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='products'::regclass AND conname='products_personalization_visual_authority_object'");
        expect(constraint.rows[0]?.definition).toContain("jsonb_typeof");
      }finally{await pool.end();}
    }
    const upgrade=createPostgresPool(urls.upgrade!);
    try{expect((await new PostgresFactoryRepository(upgrade).getProduct(legacyProductId)).personalizationVisualAuthority).toBeUndefined();}
    finally{await upgrade.end();}
  });

  it("round-trips explicit operator-confirmed Product authority",async()=>{
    const pool=createPostgresPool(urls.fresh!);
    try{
      const repository=new PostgresFactoryRepository(pool);
      const now=new Date().toISOString();
      const product={id:randomUUID(),name:"Personalized Sign",slug:`sign-${randomUUID()}`,description:"Sign",defaultCta:"Create",active:true,claims:[],assets:[],personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED" as const,immutableStructure:["Silhouette","Mounting"],authorizedPersonalizationFields:["Pet artwork","House number"]},createdAt:now,updatedAt:now};
      await repository.saveProduct(product);
      expect((await repository.getProduct(product.id)).personalizationVisualAuthority).toEqual(product.personalizationVisualAuthority);
      const {personalizationVisualAuthority:omittedAuthority,...legacyBase}=product;
      void omittedAuthority;
      const legacy={...legacyBase,id:randomUUID(),slug:`legacy-${randomUUID()}`};
      await repository.saveProduct(legacy);
      expect((await repository.getProduct(legacy.id)).personalizationVisualAuthority).toBeUndefined();
      await expect(
        pool.query(
          "UPDATE products SET personalization_visual_authority='[]'::jsonb WHERE id=$1",
          [product.id]
        )
      ).rejects.toMatchObject({constraint:"products_personalization_visual_authority_object"});
    }finally{await pool.end();}
  });
});
