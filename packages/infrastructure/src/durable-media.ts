import type { Pool } from "pg";
import type { GeneratedAsset } from "@koolezt/domain";

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;

type AssetRow = Readonly<{
  id: string;
  project_id: string | null;
  storage_provider: string;
  storage_bucket: string | null;
  storage_key: string;
  purpose: string | null;
  kind: GeneratedAsset["kind"];
  mime_type: string;
  byte_size: string;
  sha256: string;
  metadata: unknown;
  lifecycle_status: GeneratedAsset["lifecycleStatus"];
  delete_after: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}>;

function map(row: AssetRow): GeneratedAsset {
  return {
    id: row.id,
    kind: row.kind,
    storageProvider: row.storage_provider,
    ...(row.storage_bucket ? { storageBucket: row.storage_bucket } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.lifecycle_status ? { lifecycleStatus: row.lifecycle_status } : {}),
    ...(row.delete_after ? { deleteAfter: row.delete_after.toISOString() } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    metadata: parse<Record<string, unknown>>(row.metadata),
    createdAt: row.created_at.toISOString()
  };
}

export class PostgresDurableMediaAssetCatalog {
  constructor(private readonly pool: Pool) {}

  async createPending(asset: GeneratedAsset, originalFilename?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO media_assets
         (id, project_id, storage_provider, storage_bucket, storage_key, purpose, kind, mime_type,
          byte_size, sha256, metadata, status, lifecycle_status, original_filename, created_at, updated_at)
       VALUES ($1,$2,'s3',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'UPLOADING','PENDING_UPLOAD',$11,$12,$12)`,
      [asset.id, asset.projectId ?? null, asset.storageBucket ?? null, asset.storageKey, asset.purpose ?? null,
       asset.kind, asset.mimeType, asset.byteSize, asset.sha256, json(asset.metadata),
       originalFilename?.slice(0, 255) ?? null, asset.createdAt]
    );
  }

  async get(assetId: string, includeUnavailable = false): Promise<GeneratedAsset | undefined> {
    const result = await this.pool.query<AssetRow>(
      `SELECT id,project_id,storage_provider,storage_bucket,storage_key,purpose,kind,mime_type,
              byte_size,sha256,metadata,lifecycle_status,delete_after,deleted_at,created_at
       FROM media_assets WHERE id=$1 AND ($2::boolean OR lifecycle_status='AVAILABLE')`,
      [assetId, includeUnavailable]
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }

  async markAvailable(assetId: string): Promise<void> {
    await this.pool.query(
      "UPDATE media_assets SET status='AVAILABLE',lifecycle_status='AVAILABLE',lifecycle_error=NULL,updated_at=now() WHERE id=$1 AND lifecycle_status IN ('PENDING_UPLOAD','AVAILABLE')",
      [assetId]
    );
  }

  async markFailed(assetId: string, safeReason: string): Promise<void> {
    await this.pool.query(
      "UPDATE media_assets SET status='QUARANTINED',lifecycle_status='FAILED',lifecycle_error=$2,updated_at=now() WHERE id=$1",
      [assetId, safeReason.slice(0, 300)]
    );
  }

  async reconcileRetention(now: string, rejectedGraceDays: number, readyGraceDays: number, abandonedHours: number): Promise<void> {
    await this.pool.query(
      `UPDATE media_assets SET delete_after=COALESCE(delete_after,created_at+($2*interval '1 hour')),updated_at=$1
       WHERE storage_provider='s3' AND lifecycle_status IN ('PENDING_UPLOAD','FAILED') AND delete_after IS NULL`,
      [now, abandonedHours]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,s.updated_at+($2*interval '1 day')),updated_at=$1
       FROM scene_attempts s WHERE s.output_asset_id=a.id AND s.status IN ('REJECTED','FAILED')
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now, rejectedGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,v.updated_at+($2*interval '1 day')),updated_at=$1
       FROM voice_generations v WHERE v.output_asset_id=a.id AND v.status='REJECTED'
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now, rejectedGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,p.ready_at+($2*interval '1 day')),updated_at=$1
       FROM scene_attempts s JOIN creative_scenes cs ON cs.id=s.scene_id
       JOIN creative_projects p ON p.id=cs.project_id
       WHERE s.output_asset_id=a.id AND s.status='ACCEPTED' AND p.state='READY'
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now, readyGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,p.ready_at+($2*interval '1 day')),updated_at=$1
       FROM voice_generations v JOIN creative_projects p ON p.id=v.project_id
       WHERE v.output_asset_id=a.id AND v.status='ACCEPTED' AND p.state='READY'
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now, readyGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,r.updated_at+($2*interval '1 day')),updated_at=$1
       FROM renders r JOIN creative_projects p ON p.id=r.project_id
       LEFT JOIN creative_project_snapshots ps ON ps.project_id=p.id
       WHERE r.output_asset_id=a.id AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'
         AND (r.status IN ('FAILED','QA_FAILED') OR (
           p.current_render_id IS DISTINCT FROM r.id AND NOT (
             p.state='READY' AND r.status='SUCCEEDED' AND COALESCE(ps.aggregate->'publishedRenderIds','[]'::jsonb) ? r.id::text
           )
         ))`,
      [now, rejectedGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,p.ready_at+($2*interval '1 day')),updated_at=$1
       FROM renders r JOIN creative_projects p ON p.id=r.project_id
       JOIN creative_project_snapshots ps ON ps.project_id=p.id
       WHERE r.output_asset_id=a.id AND p.state='READY' AND r.status='SUCCEEDED'
         AND p.current_render_id IS DISTINCT FROM r.id
         AND COALESCE(ps.aggregate->'publishedRenderIds','[]'::jsonb) ? r.id::text
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now, readyGraceDays]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=COALESCE(a.delete_after,v.delete_after),updated_at=$1
       FROM creative_variants v WHERE v.output_asset_id=a.id AND v.status IN ('READY','FAILED')
         AND a.storage_provider='s3' AND a.lifecycle_status='AVAILABLE'`,
      [now]
    );    await this.pool.query(
      `UPDATE media_assets a SET delete_after=NULL,updated_at=$1
       FROM renders r JOIN creative_projects p ON p.current_render_id=r.id
       WHERE r.output_asset_id=a.id AND p.state='READY' AND r.status='SUCCEEDED'`,
      [now]
    );
    await this.pool.query(
      `UPDATE media_assets SET delete_after=NULL,updated_at=$1
       WHERE purpose='PRODUCT_REFERENCE' AND lifecycle_status='AVAILABLE'`,
      [now]
    );
    await this.pool.query(
      `UPDATE media_assets a SET delete_after=NULL,updated_at=$1
       WHERE a.lifecycle_status='AVAILABLE'
         AND EXISTS (SELECT 1 FROM creative_references cr WHERE cr.source_asset_id=a.id)`,
      [now]
    );
  }

  async dueCleanup(now: string, limit: number): Promise<readonly GeneratedAsset[]> {
    const result = await this.pool.query<AssetRow>(
      `SELECT id,project_id,storage_provider,storage_bucket,storage_key,purpose,kind,mime_type,
              byte_size,sha256,metadata,lifecycle_status,delete_after,deleted_at,created_at
       FROM media_assets a WHERE storage_provider='s3'
         AND lifecycle_status IN ('PENDING_UPLOAD','FAILED','AVAILABLE') AND delete_after <= $1
         AND NOT EXISTS (SELECT 1 FROM creative_references cr WHERE cr.source_asset_id=a.id)
       ORDER BY delete_after LIMIT $2`,
      [now, Math.max(1, Math.min(limit, 200))]
    );
    return result.rows.map(map);
  }

  async markCleanupPending(assetId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE media_assets SET lifecycle_status='CLEANUP_PENDING',updated_at=now()
       WHERE id=$1 AND storage_provider='s3' AND lifecycle_status IN ('PENDING_UPLOAD','FAILED','AVAILABLE')
         AND delete_after <= now()
         AND NOT EXISTS (SELECT 1 FROM creative_references cr WHERE cr.source_asset_id=media_assets.id)`,
      [assetId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async markCleaned(assetId: string): Promise<void> {
    await this.pool.query(
      "UPDATE media_assets SET status='DELETED',lifecycle_status='CLEANED',deleted_at=now(),lifecycle_error=NULL,updated_at=now() WHERE id=$1 AND lifecycle_status='CLEANUP_PENDING'",
      [assetId]
    );
  }

  async markCleanupFailed(assetId: string, safeReason: string): Promise<void> {
    await this.pool.query(
      "UPDATE media_assets SET lifecycle_status='FAILED',lifecycle_error=$2,delete_after=now()+interval '1 hour',updated_at=now() WHERE id=$1 AND lifecycle_status='CLEANUP_PENDING'",
      [assetId, safeReason.slice(0, 300)]
    );
  }
}
