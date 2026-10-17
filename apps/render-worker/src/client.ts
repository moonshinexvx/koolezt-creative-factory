import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RenderManifest, WorkerConfig } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class RenderWorkerClient {
  constructor(private readonly config: WorkerConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  private endpoint(path: string): URL { const base = new URL(this.config.serverUrl); const target = new URL(path, base); if (target.origin !== base.origin) throw new Error("Worker manifest attempted a cross-origin request."); return target; }
  private directUrl(value: string): URL {
    const target = new URL(value);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Worker received an unsafe direct-media URL.");
    return target;
  }
  private headers(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.config.token}`, ...extra }; }
  private async json(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(this.endpoint(path), { ...init, headers: { ...this.headers({ "content-type": "application/json" }), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 204) throw new Error(`Worker API request failed with HTTP ${response.status}.`);
    return response;
  }
  async register(encoders: readonly string[], capabilities: readonly string[] = ["standard-render-v1"]): Promise<void> { await this.json("/api/render-worker/v1/register", { method: "POST", body: JSON.stringify({ workerId: this.config.workerId, workerVersion: this.config.workerVersion, protocolVersion: PROTOCOL_VERSION, encoders, capabilities }) }); }
  async claim(encoders: readonly string[], capabilities: readonly string[] = ["standard-render-v1"]): Promise<RenderManifest | undefined> {
    const response = await this.json("/api/render-worker/v1/jobs/claim", { method: "POST", body: JSON.stringify({ workerId: this.config.workerId, workerVersion: this.config.workerVersion, protocolVersion: PROTOCOL_VERSION, encoders, capabilities }) });
    if (response.status === 204) return undefined;
    const manifest = await response.json() as RenderManifest;
    if (manifest.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Incompatible worker protocol ${manifest.protocolVersion}.`);
    return manifest;
  }
  async renew(job: RenderManifest): Promise<void> { await this.json(`/api/render-worker/v1/jobs/${job.jobId}/renew`, { method: "POST", body: JSON.stringify({ workerId: this.config.workerId, leaseToken: job.leaseToken }) }); }
  async progress(job: RenderManifest, stage: string, percent?: number, encoder?: string): Promise<void> { await this.json(`/api/render-worker/v1/jobs/${job.jobId}/progress`, { method: "POST", body: JSON.stringify({ workerId: this.config.workerId, leaseToken: job.leaseToken, stage, ...(percent !== undefined ? { percent } : {}), ...(encoder ? { encoder } : {}) }) }); }
  async download(job: RenderManifest, asset: Readonly<{ assetId?: string; downloadPath: string; downloadUrl?: string; sha256: string }>, destination: string): Promise<void> {
    try { const existing = await readFile(destination); if (sha256(existing) === asset.sha256) return; } catch { /* cache miss */ }
    const leaseHeaders = this.headers({ "x-render-worker-id": this.config.workerId, "x-render-lease-token": job.leaseToken });
    let response = await this.fetchImpl(asset.downloadUrl ? this.directUrl(asset.downloadUrl) : this.endpoint(asset.downloadPath), {
      ...(asset.downloadUrl ? {} : { headers: leaseHeaders }),
      signal: AbortSignal.timeout(120_000),
      redirect: "error"
    });
    if (asset.downloadUrl && (response.status === 401 || response.status === 403) && asset.assetId) {
      const refresh = await this.json(`/api/render-worker/v1/jobs/${job.jobId}/assets/${asset.assetId}/reference`, { method: "GET", headers: leaseHeaders });
      const renewed = await refresh.json() as { url: string };
      response = await this.fetchImpl(this.directUrl(renewed.url), { signal: AbortSignal.timeout(120_000), redirect: "error" });
    }
    if (!response.ok) throw new Error(`Asset download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer()); if (sha256(bytes) !== asset.sha256) throw new Error("Downloaded asset checksum mismatch.");
    await mkdir(dirname(destination), { recursive: true }); const temporary = `${destination}.tmp`; await writeFile(temporary, bytes); await rename(temporary, destination);
  }
  async upload(job: RenderManifest, outputPath: string): Promise<string> {
    const bytes = await readFile(outputPath);
    const checksum = sha256(bytes);
    const authorizationBody = JSON.stringify({ workerId: this.config.workerId, leaseToken: job.leaseToken, sha256: checksum, byteSize: bytes.byteLength });
    let authorization = await this.fetchImpl(this.endpoint(`/api/render-worker/v1/jobs/${job.jobId}/output/authorize`), {
      method: "POST", headers: this.headers({ "content-type": "application/json" }), body: authorizationBody, signal: AbortSignal.timeout(30_000)
    });
    if (authorization.status === 404) {
      const form = new FormData(); form.append("workerId", this.config.workerId); form.append("leaseToken", job.leaseToken); form.append("sha256", checksum); form.append("file", new Blob([bytes], { type: "video/mp4" }), "render.mp4");
      const legacy = await this.fetchImpl(this.endpoint(`/api/render-worker/v1/jobs/${job.jobId}/output`), { method: "POST", headers: this.headers(), body: form, signal: AbortSignal.timeout(180_000), redirect: "error" });
      if (!legacy.ok) throw new Error(`Render upload failed with HTTP ${legacy.status}.`);
      return checksum;
    }
    if (!authorization.ok) throw new Error(`Render upload authorization failed with HTTP ${authorization.status}.`);
    let target = await authorization.json() as { assetId?: string; url?: string; headers?: Record<string, string>; reused?: boolean; uploaded?: boolean };
    if (target.reused) return checksum;
    if (!target.assetId) throw new Error("Render upload authorization returned an invalid target.");
    let upload = target.uploaded ? new Response(null, { status: 200 }) : await this.fetchImpl(this.directUrl(target.url!), { method: "PUT", ...(target.headers ? { headers: target.headers } : {}), body: bytes, signal: AbortSignal.timeout(180_000), redirect: "error" });
    if (upload.status === 401 || upload.status === 403) {
      authorization = await this.fetchImpl(this.endpoint(`/api/render-worker/v1/jobs/${job.jobId}/output/authorize`), {
        method: "POST", headers: this.headers({ "content-type": "application/json" }), body: authorizationBody, signal: AbortSignal.timeout(30_000)
      });
      if (!authorization.ok) throw new Error(`Render upload authorization refresh failed with HTTP ${authorization.status}.`);
      target = await authorization.json() as { assetId: string; url: string; headers?: Record<string, string> };
      if (!target.assetId || !target.url) throw new Error("Render upload authorization refresh returned an invalid target.");
      upload = await this.fetchImpl(this.directUrl(target.url), { method: "PUT", ...(target.headers ? { headers: target.headers } : {}), body: bytes, signal: AbortSignal.timeout(180_000), redirect: "error" });
    }
    if (!upload.ok) throw new Error(`Direct render upload failed with HTTP ${upload.status}.`);
    const completion = await this.json(`/api/render-worker/v1/jobs/${job.jobId}/output/complete`, {
      method: "POST", body: JSON.stringify({ workerId: this.config.workerId, leaseToken: job.leaseToken, assetId: target.assetId })
    });
    if (!completion.ok) throw new Error(`Render completion failed with HTTP ${completion.status}.`);
    return checksum;
  }
  async fail(job: RenderManifest, code: string, message: string): Promise<void> { await this.json(`/api/render-worker/v1/jobs/${job.jobId}/fail`, { method: "POST", body: JSON.stringify({ workerId: this.config.workerId, leaseToken: job.leaseToken, code, message: message.slice(0, 500) }) }); }
  cachePath(checksum: string) { return join(this.config.dataRoot, "cache", checksum); }
  jobPath(jobId: string) { return join(this.config.dataRoot, "jobs", jobId); }
  async cacheSize(path: string): Promise<number> { return (await stat(path)).size; }
  async pruneCache(): Promise<void> {
    const directory = join(this.config.dataRoot, "cache"); let names: string[];
    try { names = await readdir(directory); } catch { return; }
    const entries = await Promise.all(names.filter((name) => /^[a-f0-9]{64}$/.test(name)).map(async (name) => { const path = join(directory, name); const info = await stat(path); return { path, size: info.size, modified: info.mtimeMs }; }));
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    for (const item of entries.sort((left, right) => left.modified - right.modified)) { if (total <= this.config.cacheMaxBytes) break; await unlink(item.path); total -= item.size; }
  }
}
