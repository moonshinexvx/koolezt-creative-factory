import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "@koolezt/domain";
import type { Pool, QueryResultRow } from "pg";

export type RenderWorkerIdentity = Readonly<{ id: string; displayName: string; machineName?: string; workerVersion: string; protocolVersion: string; encoders: readonly string[]; capabilities: readonly string[]; runtimeState: "OFFLINE" | "IDLE" | "BUSY"; lastSeenAt?: string; revokedAt?: string; createdAt: string }>;
export type RenderWorkerEnrollment = Readonly<{ setupCode: string; displayName: string; expiresAt: string }>;
export type RenderWorkerEnrollmentResult = Readonly<{ worker: RenderWorkerIdentity; token: string }>;
export interface RenderWorkerIdentityStore {
  createEnrollment(displayName: string, createdBy: string, ttlMs?: number): Promise<RenderWorkerEnrollment>;
  enroll(input: Readonly<{ setupCode: string; machineName?: string; workerVersion: string; protocolVersion: string }>): Promise<RenderWorkerEnrollmentResult>;
  authenticate(token: string, workerId?: string): Promise<RenderWorkerIdentity | undefined>;
  heartbeat(workerId: string, input: Readonly<{ workerVersion: string; protocolVersion: string; encoders: readonly string[]; capabilities: readonly string[]; runtimeState?: "IDLE" | "BUSY" }>): Promise<RenderWorkerIdentity>;
  list(): Promise<readonly RenderWorkerIdentity[]>;
  revoke(workerId: string): Promise<void>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const safeMachine = (value?: string) => value?.trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 120) || undefined;
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function setupCode(): string { const bytes = randomBytes(8); const raw = Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]).join(""); return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`; }
function map(row: QueryResultRow): RenderWorkerIdentity { return { id: String(row.id), displayName: String(row.display_name), ...(row.machine_name ? { machineName: String(row.machine_name) } : {}), workerVersion: String(row.worker_version), protocolVersion: String(row.protocol_version), encoders: (typeof row.encoders === "string" ? JSON.parse(row.encoders) : row.encoders ?? []) as string[], capabilities: (typeof row.capabilities === "string" ? JSON.parse(row.capabilities) : row.capabilities ?? ["standard-render-v1"]) as string[], runtimeState: row.runtime_state as RenderWorkerIdentity["runtimeState"], ...(row.last_seen_at ? { lastSeenAt: new Date(row.last_seen_at as string).toISOString() } : {}), ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at as string).toISOString() } : {}), createdAt: new Date(row.created_at as string).toISOString() }; }

export class PostgresRenderWorkerIdentityStore implements RenderWorkerIdentityStore {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}
  async createEnrollment(displayName: string, createdBy: string, ttlMs = 30 * 60_000): Promise<RenderWorkerEnrollment> {
    const code = setupCode(); const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    await this.pool.query("INSERT INTO render_worker_enrollments (id,code_hash,display_name,expires_at,created_by) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), hash(normalizeCode(code)), displayName.trim().slice(0, 120), expiresAt, createdBy.slice(0, 160)]);
    return { setupCode: code, displayName: displayName.trim().slice(0, 120), expiresAt };
  }
  async enroll(input: Readonly<{ setupCode: string; machineName?: string; workerVersion: string; protocolVersion: string }>): Promise<RenderWorkerEnrollmentResult> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const record = await client.query("SELECT * FROM render_worker_enrollments WHERE code_hash=$1 FOR UPDATE", [hash(normalizeCode(input.setupCode))]); const enrollment = record.rows[0];
      if (!enrollment || enrollment.used_at || new Date(enrollment.expires_at as string).getTime() <= this.now().getTime()) throw new DomainError("WORKER_ENROLLMENT_INVALID", "Setup code is invalid, expired, or already used.");
      const token = randomBytes(32).toString("base64url"); const workerId = randomUUID();
      const inserted = await client.query("INSERT INTO render_workers (id,display_name,token_hash,machine_name,worker_version,protocol_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [workerId, enrollment.display_name, hash(token), safeMachine(input.machineName) ?? null, input.workerVersion, input.protocolVersion]);
      await client.query("UPDATE render_worker_enrollments SET used_at=now() WHERE id=$1", [enrollment.id]); await client.query("COMMIT"); return { worker: map(inserted.rows[0]!), token };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async authenticate(token: string, workerId?: string): Promise<RenderWorkerIdentity | undefined> { if (!token) return undefined; const result = await this.pool.query("SELECT * FROM render_workers WHERE token_hash=$1 AND revoked_at IS NULL", [hash(token)]); const worker = result.rows[0] ? map(result.rows[0]) : undefined; return worker && (!workerId || worker.id === workerId) ? worker : undefined; }
  async heartbeat(workerId: string, input: Readonly<{ workerVersion: string; protocolVersion: string; encoders: readonly string[]; capabilities: readonly string[]; runtimeState?: "IDLE" | "BUSY" }>): Promise<RenderWorkerIdentity> { const result = await this.pool.query("UPDATE render_workers SET worker_version=$2,protocol_version=$3,encoders=$4::jsonb,capabilities=$5::jsonb,runtime_state=$6,last_seen_at=now(),updated_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING *", [workerId,input.workerVersion,input.protocolVersion,JSON.stringify(input.encoders),JSON.stringify(input.capabilities),input.runtimeState ?? "IDLE"]); if(!result.rows[0]) throw new DomainError("WORKER_AUTHENTICATION_FAILED","Render Worker is not authorized."); return map(result.rows[0]); }
  async list(): Promise<readonly RenderWorkerIdentity[]> { const result = await this.pool.query("SELECT * FROM render_workers ORDER BY created_at DESC"); return result.rows.map((row) => { const worker=map(row); const online=worker.lastSeenAt && this.now().getTime()-new Date(worker.lastSeenAt).getTime()<30_000 && !worker.revokedAt; return {...worker,runtimeState:worker.revokedAt||!online?"OFFLINE":worker.runtimeState}; }); }
  async revoke(workerId: string): Promise<void> { const result=await this.pool.query("UPDATE render_workers SET revoked_at=COALESCE(revoked_at,now()),runtime_state='OFFLINE',updated_at=now() WHERE id=$1",[workerId]); if(!(result.rowCount??0)) throw new DomainError("RENDER_WORKER_NOT_FOUND","Render Worker was not found."); }
}

export class InMemoryRenderWorkerIdentityStore implements RenderWorkerIdentityStore {
  private enrollments=new Map<string,{displayName:string;expiresAt:string;used:boolean;createdBy:string}>(); private workers=new Map<string,RenderWorkerIdentity & {tokenHash:string}>();
  constructor(private readonly now:()=>Date=()=>new Date()){}
  async createEnrollment(displayName:string,createdBy:string,ttlMs=30*60_000){const code=setupCode();const value={displayName:displayName.trim(),expiresAt:new Date(this.now().getTime()+ttlMs).toISOString(),used:false,createdBy};this.enrollments.set(hash(normalizeCode(code)),value);return{setupCode:code,displayName:value.displayName,expiresAt:value.expiresAt};}
  async enroll(input:Readonly<{setupCode:string;machineName?:string;workerVersion:string;protocolVersion:string}>){const record=this.enrollments.get(hash(normalizeCode(input.setupCode)));if(!record||record.used||new Date(record.expiresAt).getTime()<=this.now().getTime())throw new DomainError("WORKER_ENROLLMENT_INVALID","Setup code is invalid, expired, or already used.");record.used=true;const token=randomBytes(32).toString("base64url");const id=randomUUID();const machineName=safeMachine(input.machineName);const worker={id,displayName:record.displayName,...(machineName?{machineName}:{}),workerVersion:input.workerVersion,protocolVersion:input.protocolVersion,encoders:[],capabilities:["standard-render-v1"],runtimeState:"OFFLINE" as const,createdAt:this.now().toISOString(),tokenHash:hash(token)};this.workers.set(id,worker);return{worker,token};}
  async authenticate(token:string,workerId?:string){const worker=[...this.workers.values()].find((value)=>value.tokenHash===hash(token)&&!value.revokedAt);return worker&&(!workerId||worker.id===workerId)?worker:undefined;}
  async heartbeat(workerId:string,input:Readonly<{workerVersion:string;protocolVersion:string;encoders:readonly string[];capabilities:readonly string[];runtimeState?:"IDLE"|"BUSY"}>){const old=this.workers.get(workerId);if(!old||old.revokedAt)throw new DomainError("WORKER_AUTHENTICATION_FAILED","Render Worker is not authorized.");const worker={...old,workerVersion:input.workerVersion,protocolVersion:input.protocolVersion,encoders:input.encoders,capabilities:input.capabilities,runtimeState:input.runtimeState??"IDLE",lastSeenAt:this.now().toISOString()};this.workers.set(workerId,worker);return worker;}
  async list(){return [...this.workers.values()].map((value)=>{const {tokenHash,...worker}=value;void tokenHash;return {...worker,runtimeState:worker.revokedAt||!worker.lastSeenAt||this.now().getTime()-new Date(worker.lastSeenAt).getTime()>=30_000?"OFFLINE":worker.runtimeState};});}
  async revoke(workerId:string){const old=this.workers.get(workerId);if(!old)throw new DomainError("RENDER_WORKER_NOT_FOUND","Render Worker was not found.");this.workers.set(workerId,{...old,revokedAt:this.now().toISOString(),runtimeState:"OFFLINE"});}
}