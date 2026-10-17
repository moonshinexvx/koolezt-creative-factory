import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DomainError } from "@koolezt/domain";
import type {
  ConceptProviderOperationEvidence,
  CreativeProject,
  FactoryRepository,
  GeneratedAsset,
  Product,
  WorkflowJob,
  WorkflowJobType
} from "@koolezt/domain";

export type Database = ReturnType<typeof drizzle>;

export function createPostgresPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10, application_name: "koolezt-creative-factory" });
}

export function createDatabase(pool: Pool): Database {
  return drizzle({ client: pool });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function operationHash(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex");
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function projectNumber(publicId: string): number {
  const match = /^CF-(\d+)$/.exec(publicId);
  if (!match) throw new DomainError("INVALID_PROJECT_ID", `Invalid public project ID ${publicId}.`);
  return Number(match[1]);
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

export class PostgresMediaAssetCatalog {
  constructor(private readonly pool: Pool) {}

  async save(asset: GeneratedAsset): Promise<void> {
    await this.pool.query(
      `INSERT INTO media_assets (id, storage_provider, storage_key, kind, mime_type, byte_size, sha256, metadata, status, created_at)
       VALUES ($1, 'local', $2, $3, $4, $5, $6, $7::jsonb, 'AVAILABLE', $8)
       ON CONFLICT (id) DO UPDATE SET
         storage_key = EXCLUDED.storage_key,
         mime_type = EXCLUDED.mime_type,
         byte_size = EXCLUDED.byte_size,
         sha256 = EXCLUDED.sha256,
         metadata = EXCLUDED.metadata,
         status = 'AVAILABLE'`,
      [
        asset.id,
        asset.storageKey,
        asset.kind,
        asset.mimeType,
        asset.byteSize,
        asset.sha256,
        json(asset.metadata),
        asset.createdAt
      ]
    );
  }

  async get(assetId: string): Promise<GeneratedAsset | undefined> {
    const result = await this.pool.query<{
      id: string;
      kind: GeneratedAsset["kind"];
      storage_key: string;
      mime_type: string;
      byte_size: string;
      sha256: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT id, kind, storage_key, mime_type, byte_size, sha256, metadata, created_at
       FROM media_assets WHERE id = $1 AND status = 'AVAILABLE'`,
      [assetId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          kind: row.kind,
          storageKey: row.storage_key,
          mimeType: row.mime_type,
          byteSize: Number(row.byte_size),
          sha256: row.sha256,
          metadata: parseJson<Record<string, unknown>>(row.metadata),
          createdAt: row.created_at.toISOString()
        }
      : undefined;
  }
}

export class PostgresExternalMediaStagingStore {
  constructor(private readonly pool: Pool) {}
  async findAvailable(operationId: string, assetId: string, sha256: string): Promise<Readonly<{ object_key: string; content_type: string; byte_size: string | number; expires_at: string | Date }> | undefined> { return (await this.pool.query<Readonly<{ object_key: string; content_type: string; byte_size: string | number; expires_at: string | Date }>>("SELECT object_key, content_type, byte_size, expires_at FROM external_media_staging WHERE operation_id=$1 AND asset_id=$2 AND sha256=$3 AND state='AVAILABLE' AND expires_at > now()", [operationId, assetId, sha256])).rows[0]; }
  async create(input: Readonly<{ projectId: string; operationId: string; assetId: string; backend: string; bucket: string; objectKey: string; contentType: string; byteSize: number; sha256: string; expiresAt: string }>): Promise<void> { await this.pool.query("INSERT INTO external_media_staging (project_id,operation_id,asset_id,backend,bucket,object_key,content_type,byte_size,sha256,state,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'AVAILABLE',$10) ON CONFLICT (operation_id,asset_id,sha256) DO NOTHING", [input.projectId,input.operationId,input.assetId,input.backend,input.bucket,input.objectKey,input.contentType,input.byteSize,input.sha256,input.expiresAt]); }
  async claim(input: Readonly<{ projectId: string; operationId: string; assetId: string; backend: string; bucket: string; objectKey: string; contentType: string; byteSize: number; sha256: string; expiresAt: string }>): Promise<Readonly<{ id: string; object_key: string }>> { const r=await this.pool.query<Readonly<{ id: string; object_key: string }>>("INSERT INTO external_media_staging (project_id,operation_id,asset_id,backend,bucket,object_key,content_type,byte_size,sha256,state,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STAGING',$10) ON CONFLICT (operation_id,asset_id,sha256) DO UPDATE SET updated_at=now() RETURNING id, object_key",[input.projectId,input.operationId,input.assetId,input.backend,input.bucket,input.objectKey,input.contentType,input.byteSize,input.sha256,input.expiresAt]); return r.rows[0]!; }
  async markAvailable(id: string): Promise<void> { await this.pool.query("UPDATE external_media_staging SET state='AVAILABLE', last_error=NULL, updated_at=now() WHERE id=$1",[id]); }
  async markUploadFailed(id: string, error: string): Promise<void> { await this.pool.query("UPDATE external_media_staging SET state='UPLOAD_FAILED', last_error=$2, updated_at=now() WHERE id=$1",[id,error]); }
  async markCleanupPending(operationId: string): Promise<number> { const r=await this.pool.query("UPDATE external_media_staging SET state='CLEANUP_PENDING', cleanup_next_attempt_at=now(), updated_at=now() WHERE operation_id=$1 AND state='AVAILABLE'",[operationId]); return r.rowCount??0; }
  async dueCleanup(): Promise<readonly Readonly<{ id: string; object_key: string }>[]> { return (await this.pool.query<Readonly<{ id: string; object_key: string }>>("SELECT id, object_key FROM external_media_staging WHERE state='CLEANUP_PENDING' AND cleanup_next_attempt_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED")).rows; }
  async markCleaned(id: string): Promise<void> { await this.pool.query("UPDATE external_media_staging SET state='CLEANED', cleaned_at=now(), updated_at=now(), last_error=NULL WHERE id=$1",[id]); }
  async markCleanupFailed(id: string, error: string): Promise<void> { await this.pool.query("UPDATE external_media_staging SET cleanup_attempts=cleanup_attempts+1, cleanup_next_attempt_at=now() + interval '5 minutes', last_error=$2, updated_at=now() WHERE id=$1",[id,error]); }
}

type OutboxRow = Readonly<{
  id: string;
  dedupeKey: string;
  workflowJobId: string;
  topic: string;
  payload: Readonly<{ workflowJobId: string }>;
}>;

export class PostgresOutboxStore {
  constructor(private readonly pool: Pool) {}

  async claimUndispatched(limit = 50): Promise<readonly OutboxRow[]> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{
        id: string;
        dedupe_key: string;
        workflow_job_id: string;
        topic: string;
        payload: unknown;
      }>(
        `SELECT id, dedupe_key, workflow_job_id, topic, payload
         FROM workflow_outbox
         WHERE dispatched_at IS NULL
           AND available_at <= now()
           AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= now())
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );
      if (result.rows.length === 0) return [];
      const ids = result.rows.map((row) => row.id);
      await client.query(
        `UPDATE workflow_outbox
         SET dispatch_attempts = dispatch_attempts + 1,
             dispatch_lease_until = now() + interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      return result.rows.map((row) => ({
        id: row.id,
        dedupeKey: row.dedupe_key,
        workflowJobId: row.workflow_job_id,
        topic: row.topic,
        payload: parseJson<{ workflowJobId: string }>(row.payload)
      }));
    });
  }

  async markDispatched(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE workflow_outbox SET dispatched_at = now(), dispatch_lease_until = NULL, last_error = NULL WHERE id = $1",
      [id]
    );
  }

  async markDispatchFailure(id: string, message: string): Promise<void> {
    await this.pool.query(
      "UPDATE workflow_outbox SET last_error = $2, dispatch_lease_until = NULL, available_at = now() + interval '5 seconds' WHERE id = $1",
      [id, message]
    );
  }

  async requeuePendingJobs(): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO workflow_outbox (dedupe_key, workflow_job_id, topic, payload)
       SELECT 'workflow:' || id::text, id, 'workflow.execute', jsonb_build_object('workflowJobId', id::text)
       FROM workflow_jobs
       WHERE status IN ('PENDING', 'RUNNING')
       ON CONFLICT (dedupe_key) DO UPDATE SET dispatched_at = NULL, dispatch_lease_until = NULL, available_at = now()
       RETURNING id`
    );
    return result.rowCount ?? 0;
  }
}

export class PostgresFactoryRepository implements FactoryRepository {
  constructor(private readonly pool: Pool) {}

  async nextProjectNumber(): Promise<number> {
    const result = await this.pool.query<{ value: string }>(
      "SELECT nextval('project_number_sequence')::text AS value"
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("PROJECT_NUMBER_UNAVAILABLE", "Could not allocate project number.");
    return Number(row.value);
  }

  async saveProduct(product: Product): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO products (id, name, slug, description, default_cta, creative_notes, personalization_visual_authority, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, slug = EXCLUDED.slug, description = EXCLUDED.description,
           default_cta = EXCLUDED.default_cta, creative_notes = EXCLUDED.creative_notes,
           personalization_visual_authority = EXCLUDED.personalization_visual_authority,
           active = EXCLUDED.active, updated_at = EXCLUDED.updated_at`,
        [
          product.id,
          product.name,
          product.slug,
          product.description,
          product.defaultCta,
          nullable(product.creativeNotes),
          product.personalizationVisualAuthority === undefined ? null : json(product.personalizationVisualAuthority),
          product.active,
          product.createdAt,
          product.updatedAt
        ]
      );
      await client.query("DELETE FROM product_claims WHERE product_id = $1", [product.id]);
      for (const [position, claim] of product.claims.entries()) {
        await client.query(
          "INSERT INTO product_claims (product_id, kind, text, position) VALUES ($1,$2,$3,$4)",
          [product.id, claim.kind, claim.text, position]
        );
      }
      for (const [position, asset] of product.assets.entries()) {
        await client.query(
          `INSERT INTO product_assets (id, product_id, media_asset_id, kind, label, storage_key, mime_type, position, active)
           VALUES ($1,$2,$1,$3,$4,$5,$6,$7,true)
           ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, storage_key = EXCLUDED.storage_key,
             mime_type = EXCLUDED.mime_type, position = EXCLUDED.position, active = true`,
          [asset.id, product.id, asset.kind, asset.label, asset.storageKey, asset.mimeType, position]
        );
      }
    });
  }

  async getProduct(id: string): Promise<Product> {
    const productResult = await this.pool.query<{
      id: string;
      name: string;
      slug: string;
      description: string;
      default_cta: string;
      creative_notes: string | null;
      personalization_visual_authority: unknown;
      active: boolean;
      created_at: Date;
      updated_at: Date;
    }>("SELECT * FROM products WHERE id = $1", [id]);
    const product = productResult.rows[0];
    if (!product) throw new DomainError("PRODUCT_NOT_FOUND", `Product ${id} was not found.`);
    const [claims, assets] = await Promise.all([
      this.pool.query<{ kind: Product["claims"][number]["kind"]; text: string }>(
        "SELECT kind, text FROM product_claims WHERE product_id = $1 ORDER BY kind, position",
        [id]
      ),
      this.pool.query<{
        id: string;
        kind: Product["assets"][number]["kind"];
        label: string;
        storage_key: string;
        mime_type: string;
      }>(
        "SELECT id, kind, label, storage_key, mime_type FROM product_assets WHERE product_id = $1 AND active ORDER BY position",
        [id]
      )
    ]);
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      defaultCta: product.default_cta,
      ...(product.creative_notes ? { creativeNotes: product.creative_notes } : {}),
      ...(product.personalization_visual_authority ? { personalizationVisualAuthority: parseJson<NonNullable<Product["personalizationVisualAuthority"]>>(product.personalization_visual_authority) } : {}),
      active: product.active,
      claims: claims.rows.map((claim) => ({ kind: claim.kind, text: claim.text })),
      assets: assets.rows.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        label: asset.label,
        storageKey: asset.storage_key,
        mimeType: asset.mime_type
      })),
      createdAt: product.created_at.toISOString(),
      updatedAt: product.updated_at.toISOString()
    };
  }

  async listProducts(): Promise<readonly Product[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM products ORDER BY active DESC, name"
    );
    return Promise.all(result.rows.map((row) => this.getProduct(row.id)));
  }

  async saveConceptProviderOperation(operation: ConceptProviderOperationEvidence): Promise<void> {
    const state=operation.state==="PENDING"?"PENDING_SUBMISSION":operation.state==="SUBMISSION_UNKNOWN"?"SUBMISSION_UNKNOWN":operation.state==="SUCCEEDED"?"SUCCEEDED":operation.state==="SUBMITTING"||operation.state==="POLLING"?"PROCESSING":"FAILED";
    const requestMetadata={snapshotId:operation.snapshotId,snapshotSha256:operation.snapshotSha256,schemaVersion:"creative-concept-execution/v1"};
    const responseMetadata={evidenceState:operation.state,model:operation.model,durationMs:operation.durationMs,usage:operation.usage,resultSha256:operation.resultSha256,safeResult:operation.safeResult,validationFindings:operation.validationFindings,latestProviderStatus:operation.latestProviderStatus,latestPollAt:operation.latestPollAt};
    await this.pool.query(`INSERT INTO provider_jobs(operation_key,provider,operation_type,project_id,external_task_id,provider_task_id,provider_request_id,state,request_fingerprint,request_metadata,response_metadata,submission_attempts,last_error_code,last_error_message,created_at,submitted_at,completed_at)
      VALUES($1,$2,'CONCEPT',$3,$1,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(operation_key) DO UPDATE SET provider=EXCLUDED.provider,provider_task_id=EXCLUDED.provider_task_id,provider_request_id=EXCLUDED.provider_request_id,state=EXCLUDED.state,request_metadata=EXCLUDED.request_metadata,response_metadata=EXCLUDED.response_metadata,last_error_code=EXCLUDED.last_error_code,last_error_message=EXCLUDED.last_error_message,submitted_at=COALESCE(EXCLUDED.submitted_at,provider_jobs.submitted_at),completed_at=EXCLUDED.completed_at`,[
      operation.operationKey,operation.provider,operation.projectId,nullable(operation.providerTaskId),nullable(operation.requestId),state,operation.snapshotSha256??operationHash(requestMetadata),json(requestMetadata),json(responseMetadata),["SUCCEEDED","REJECTED","FAILED"].includes(operation.state)?1:0,nullable(operation.rejectionCode),nullable(operation.safeErrorMessage),operation.submittedAt??operation.latestPollAt??new Date().toISOString(),nullable(operation.submittedAt),nullable(operation.completedAt)
    ]);
  }

  async getConceptProviderOperation(operationKey: string): Promise<ConceptProviderOperationEvidence | undefined> {
    const q=await this.pool.query(`SELECT * FROM provider_jobs WHERE operation_key=$1 AND operation_type='CONCEPT'`,[operationKey]);
    const row=q.rows[0];if(!row)return undefined;
    const request=parseJson<Record<string,unknown>>(row.request_metadata);const response=parseJson<Record<string,unknown>>(row.response_metadata);
    const evidenceState=typeof response.evidenceState==="string"?response.evidenceState:row.state==="SUCCEEDED"?"SUCCEEDED":row.state==="SUBMISSION_UNKNOWN"?"SUBMISSION_UNKNOWN":row.state==="PROCESSING"?"POLLING":row.state==="PENDING_SUBMISSION"?"PENDING":"FAILED";
    return {operationKey:String(row.operation_key),projectId:String(row.project_id),state:evidenceState as ConceptProviderOperationEvidence["state"],provider:String(row.provider),model:typeof response.model==="string"?response.model:"unknown",...(row.provider_request_id?{requestId:String(row.provider_request_id)}:{}),...(row.provider_task_id?{providerTaskId:String(row.provider_task_id)}:{}),...(typeof request.snapshotId==="string"?{snapshotId:request.snapshotId}:{}),...(typeof request.snapshotSha256==="string"?{snapshotSha256:request.snapshotSha256}:{}),...(row.submitted_at?{submittedAt:new Date(row.submitted_at).toISOString()}:{}),...(typeof response.latestProviderStatus==="string"?{latestProviderStatus:response.latestProviderStatus as NonNullable<ConceptProviderOperationEvidence["latestProviderStatus"]>}:{}),...(typeof response.latestPollAt==="string"?{latestPollAt:response.latestPollAt}:{}),...(row.completed_at?{completedAt:new Date(row.completed_at).toISOString()}:{}),...(response.durationMs!==undefined?{durationMs:Number(response.durationMs)}:{}),usage:typeof response.usage==="object"&&response.usage?response.usage as Record<string,unknown>:{},...(typeof response.resultSha256==="string"?{resultSha256:response.resultSha256}:{}),...(typeof response.safeResult==="object"&&response.safeResult?{safeResult:response.safeResult as Record<string,unknown>}:{}),validationFindings:Array.isArray(response.validationFindings)?response.validationFindings.map(String):[],...(row.last_error_code?{rejectionCode:String(row.last_error_code)}:{}),...(row.last_error_message?{safeErrorMessage:String(row.last_error_message)}:{})};
  }

  async beginConceptProviderOperation(operationKey:string):Promise<Readonly<{operation:ConceptProviderOperationEvidence;claimed:boolean}>>{
    const claimed=await this.pool.query(`UPDATE provider_jobs SET state='PROCESSING',response_metadata=response_metadata||'{"evidenceState":"SUBMITTING"}'::jsonb,submission_attempts=submission_attempts+1 WHERE operation_key=$1 AND operation_type='CONCEPT' AND state='PENDING_SUBMISSION' RETURNING operation_key`,[operationKey]);
    const operation=await this.getConceptProviderOperation(operationKey);
    if(!operation)throw new DomainError("CONCEPT_OPERATION_NOT_FOUND","Creative Concept provider operation was not found.");
    return {operation,claimed:Boolean(claimed.rowCount)};
  }

  async saveProject(project: CreativeProject): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO creative_projects
           (id, project_number, public_id, product_id, state, additional_instructions, preferred_voice_profile_id,
            current_concept_id, current_voice_generation_id, current_render_id, ready_path, ready_sha256,
            ready_byte_size, ready_at, version, created_at, updated_at, winner_creative_reference_id, winner_dna_revision_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO UPDATE SET
           state = EXCLUDED.state, additional_instructions = EXCLUDED.additional_instructions,
           preferred_voice_profile_id = EXCLUDED.preferred_voice_profile_id,
           current_concept_id = EXCLUDED.current_concept_id,
           current_voice_generation_id = EXCLUDED.current_voice_generation_id,
           current_render_id = EXCLUDED.current_render_id,
           ready_path = EXCLUDED.ready_path, ready_sha256 = EXCLUDED.ready_sha256,
           ready_byte_size = EXCLUDED.ready_byte_size, ready_at = EXCLUDED.ready_at,
           version = EXCLUDED.version, updated_at = EXCLUDED.updated_at,
           winner_creative_reference_id = EXCLUDED.winner_creative_reference_id,
           winner_dna_revision_id = EXCLUDED.winner_dna_revision_id
         WHERE creative_projects.version < EXCLUDED.version
         RETURNING id`,
        [
          project.id,
          projectNumber(project.publicId),
          project.publicId,
          project.productId,
          project.state,
          project.additionalInstructions,
          project.preferredVoiceProfileId,
          nullable(project.currentConceptId),
          nullable(project.currentVoiceGenerationId),
          nullable(project.currentRenderId),
          nullable(project.readyFile?.path),
          nullable(project.readyFile?.sha256),
          nullable(project.readyFile?.byteSize),
          nullable(project.readyFile?.publishedAt),
          project.version,
          project.createdAt,
          project.updatedAt,
          nullable(project.winnerDnaOrigin?.creativeReferenceId),
          nullable(project.winnerDnaOrigin?.revisionId)
        ]
      );
      if (result.rowCount === 0) {
        throw new DomainError("STALE_PROJECT_VERSION", `Project ${project.publicId} has already been updated.`);
      }

      await client.query(
        `INSERT INTO creative_project_snapshots (project_id, aggregate, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (project_id) DO UPDATE SET aggregate = EXCLUDED.aggregate, updated_at = EXCLUDED.updated_at`,
        [project.id, json(project), project.updatedAt]
      );
      for (const assetId of project.selectedProductAssetIds) {
        await client.query(
          `INSERT INTO creative_project_assets (project_id, product_asset_id, role, selected_at)
           VALUES ($1,$2,'REFERENCE',$3) ON CONFLICT DO NOTHING`,
          [project.id, assetId, project.createdAt]
        );
      }
      await this.syncProjectHistory(client, project);
      await this.ensurePendingOperations(client, project);
    });
  }

  async saveProductAndProject(product: Product, project: CreativeProject): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO products (id, name, slug, description, default_cta, creative_notes, personalization_visual_authority, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, slug=EXCLUDED.slug, description=EXCLUDED.description,
           default_cta=EXCLUDED.default_cta, creative_notes=EXCLUDED.creative_notes,
           personalization_visual_authority=EXCLUDED.personalization_visual_authority,
           active=EXCLUDED.active, updated_at=EXCLUDED.updated_at`,
        [product.id, product.name, product.slug, product.description, product.defaultCta,
          nullable(product.creativeNotes), product.personalizationVisualAuthority === undefined ? null : json(product.personalizationVisualAuthority), product.active, product.createdAt, product.updatedAt]
      );
      await client.query("DELETE FROM product_claims WHERE product_id=$1", [product.id]);
      for (const [position, claim] of product.claims.entries()) {
        await client.query(
          "INSERT INTO product_claims (product_id,kind,text,position) VALUES ($1,$2,$3,$4)",
          [product.id, claim.kind, claim.text, position]
        );
      }
      for (const [position, asset] of product.assets.entries()) {
        await client.query(
          `INSERT INTO product_assets (id,product_id,media_asset_id,kind,label,storage_key,mime_type,position,active)
           VALUES ($1,$2,$1,$3,$4,$5,$6,$7,true)
           ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label,storage_key=EXCLUDED.storage_key,
             mime_type=EXCLUDED.mime_type,position=EXCLUDED.position,active=true`,
          [asset.id, product.id, asset.kind, asset.label, asset.storageKey, asset.mimeType, position]
        );
      }
      const saved = await client.query(
        `INSERT INTO creative_projects
           (id,project_number,public_id,product_id,state,additional_instructions,preferred_voice_profile_id,
            current_concept_id,current_voice_generation_id,current_render_id,ready_path,ready_sha256,
            ready_byte_size,ready_at,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           state=EXCLUDED.state,additional_instructions=EXCLUDED.additional_instructions,
           preferred_voice_profile_id=EXCLUDED.preferred_voice_profile_id,
           current_concept_id=EXCLUDED.current_concept_id,current_voice_generation_id=EXCLUDED.current_voice_generation_id,
           current_render_id=EXCLUDED.current_render_id,ready_path=EXCLUDED.ready_path,
           ready_sha256=EXCLUDED.ready_sha256,ready_byte_size=EXCLUDED.ready_byte_size,
           ready_at=EXCLUDED.ready_at,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at
         WHERE creative_projects.version < EXCLUDED.version RETURNING id`,
        [project.id, projectNumber(project.publicId), project.publicId, project.productId, project.state,
          project.additionalInstructions, project.preferredVoiceProfileId, nullable(project.currentConceptId),
          nullable(project.currentVoiceGenerationId), nullable(project.currentRenderId), nullable(project.readyFile?.path),
          nullable(project.readyFile?.sha256), nullable(project.readyFile?.byteSize), nullable(project.readyFile?.publishedAt),
          project.version, project.createdAt, project.updatedAt]
      );
      if (saved.rowCount === 0) {
        throw new DomainError("STALE_PROJECT_VERSION", `Project ${project.publicId} has already been updated.`);
      }
      await client.query(
        `INSERT INTO creative_project_snapshots (project_id,aggregate,updated_at)
         VALUES ($1,$2::jsonb,$3)
         ON CONFLICT (project_id) DO UPDATE SET aggregate=EXCLUDED.aggregate,updated_at=EXCLUDED.updated_at`,
        [project.id, json(project), project.updatedAt]
      );
      for (const assetId of project.selectedProductAssetIds) {
        await client.query(
          `INSERT INTO creative_project_assets (project_id,product_asset_id,role,selected_at)
           VALUES ($1,$2,'REFERENCE',$3) ON CONFLICT DO NOTHING`,
          [project.id, assetId, project.updatedAt]
        );
      }
      await this.syncProjectHistory(client, project);
      await this.ensurePendingOperations(client, project);
    });
  }

  async getProject(id: string): Promise<CreativeProject> {
    const result = await this.pool.query<{ aggregate: unknown }>(
      "SELECT snapshots.aggregate FROM creative_project_snapshots snapshots JOIN creative_projects projects ON projects.id=snapshots.project_id WHERE snapshots.project_id = $1 AND projects.archived_at IS NULL",
      [id]
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("PROJECT_NOT_FOUND", `Project ${id} was not found.`);
    return parseJson<CreativeProject>(row.aggregate);
  }

  async listProjects(): Promise<readonly CreativeProject[]> {
    const result = await this.pool.query<{ aggregate: unknown }>(
      `SELECT snapshots.aggregate FROM creative_project_snapshots snapshots
       JOIN creative_projects projects ON projects.id = snapshots.project_id
       WHERE projects.archived_at IS NULL
       ORDER BY projects.updated_at DESC`
    );
    return result.rows.map((row) => parseJson<CreativeProject>(row.aggregate));
  }

  async enqueueJob(job: WorkflowJob): Promise<WorkflowJob> {
    return transaction(this.pool, (client) => this.ensureJob(client, job));
  }

  async getJobByDedupeKey(dedupeKey: string): Promise<WorkflowJob | undefined> {
    const result = await this.pool.query("SELECT * FROM workflow_jobs WHERE dedupe_key = $1", [dedupeKey]);
    return result.rows[0] ? this.mapJob(result.rows[0]) : undefined;
  }

  async getJob(id: string): Promise<WorkflowJob> {
    const result = await this.pool.query("SELECT * FROM workflow_jobs WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) throw new DomainError("JOB_NOT_FOUND", `Workflow job ${id} was not found.`);
    return this.mapJob(row);
  }

  async saveJob(job: WorkflowJob): Promise<void> {
    const result = await this.pool.query(
      `UPDATE workflow_jobs SET status = $2, attempts = $3, last_error = $4, updated_at = $5, next_attempt_at = $6 WHERE id = $1`,
      [job.id, job.status, job.attempts, nullable(job.lastError), job.updatedAt, nullable(job.nextAttemptAt)]
    );
    if (result.rowCount !== 1) throw new DomainError("JOB_NOT_FOUND", `Workflow job ${job.id} was not found.`);
  }

  async listJobs(projectId: string): Promise<readonly WorkflowJob[]> {
    const result = await this.pool.query(
      "SELECT * FROM workflow_jobs WHERE project_id = $1 ORDER BY created_at",
      [projectId]
    );
    return result.rows.map((row) => this.mapJob(row));
  }

  private async syncProjectHistory(client: PoolClient, project: CreativeProject): Promise<void> {
    for (const concept of project.concepts) {
      await client.query(
        `INSERT INTO creative_concepts
          (id, project_id, revision, source, status, angle, hook, target_duration_ms, voice_script, cta,
           editing_style_key, music_category, input_snapshot, provider_metadata, concept_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, concept_json = EXCLUDED.concept_json,
           provider_metadata = EXCLUDED.provider_metadata`,
        [
          concept.id, project.id, concept.revision, concept.source, concept.status, concept.angle, concept.hook,
          concept.targetDurationMs, concept.voiceScript, concept.cta, concept.editingStyleKey, concept.musicCategory,
          json(concept.inputSnapshot), json(concept.providerMetadata), json(concept), concept.createdAt
        ]
      );
      for (const scene of concept.scenes) {
        await client.query(
          `INSERT INTO concept_scene_specs
            (concept_id, scene_number, duration_ms, purpose, source_type, generation_prompt, overlay_text, accuracy_requirements, spec_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
           ON CONFLICT (concept_id, scene_number) DO UPDATE SET
             generation_prompt = EXCLUDED.generation_prompt, overlay_text = EXCLUDED.overlay_text, spec_json = EXCLUDED.spec_json`,
          [concept.id, scene.sceneNumber, scene.intendedDurationMs, scene.purpose, scene.sourceType, scene.generationPrompt, scene.overlayText, json(scene.accuracyRequirements), json(scene)]
        );
      }
      await this.upsertProviderJob(client, project.id, String(concept.providerMetadata.operationKey ?? `concept:${project.id}:revision:${concept.revision}:generate`), "CONCEPT", undefined, undefined, undefined, typeof concept.providerMetadata.providerTaskId === "string" ? concept.providerMetadata.providerTaskId : undefined, concept.status, concept);
    }
    for (const scene of project.scenes) {
      await client.query(
        `INSERT INTO creative_scenes (id, project_id, scene_number, status, approved_attempt_id, scene_json)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, approved_attempt_id = EXCLUDED.approved_attempt_id, scene_json = EXCLUDED.scene_json`,
        [scene.id, project.id, scene.sceneNumber, scene.status, nullable(scene.approvedAttemptId), json(scene)]
      );
      for (const attempt of scene.attempts) {
        await client.query(
          `INSERT INTO scene_attempts
            (id, scene_id, attempt_number, source_type, concept_scene_number, prompt, status, operation_key,
             input_asset_id, output_asset_id, provider_task_id, replaces_attempt_id, failure_message, attempt_json, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, prompt = EXCLUDED.prompt,
             input_asset_id = EXCLUDED.input_asset_id, output_asset_id = EXCLUDED.output_asset_id, provider_task_id = EXCLUDED.provider_task_id,
             failure_message = EXCLUDED.failure_message, attempt_json = EXCLUDED.attempt_json, updated_at = EXCLUDED.updated_at`,
          [attempt.id, scene.id, attempt.attemptNumber, attempt.sourceType, attempt.conceptSceneNumber, attempt.prompt,
            attempt.status, attempt.operationKey, nullable(attempt.inputAssetId), nullable(attempt.outputAssetId), nullable(attempt.providerTaskId),
            nullable(attempt.replacesAttemptId), nullable(attempt.failureMessage), json(attempt), attempt.createdAt, attempt.updatedAt]
        );
        await this.upsertProviderJob(client, project.id, attempt.operationKey, "VIDEO", attempt.id, undefined, undefined, attempt.providerTaskId, attempt.status, attempt);
      }
    }
    for (const voice of project.voiceGenerations) {
      await client.query(
        `INSERT INTO voice_generations
          (id, project_id, attempt_number, voice_profile_id, source_script, status, operation_key, provider_task_id, output_asset_id, voice_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, provider_task_id = EXCLUDED.provider_task_id,
           output_asset_id = EXCLUDED.output_asset_id, voice_json = EXCLUDED.voice_json, updated_at = EXCLUDED.updated_at`,
        [voice.id, project.id, voice.attemptNumber, voice.voiceProfileId, voice.sourceScript, voice.status, voice.operationKey,
          nullable(voice.providerTaskId), nullable(voice.outputAssetId), json(voice), voice.createdAt, voice.updatedAt]
      );
      await this.upsertProviderJob(client, project.id, voice.operationKey, "VOICE", undefined, voice.id, undefined, voice.providerTaskId, voice.status, voice);
    }
    for (const render of project.renders) {
      await client.query(
        `INSERT INTO renders
          (id, project_id, attempt_number, status, operation_key, voice_generation_id, composition_style_key, cta,
           provider_task_id, output_asset_id, output_sha256, render_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, provider_task_id = EXCLUDED.provider_task_id,
           output_asset_id = EXCLUDED.output_asset_id, output_sha256 = EXCLUDED.output_sha256,
           render_json = EXCLUDED.render_json, updated_at = EXCLUDED.updated_at`,
        [render.id, project.id, render.attemptNumber, render.status, render.operationKey, render.voiceGenerationId,
          render.compositionStyleKey, render.cta, nullable(render.providerTaskId), nullable(render.outputAssetId),
          nullable(render.outputSha256), json(render), render.createdAt, render.updatedAt]
      );
      for (const [position, attemptId] of render.sceneAttemptIds.entries()) {
        const scene = project.scenes.find((candidate) => candidate.attempts.some((attempt) => attempt.id === attemptId));
        if (scene) {
          await client.query(
            `INSERT INTO render_scene_inputs (render_id, scene_id, scene_attempt_id, position)
             VALUES ($1,$2,$3,$4) ON CONFLICT (render_id, position) DO NOTHING`,
            [render.id, scene.id, attemptId, position]
          );
        }
      }
      await this.upsertProviderJob(client, project.id, render.operationKey, "COMPOSITION", undefined, undefined, render.id, render.providerTaskId, render.status, render);
    }
    for (const cost of project.usageCosts) {
      await client.query(
        `INSERT INTO usage_costs
          (id, provider, model, operation_type, project_id, provider_request_id, status, estimated_cost, actual_cost, currency, cost_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT (id) DO NOTHING`,
        [cost.id, cost.provider, cost.model, cost.operationType, project.id, cost.requestId, cost.status,
          nullable(cost.estimatedCost), nullable(cost.actualCost), cost.currency, json(cost), cost.createdAt]
      );
    }
    for (const approval of project.approvals) {
      await client.query(
        `INSERT INTO approvals (id, project_id, stage, target_id, target_sha256, decision, actor, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [approval.id, project.id, approval.stage, approval.targetId, nullable(approval.targetSha256), approval.decision,
          approval.actor, nullable(approval.note), approval.createdAt]
      );
    }
    for (const event of project.auditEvents) {
      await client.query(
        `INSERT INTO audit_events (id, project_id, event_type, entity_type, entity_id, actor, details, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (id) DO NOTHING`,
        [event.id, project.id, event.type, event.entityType, event.entityId, event.actor, json(event.details), event.createdAt]
      );
    }
  }

  private async upsertProviderJob(
    client: PoolClient,
    projectId: string,
    operationKey: string,
    operationType: "CONCEPT" | "VIDEO" | "VOICE" | "COMPOSITION",
    sceneAttemptId: string | undefined,
    voiceGenerationId: string | undefined,
    renderId: string | undefined,
    providerTaskId: string | undefined,
    status: string,
    request: unknown
  ): Promise<void> {
    const state = status === "SUBMISSION_UNKNOWN" ? "SUBMISSION_UNKNOWN" : status === "FAILED" || status === "QA_FAILED"
      ? "FAILED"
      : providerTaskId
        ? (["REVIEW", "APPROVED", "SUPERSEDED", "ACCEPTED", "SUCCEEDED"].includes(status)
            ? "SUCCEEDED"
            : status === "PROCESSING" ? "PROCESSING" : "SUBMITTED")
        : "PENDING_SUBMISSION";
    const provider = typeof request === "object" && request !== null && "provider" in request
      ? String((request as { provider?: unknown }).provider ?? "fake")
      : "fake";
    await client.query(
      `INSERT INTO provider_jobs
        (operation_key, provider, operation_type, project_id, scene_attempt_id, voice_generation_id, render_id,
         external_task_id, provider_task_id, state, request_fingerprint, request_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1,$8,$9,$10,$11::jsonb)
       ON CONFLICT (operation_key) DO UPDATE SET provider_task_id = EXCLUDED.provider_task_id,
         state = EXCLUDED.state,
         request_metadata = CASE WHEN provider_jobs.operation_type='CONCEPT' AND provider_jobs.response_metadata ? 'evidenceState' THEN provider_jobs.request_metadata ELSE EXCLUDED.request_metadata END,
         response_metadata = CASE WHEN provider_jobs.operation_type='CONCEPT' AND provider_jobs.response_metadata ? 'evidenceState' THEN provider_jobs.response_metadata ELSE EXCLUDED.response_metadata END`,
      [operationKey, provider, operationType, projectId, nullable(sceneAttemptId), nullable(voiceGenerationId), nullable(renderId),
        nullable(providerTaskId), state, operationHash(request), json(request)]
    );
  }

  private async ensurePendingOperations(client: PoolClient, project: CreativeProject): Promise<void> {
    const now = project.updatedAt;
    for (const scene of project.scenes) {
      for (const attempt of scene.attempts) {
        if (attempt.status === "PENDING") {
          await this.ensureJob(client, this.newJob("GENERATE_SCENE", project.id, attempt.id, attempt.operationKey, now));
        }
      }
    }
    for (const voice of project.voiceGenerations) {
      if (voice.status === "PENDING") {
        await this.ensureJob(client, this.newJob("GENERATE_VOICE", project.id, voice.id, voice.operationKey, now));
      }
    }
    for (const render of project.renders) {
      if (render.status === "PENDING") {
        await this.ensureJob(client, this.newJob("COMPOSE_RENDER", project.id, render.id, render.operationKey, now));
      }
    }
  }

  private newJob(type: WorkflowJobType, projectId: string, targetId: string, operationKey: string, timestamp: string): WorkflowJob {
    return {
      id: randomUUID(), dedupeKey: operationKey, type, projectId, targetId, status: "PENDING", attempts: 0,
      createdAt: timestamp, updatedAt: timestamp
    };
  }

  private async ensureJob(client: PoolClient, job: WorkflowJob): Promise<WorkflowJob> {
    const inserted = await client.query<QueryResultRow>(
      `INSERT INTO workflow_jobs (id, dedupe_key, type, project_id, target_id, status, attempts, last_error, created_at, updated_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [job.id, job.dedupeKey, job.type, job.projectId, job.targetId, job.status, job.attempts,
        nullable(job.lastError), job.createdAt, job.updatedAt, nullable(job.nextAttemptAt)]
    );
    const existing = inserted.rows[0] ?? (await client.query<QueryResultRow>("SELECT * FROM workflow_jobs WHERE dedupe_key = $1", [job.dedupeKey])).rows[0];
    if (!existing) throw new DomainError("JOB_INSERT_FAILED", "Could not persist workflow job.");
    const persisted = this.mapJob(existing);
    await client.query(
      `INSERT INTO workflow_outbox (dedupe_key, workflow_job_id, topic, payload)
       VALUES ($1,$2,'workflow.execute',$3::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [`workflow:${persisted.id}`, persisted.id, json({ workflowJobId: persisted.id })]
    );
    return persisted;
  }

  private mapJob(row: QueryResultRow): WorkflowJob {
    return {
      id: String(row.id),
      dedupeKey: String(row.dedupe_key),
      type: row.type as WorkflowJobType,
      projectId: String(row.project_id),
      targetId: String(row.target_id),
      status: row.status as WorkflowJob["status"],
      attempts: Number(row.attempts),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
      ...(row.next_attempt_at ? { nextAttemptAt: new Date(row.next_attempt_at as string).toISOString() } : {}),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString()
    };
  }
}
