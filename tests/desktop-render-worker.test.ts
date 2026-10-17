import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderWorkerClient } from "../apps/render-worker/src/client.js";
import { buildFfmpegArguments, detectEncoder } from "../apps/render-worker/src/renderer.js";
import type { RenderManifest } from "../apps/render-worker/src/types.js";
import { DesktopCompositionProvider } from "@koolezt/infrastructure";
import { buildServer } from "../apps/api/src/server.js";

const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifest: RenderManifest = {
  protocolVersion: "render-worker/v1", jobId: "job-1", projectId: "project-1", projectPublicId: "CF-TEST", renderAttemptId: "render-1", leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  scenes: [0, 1, 2].map((position) => ({ position, assetId: `scene-${position}`, sha256: "a".repeat(64), durationMs: 5334, sourceDurationMs: 5000, downloadPath: `/scene-${position}` })),
  narration: { assetId: "voice", sha256: "b".repeat(64), downloadPath: "/voice", durationMs: 13_600, leadInMs: 400, atempo: 1 }, overlays: [{ text: "SAFE OVERLAY", sceneIndex: 0 }], cta: "CREATE YOURS",
  timeline: { transition: "SOFT_DISSOLVE", transitionDurationMs: 500, sourceAudio: false }, output: { width: 1080, height: 1920, fps: 30, durationMs: 15_000, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" }
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("desktop render worker", () => {
  it("builds a safe vertical blurred-background timeline with muted source audio", () => {
    const args = buildFfmpegArguments(manifest, ["one.mp4", "two.mp4", "three.mp4"], "voice.mp3", "output.mp4", "libx264", ["overlay.txt"], "cta.txt");
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).toContain("gblur=sigma=30");
    expect(filters).toContain("setpts=PTS/0.9374");
    expect(filters).toContain("xfade=transition=fade:duration=0.5");
    expect(filters).toContain("[3:a]");
    expect(filters).toContain("adelay=400|400");
expect(filters).toContain("fontfile=");
    expect(filters).toContain("boxborderw=24:x=132+");
    expect(filters).toContain("textfile=");
    expect(filters).not.toContain("[0:a]");
    expect(filters).not.toContain("SAFE OVERLAY");
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
  });

  it("checks hardware encoders in priority order and falls back to libx264", async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (_path: string, args: readonly string[]) => { calls.push(String(args[args.indexOf("-c:v") + 1])); if (calls.at(-1) !== "libx264") throw new Error("unavailable"); });
    await expect(detectEncoder("ffmpeg", undefined, runner)).resolves.toBe("libx264");
    expect(calls).toEqual(["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
  });

  it("downloads only server-manifest assets and verifies checksums before atomic cache reuse", async () => {
    const root = join(tmpdir(), `render-worker-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const bytes = new TextEncoder().encode("fixture-media"); const checksum = sha(bytes); let capturedHeaders: unknown; const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => { capturedHeaders = init?.headers; return new Response(bytes); });
    const client = new RenderWorkerClient({ serverUrl: "http://127.0.0.1:3100", workerId: "worker", workerVersion: "1", token: "secret", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dataRoot: root, cacheMaxBytes: 1024 }, fetchMock as typeof fetch);
    const destination = join(root, "cache", checksum); await client.download(manifest, { downloadPath: "/asset", sha256: checksum }, destination); await client.download(manifest, { downloadPath: "/asset", sha256: checksum }, destination);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(new Uint8Array(await readFile(destination))).toEqual(bytes);
    expect((capturedHeaders as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("queues a durable desktop job and resumes the same provider task without staging", async () => {
    const job = { id: "job-1", projectId: "project", renderId: "render", operationKey: "compose:1", protocolVersion: "render-worker/v1", state: "WAITING" as const, inputSnapshot: {} as never, createdAt: "now", updatedAt: "now" };
    const store = { ensure: vi.fn(async () => job), get: vi.fn(async () => job) };
    const provider = new DesktopCompositionProvider(store as never, {} as never);
    expect(provider.requiresExternalMedia).toBe(false);
    const result = await provider.submit({ snapshot: {} as never, sceneAssets: [], narration: {} as never, captionTimings: [], marketingOverlays: [], cta: "CTA", compositionStyleKey: "style", target: { width: 1080, height: 1920, durationMs: 15000 } }, { projectId: "project", targetId: "render", operationKey: "compose:1" });
    expect(result.providerTaskId).toBe("job-1"); expect(store.ensure).toHaveBeenCalledTimes(1); expect((await provider.getStatus("job-1")).state).toBe("PROCESSING");
  });

  it("requires the dedicated worker bearer token and scopes asset access to the claimed manifest", async () => {
    const claim = vi.fn(async () => undefined);
    const authorize = vi.fn(async () => ({ inputSnapshot: { sceneInputs: [{ assetId: "allowed" }], narration: { assetId: "voice" } } }));
    const app = buildServer({ renderWorkerToken: "worker-secret", renderWorkerLeaseMs: 300_000, desktopRenderJobs: { claim, authorize } } as never);
    const identity = { workerId: "windows-test", workerVersion: "1.0.0", protocolVersion: "render-worker/v1", encoders: ["libx264"] };
    expect((await app.inject({ method: "POST", url: "/api/render-worker/v1/register", payload: identity })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/render-worker/v1/register", headers: { authorization: "Bearer worker-secret" }, payload: identity })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/render-worker/v1/jobs/claim", headers: { authorization: "Bearer worker-secret" }, payload: identity })).statusCode).toBe(204);
    const forbidden = await app.inject({ method: "GET", url: "/api/render-worker/v1/jobs/job/assets/not-allowed", headers: { authorization: "Bearer worker-secret", "x-render-worker-id": "windows-test", "x-render-lease-token": "lease" } });
    expect(forbidden.statusCode).toBe(403); expect(claim).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("downloads directly from an exact signed S3 reference without sending the worker bearer token", async () => {
    const root = join(tmpdir(), `render-worker-s3-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const bytes = new TextEncoder().encode("signed media"); const checksum = sha(bytes);
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://private-bucket.s3.amazonaws.com/exact?signature=redacted");
      expect(init?.headers).toBeUndefined();
      return new Response(bytes);
    });
    const client = new RenderWorkerClient({ serverUrl: "http://127.0.0.1:3100", workerId: "worker", workerVersion: "1.0.1", token: "worker-secret", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dataRoot: root, cacheMaxBytes: 1024 }, fetchMock as typeof fetch);
    await client.download(manifest, { assetId: "scene-0", downloadPath: "/legacy", downloadUrl: "https://private-bucket.s3.amazonaws.com/exact?signature=redacted", sha256: checksum }, join(root, "cache", checksum));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uploads a final directly to the authorized S3 object and reports only its asset identity", async () => {
    const root = join(tmpdir(), `render-worker-upload-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const output = join(root, "render.mp4"); const bytes = Buffer.from("render output"); await import("node:fs/promises").then(({ writeFile }) => writeFile(output, bytes));
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("/output/authorize")) return Response.json({ assetId: "final-asset", url: "https://private-bucket.s3.amazonaws.com/final?signature=redacted", headers: { "x-amz-meta-sha256": sha(bytes) } });
      if (url.includes("private-bucket")) { expect(init?.headers).not.toHaveProperty("authorization"); return new Response(null, { status: 200 }); }
      if (url.endsWith("/output/complete")) { expect(String(init?.body)).toContain('"assetId":"final-asset"'); return Response.json({ ok: true }); }
      throw new Error("unexpected request");
    });
    const client = new RenderWorkerClient({ serverUrl: "http://127.0.0.1:3100", workerId: "worker", workerVersion: "1.0.1", token: "worker-secret", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dataRoot: root, cacheMaxBytes: 1024 }, fetchMock as typeof fetch);
    await expect(client.upload(manifest, output)).resolves.toBe(sha(bytes));
    expect(requests).toHaveLength(3);
  });
  it("resumes completion without a second PUT after an earlier direct upload succeeded", async () => {
    const root = join(tmpdir(), `render-worker-resume-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const output = join(root, "render.mp4"); const bytes = Buffer.from("already uploaded"); await import("node:fs/promises").then(({ writeFile }) => writeFile(output, bytes));
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/output/authorize")) return Response.json({ assetId: "existing-final", uploaded: true });
      if (url.endsWith("/output/complete")) return Response.json({ state: "SUCCEEDED" });
      throw new Error("a second S3 PUT must not occur");
    });
    const client = new RenderWorkerClient({ serverUrl: "http://127.0.0.1:3100", workerId: "worker", workerVersion: "1.0.2", token: "worker-secret", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dataRoot: root, cacheMaxBytes: 1024 }, fetchMock as typeof fetch);
    await client.upload(manifest, output);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("refreshes an expired exact-object GET without rerendering or leaking the worker token to S3", async () => {
    const root = join(tmpdir(), `render-worker-refresh-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const bytes = new TextEncoder().encode("refreshed media"); const checksum = sha(bytes); let call = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) { expect(init?.headers).toBeUndefined(); return new Response(null, { status: 403 }); }
      if (call === 2) { expect((init?.headers as Record<string, string>).authorization).toBe("Bearer worker-secret"); return Response.json({ url: "https://private-bucket.s3.amazonaws.com/refreshed?signature=redacted" }); }
      expect(String(input)).toContain("refreshed"); expect(init?.headers).toBeUndefined(); return new Response(bytes);
    });
    const client = new RenderWorkerClient({ serverUrl: "http://127.0.0.1:3100", workerId: "worker", workerVersion: "1.0.2", token: "worker-secret", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dataRoot: root, cacheMaxBytes: 1024 }, fetchMock as typeof fetch);
    await client.download(manifest, { assetId: "scene-0", downloadPath: "/legacy", downloadUrl: "https://private-bucket.s3.amazonaws.com/expired?signature=redacted", sha256: checksum }, join(root, "cache", checksum));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });});
