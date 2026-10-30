/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool } from "pg";
import { DomainError } from "@koolezt/domain";
import type { VideoPlan, WinnerJob, WinnerJobRepository, WinnerVideo, WinnerVideoBatch, WinnerVideoRepository } from "@koolezt/domain";

const iso = (value: unknown) => new Date(value as string).toISOString();
const mapJob = (r: any): WinnerJob => ({
  id: r.id, kind: r.kind, targetId: r.target_id, operationKey: r.operation_key, status: r.status, attempts: Number(r.attempts),
  ...(r.next_attempt_at ? { nextAttemptAt: iso(r.next_attempt_at) } : {}), ...(r.last_error ? { lastError: r.last_error } : {}),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});
const mapBatch = (r: any): WinnerVideoBatch => ({
  id: r.id, creativeReferenceId: r.creative_reference_id, productId: r.product_id, requestedCount: Number(r.requested_count) as 3 | 6 | 12,
  targetDurationMs: Number(r.target_duration_ms) as 15_000 | 30_000, status: r.status, ...(r.failure_message ? { failureMessage: r.failure_message } : {}),
  providerMetadata: r.provider_metadata ?? {}, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});
const mapVideo = (r: any): WinnerVideo => ({
  id: r.id, batchId: r.batch_id, ordinal: Number(r.ordinal), plan: r.plan as VideoPlan, status: r.status,
  ...(r.output_asset_id ? { outputAssetId: r.output_asset_id } : {}), ...(r.duration_ms !== null && r.duration_ms !== undefined ? { durationMs: Number(r.duration_ms) } : {}),
  ...(r.failure_message ? { failureMessage: r.failure_message } : {}), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

export class PostgresWinnerJobStore implements WinnerJobRepository {
  constructor(private readonly pool: Pool) {}
  async enqueue(job: WinnerJob): Promise<WinnerJob> {
    await this.pool.query(`INSERT INTO winner_jobs(id,kind,target_id,operation_key,status,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,0,$6,$6) ON CONFLICT (operation_key) DO NOTHING`, [job.id, job.kind, job.targetId, job.operationKey, job.status, job.createdAt]);
    const q = await this.pool.query("SELECT * FROM winner_jobs WHERE operation_key=$1", [job.operationKey]);
    return mapJob(q.rows[0]);
  }
  async claimNext(now: string, staleAfterMs: number): Promise<WinnerJob | undefined> {
    const q = await this.pool.query(`WITH next AS (
        SELECT id FROM winner_jobs
        WHERE (status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
           OR (status='RUNNING' AND updated_at < $1::timestamptz - make_interval(secs => $2::double precision / 1000))
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE winner_jobs j SET status='RUNNING', attempts=j.attempts+1, updated_at=$1 FROM next WHERE j.id=next.id RETURNING j.*`, [now, staleAfterMs]);
    return q.rows[0] ? mapJob(q.rows[0]) : undefined;
  }
  async finish(id: string, outcome: Parameters<WinnerJobRepository["finish"]>[1], timestamp: string): Promise<void> {
    await this.pool.query("UPDATE winner_jobs SET status=$2,last_error=$3,next_attempt_at=$4,updated_at=$5 WHERE id=$1", [id, outcome.status, outcome.lastError?.slice(0, 500) ?? null, outcome.nextAttemptAt ?? null, timestamp]);
  }
  async list(targetId?: string): Promise<readonly WinnerJob[]> {
    const q = await this.pool.query("SELECT * FROM winner_jobs WHERE ($1::uuid IS NULL OR target_id=$1) ORDER BY created_at DESC LIMIT 200", [targetId ?? null]);
    return q.rows.map(mapJob);
  }
}

export class PostgresWinnerVideoStore implements WinnerVideoRepository {
  constructor(private readonly pool: Pool) {}
  async createBatch(b: WinnerVideoBatch): Promise<void> {
    await this.pool.query(`INSERT INTO winner_video_batches(id,creative_reference_id,product_id,requested_count,target_duration_ms,status,failure_message,provider_metadata,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [b.id, b.creativeReferenceId, b.productId, b.requestedCount, b.targetDurationMs, b.status, b.failureMessage ?? null, JSON.stringify(b.providerMetadata), b.createdBy, b.createdAt, b.updatedAt]);
  }
  async updateBatch(b: WinnerVideoBatch): Promise<void> {
    await this.pool.query("UPDATE winner_video_batches SET status=$2,failure_message=$3,provider_metadata=$4::jsonb,updated_at=$5 WHERE id=$1", [b.id, b.status, b.failureMessage?.slice(0, 500) ?? null, JSON.stringify(b.providerMetadata), b.updatedAt]);
  }
  async getBatch(id: string): Promise<WinnerVideoBatch> {
    const q = await this.pool.query("SELECT * FROM winner_video_batches WHERE id=$1", [id]);
    if (!q.rows[0]) throw new DomainError("VIDEO_BATCH_NOT_FOUND", "This set of video plans was not found.");
    return mapBatch(q.rows[0]);
  }
  async listBatches(creativeReferenceId?: string): Promise<readonly WinnerVideoBatch[]> {
    const q = await this.pool.query("SELECT * FROM winner_video_batches WHERE ($1::uuid IS NULL OR creative_reference_id=$1) ORDER BY created_at DESC", [creativeReferenceId ?? null]);
    return q.rows.map(mapBatch);
  }
  async saveVideos(videos: readonly WinnerVideo[]): Promise<void> {
    for (const v of videos) await this.pool.query(`INSERT INTO winner_videos(id,batch_id,ordinal,plan,status,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`, [v.id, v.batchId, v.ordinal, JSON.stringify(v.plan), v.status, v.createdAt, v.updatedAt]);
  }
  async updateVideo(v: WinnerVideo): Promise<void> {
    await this.pool.query("UPDATE winner_videos SET status=$2,output_asset_id=$3,duration_ms=$4,failure_message=$5,updated_at=$6,plan=$7::jsonb WHERE id=$1", [v.id, v.status, v.outputAssetId ?? null, v.durationMs ?? null, v.failureMessage?.slice(0, 500) ?? null, v.updatedAt, JSON.stringify(v.plan)]);
  }
  async remove(input: Parameters<WinnerVideoRepository["remove"]>[0]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const targets = [...input.videoIds, ...(input.batchId ? [input.batchId] : [])];
      await client.query("DELETE FROM winner_jobs WHERE target_id = ANY($1::uuid[]) AND status <> 'RUNNING'", [targets]);
      await client.query("DELETE FROM winner_videos WHERE id = ANY($1::uuid[])", [input.videoIds]);
      if (input.batchId) await client.query("DELETE FROM winner_video_batches WHERE id=$1", [input.batchId]);
      // The hourly media cleanup deletes the S3 objects once they are due.
      if (input.mediaAssetIds.length) await client.query("UPDATE media_assets SET delete_after=now(), updated_at=now() WHERE id = ANY($1::uuid[]) AND storage_provider='s3' AND lifecycle_status IN ('PENDING_UPLOAD','FAILED','AVAILABLE')", [input.mediaAssetIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getVideo(id: string): Promise<WinnerVideo> {
    const q = await this.pool.query("SELECT * FROM winner_videos WHERE id=$1", [id]);
    if (!q.rows[0]) throw new DomainError("VIDEO_NOT_FOUND", "This video was not found.");
    return mapVideo(q.rows[0]);
  }
  async listVideos(batchId?: string): Promise<readonly WinnerVideo[]> {
    const q = await this.pool.query("SELECT * FROM winner_videos WHERE ($1::uuid IS NULL OR batch_id=$1) ORDER BY created_at DESC, ordinal", [batchId ?? null]);
    return q.rows.map(mapVideo);
  }
}

export class InMemoryWinnerJobStore implements WinnerJobRepository {
  private readonly jobs = new Map<string, WinnerJob>();
  async enqueue(job: WinnerJob): Promise<WinnerJob> {
    const existing = [...this.jobs.values()].find((item) => item.operationKey === job.operationKey);
    if (existing) return structuredClone(existing);
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }
  async claimNext(now: string, staleAfterMs: number): Promise<WinnerJob | undefined> {
    const due = [...this.jobs.values()].filter((job) => (job.status === "PENDING" && (!job.nextAttemptAt || job.nextAttemptAt <= now)) || (job.status === "RUNNING" && Date.parse(job.updatedAt) < Date.parse(now) - staleAfterMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!due) return undefined;
    const claimed: WinnerJob = { ...due, status: "RUNNING", attempts: due.attempts + 1, updatedAt: now };
    this.jobs.set(due.id, claimed);
    return structuredClone(claimed);
  }
  async finish(id: string, outcome: Parameters<WinnerJobRepository["finish"]>[1], timestamp: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const { lastError: _e, nextAttemptAt: _n, ...rest } = job;
    void _e; void _n;
    this.jobs.set(id, { ...rest, status: outcome.status, ...(outcome.lastError ? { lastError: outcome.lastError } : {}), ...(outcome.nextAttemptAt ? { nextAttemptAt: outcome.nextAttemptAt } : {}), updatedAt: timestamp });
  }
  async list(targetId?: string): Promise<readonly WinnerJob[]> {
    return [...this.jobs.values()].filter((job) => !targetId || job.targetId === targetId).map((job) => structuredClone(job));
  }
}

export class InMemoryWinnerVideoStore implements WinnerVideoRepository {
  private readonly batches = new Map<string, WinnerVideoBatch>();
  private readonly videos = new Map<string, WinnerVideo>();
  async createBatch(b: WinnerVideoBatch) { this.batches.set(b.id, structuredClone(b)); }
  async updateBatch(b: WinnerVideoBatch) { this.batches.set(b.id, structuredClone(b)); }
  async getBatch(id: string) { const b = this.batches.get(id); if (!b) throw new DomainError("VIDEO_BATCH_NOT_FOUND", "This set of video plans was not found."); return structuredClone(b); }
  async listBatches(creativeReferenceId?: string) { return [...this.batches.values()].filter((b) => !creativeReferenceId || b.creativeReferenceId === creativeReferenceId).reverse().map((b) => structuredClone(b)); }
  async saveVideos(videos: readonly WinnerVideo[]) { for (const v of videos) this.videos.set(v.id, structuredClone(v)); }
  async updateVideo(v: WinnerVideo) { this.videos.set(v.id, structuredClone(v)); }
  async getVideo(id: string) { const v = this.videos.get(id); if (!v) throw new DomainError("VIDEO_NOT_FOUND", "This video was not found."); return structuredClone(v); }
  async listVideos(batchId?: string) { return [...this.videos.values()].filter((v) => !batchId || v.batchId === batchId).sort((a, b) => a.ordinal - b.ordinal).map((v) => structuredClone(v)); }
  readonly discardedMedia: string[] = [];
  async remove(input: Parameters<WinnerVideoRepository["remove"]>[0]) {
    for (const id of input.videoIds) this.videos.delete(id);
    if (input.batchId) this.batches.delete(input.batchId);
    this.discardedMedia.push(...input.mediaAssetIds);
  }
}
