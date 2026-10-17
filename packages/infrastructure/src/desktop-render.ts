import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { DomainError } from "@koolezt/domain";
import type { CompositionOutput, CompositionProvider, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, RenderInputSnapshot, StorageProvider } from "@koolezt/domain";

export const DESKTOP_RENDER_PROTOCOL_VERSION = "render-worker/v1";
export type DesktopRenderJobState = "WAITING" | "CLAIMED" | "RENDERING" | "UPLOADING" | "SUCCEEDED" | "FAILED";
export type DesktopRenderJob = Readonly<{
  id: string; projectId: string; renderId?: string; variantId?: string; requiredCapability?: string; operationKey: string; protocolVersion: string;
  state: DesktopRenderJobState; inputSnapshot: RenderInputSnapshot; workerId?: string;
  leaseExpiresAt?: string; progressStage?: string; progressPercent?: number; encoder?: string;
  outputUploadAssetId?: string;
  outputAssetId?: string; outputSha256?: string; failureCode?: string; failureMessage?: string;
  createdAt: string; updatedAt: string;
}>;
export type DesktopRenderClaim = Readonly<{ job: DesktopRenderJob; leaseToken: string }>;

export interface DesktopRenderJobStore {
  ensure(input: Readonly<{ projectId: string; renderId?: string; variantId?: string; requiredCapability?: string; operationKey: string; snapshot: RenderInputSnapshot }>): Promise<DesktopRenderJob>;
  get(id: string): Promise<DesktopRenderJob>;
  claim(workerId: string, leaseMs: number, capabilities?: readonly string[]): Promise<DesktopRenderClaim | undefined>;
  authorize(id: string, workerId: string, leaseToken: string): Promise<DesktopRenderJob>;
  renew(id: string, workerId: string, leaseToken: string, leaseMs: number): Promise<DesktopRenderJob>;
  progress(id: string, workerId: string, leaseToken: string, stage: string, percent?: number, encoder?: string): Promise<DesktopRenderJob>;
  succeed(id: string, workerId: string, leaseToken: string, outputAssetId: string, sha256: string): Promise<DesktopRenderJob>;
  fail(id: string, workerId: string, leaseToken: string, code: string, message: string): Promise<DesktopRenderJob>;
  attachOutputUpload(id: string, workerId: string, leaseToken: string, assetId: string): Promise<DesktopRenderJob>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
function map(row: QueryResultRow): DesktopRenderJob {
  return {
    id: String(row.id), projectId: String(row.project_id), ...(row.render_id ? { renderId: String(row.render_id) } : {}), ...(row.variant_id ? { variantId: String(row.variant_id) } : {}), ...(row.required_capability ? { requiredCapability: String(row.required_capability) } : {}), operationKey: String(row.operation_key), protocolVersion: String(row.protocol_version),
    state: row.state as DesktopRenderJobState, inputSnapshot: (typeof row.input_snapshot === "string" ? JSON.parse(row.input_snapshot) : row.input_snapshot) as RenderInputSnapshot,
    ...(row.worker_id ? { workerId: String(row.worker_id) } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: new Date(row.lease_expires_at as string).toISOString() } : {}),
    ...(row.progress_stage ? { progressStage: String(row.progress_stage) } : {}), ...(row.progress_percent !== null && row.progress_percent !== undefined ? { progressPercent: Number(row.progress_percent) } : {}),
    ...(row.encoder ? { encoder: String(row.encoder) } : {}), ...(row.output_upload_asset_id ? { outputUploadAssetId: String(row.output_upload_asset_id) } : {}), ...(row.output_asset_id ? { outputAssetId: String(row.output_asset_id) } : {}), ...(row.output_sha256 ? { outputSha256: String(row.output_sha256) } : {}),
    ...(row.failure_code ? { failureCode: String(row.failure_code) } : {}), ...(row.failure_message ? { failureMessage: String(row.failure_message) } : {}),
    createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

export class PostgresDesktopRenderJobStore implements DesktopRenderJobStore {
  constructor(private readonly pool: Pool) {}
  async ensure(input: Readonly<{ projectId: string; renderId?: string; variantId?: string; requiredCapability?: string; operationKey: string; snapshot: RenderInputSnapshot }>): Promise<DesktopRenderJob> {
    const now = new Date().toISOString();
    const result = await this.pool.query(`INSERT INTO desktop_render_jobs (id,project_id,render_id,variant_id,required_capability,operation_key,protocol_version,state,input_snapshot,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'WAITING',$8::jsonb,$9,$9) ON CONFLICT (operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING *`,
      [randomUUID(), input.projectId, input.renderId ?? null, input.variantId ?? null, input.requiredCapability ?? null, input.operationKey, DESKTOP_RENDER_PROTOCOL_VERSION, json(input.snapshot), now]);
    return map(result.rows[0]!);
  }
  async get(id: string): Promise<DesktopRenderJob> {
    const result = await this.pool.query("SELECT * FROM desktop_render_jobs WHERE id=$1", [id]);
    if (!result.rows[0]) throw new DomainError("DESKTOP_RENDER_JOB_NOT_FOUND", "Desktop render job was not found.");
    return map(result.rows[0]);
  }
  async claim(workerId: string, leaseMs: number, capabilities: readonly string[] = []): Promise<DesktopRenderClaim | undefined> {
    const token = randomBytes(32).toString("base64url");
    const result = await this.pool.query(`WITH candidate AS (
      SELECT id FROM desktop_render_jobs WHERE (required_capability IS NULL OR required_capability = ANY($4::text[])) AND (state='WAITING' OR (state IN ('CLAIMED','RENDERING','UPLOADING') AND lease_expires_at < now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE desktop_render_jobs jobs SET state='CLAIMED',worker_id=$1,lease_token_hash=$2,lease_expires_at=now()+($3*interval '1 millisecond'),claimed_at=COALESCE(claimed_at,now()),updated_at=now()
      FROM candidate WHERE jobs.id=candidate.id RETURNING jobs.*`, [workerId, hash(token), Math.max(30_000, leaseMs), capabilities]);
    return result.rows[0] ? { job: map(result.rows[0]), leaseToken: token } : undefined;
  }
  private async mutate(id: string, workerId: string, leaseToken: string, sql: string, values: readonly unknown[]): Promise<DesktopRenderJob> {
    const result = await this.pool.query(`${sql} WHERE id=$1 AND worker_id=$2 AND lease_token_hash=$3 AND lease_expires_at>now() RETURNING *`, [id, workerId, hash(leaseToken), ...values]);
    if (!result.rows[0]) throw new DomainError("DESKTOP_RENDER_LEASE_INVALID", "The desktop render lease is missing, expired, or owned by another worker.");
    return map(result.rows[0]);
  }
  async authorize(id: string, workerId: string, leaseToken: string): Promise<DesktopRenderJob> {
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET updated_at=updated_at", []);
  }
  async renew(id: string, workerId: string, leaseToken: string, leaseMs: number): Promise<DesktopRenderJob> {
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET lease_expires_at=now()+($4*interval '1 millisecond'),updated_at=now()", [Math.max(30_000, leaseMs)]);
  }
  async progress(id: string, workerId: string, leaseToken: string, stage: string, percent?: number, encoder?: string): Promise<DesktopRenderJob> {
    const state: DesktopRenderJobState = stage === "Uploading" ? "UPLOADING" : "RENDERING";
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET state=$4,progress_stage=$5,progress_percent=$6,encoder=COALESCE($7,encoder),updated_at=now()", [state, stage, percent ?? null, encoder ?? null]);
  }
  async attachOutputUpload(id: string, workerId: string, leaseToken: string, assetId: string): Promise<DesktopRenderJob> {
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET output_upload_asset_id=COALESCE(output_upload_asset_id,$4),updated_at=now()", [assetId]);
  }
  async succeed(id: string, workerId: string, leaseToken: string, outputAssetId: string, sha256: string): Promise<DesktopRenderJob> {
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET state='SUCCEEDED',output_asset_id=$4,output_sha256=$5,progress_stage='Completed',progress_percent=100,completed_at=now(),updated_at=now()", [outputAssetId, sha256]);
  }
  async fail(id: string, workerId: string, leaseToken: string, code: string, message: string): Promise<DesktopRenderJob> {
    return this.mutate(id, workerId, leaseToken, "UPDATE desktop_render_jobs SET state='FAILED',failure_code=$4,failure_message=$5,completed_at=now(),updated_at=now()", [code, message.slice(0, 500)]);
  }
}

export class DesktopCompositionProvider implements CompositionProvider {
  readonly requiresExternalMedia = false;
  constructor(private readonly jobs: DesktopRenderJobStore, private readonly storage: StorageProvider) {}
  async submit(input: Parameters<CompositionProvider["submit"]>[0], context: ProviderOperationContext): Promise<ProviderSubmission> {
    const job = await this.jobs.ensure({ projectId: context.projectId, renderId: context.targetId, operationKey: context.operationKey, snapshot: input.snapshot });
    return { providerTaskId: job.id, requestId: job.id, provider: "desktop-worker", model: DESKTOP_RENDER_PROTOCOL_VERSION, metadata: { state: job.state, protocolVersion: job.protocolVersion } };
  }
  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<CompositionOutput>> {
    const job = await this.jobs.get(providerTaskId);
    if (job.state === "FAILED") return { state: "FAILED", message: job.failureMessage ?? "Desktop render failed.", retryable: false };
    if (job.state !== "SUCCEEDED" || !job.outputAssetId) return { state: "PROCESSING" };
    const asset = await this.storage.getAsset(job.outputAssetId);
    return { state: "SUCCEEDED", result: { kind: "INTERNAL_ASSET", asset, metadata: { desktopRenderJobId: job.id, encoder: job.encoder, protocolVersion: job.protocolVersion } } };
  }
}
