import type { Pool } from "pg";
import { DomainError } from "@koolezt/domain";

/** Reversible project removal from the operator dashboard. Published projects are intentionally protected. */
export class PostgresProjectArchiveStore {
  constructor(private readonly pool: Pool) {}
  async archive(projectId: string, actor: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ state: string; archived_at: Date | null }>("SELECT state,archived_at FROM creative_projects WHERE id=$1 FOR UPDATE", [projectId]);
      const row = project.rows[0];
      if (!row || row.archived_at) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found.");
      if (row.state === "READY") throw new DomainError("PROJECT_DELETE_PROTECTED", "Published READY projects cannot be deleted from the dashboard.");
      const pending = await client.query("SELECT 1 FROM workflow_jobs WHERE project_id=$1 AND status IN ('PENDING','RUNNING') UNION ALL SELECT 1 FROM desktop_render_jobs WHERE project_id=$1 AND state IN ('WAITING','CLAIMED','RENDERING','UPLOADING') LIMIT 1", [projectId]);
      if (pending.rowCount) throw new DomainError("PROJECT_DELETE_IN_PROGRESS", "Cancel or finish active work before deleting this project.");
      await client.query("UPDATE creative_projects SET archived_at=now(),archived_by=$2,updated_at=now() WHERE id=$1", [projectId, actor]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}