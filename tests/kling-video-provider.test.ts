import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@koolezt/domain";
import type { KlingTask, KlingTransport } from "../packages/providers/src/kling-video.js";
import {
  buildKlingScenePrompt,
  HttpKlingTransport,
  KlingOutputIngestor,
  KlingVideoGenerationProvider,
  KLING_SCENE_PROMPT_VERSION
} from "@koolezt/providers";

class StubTransport implements KlingTransport {
  readonly creates: Array<{ path: string; body: Readonly<Record<string, unknown>> }> = [];
  task: KlingTask = { id: "task-1", status: "submitted", requestId: "request-1" };
  async createTask(path: string, body: Readonly<Record<string, unknown>>): Promise<KlingTask> { this.creates.push({ path, body }); return this.task; }
  async getTask(): Promise<KlingTask> { return this.task; }
}

const context = { operationKey: "scene:abc:attempt:1:generate", projectId: "project", targetId: "attempt" };
const baseInput = { sceneNumber: 1, durationMs: 5_000, prompt: "Slow push-in on the personalized sign.", sourceType: "AI_VIDEO" as const, referenceAssetIds: [] as string[], generationMode: "TEXT_TO_VIDEO" as const, accuracyRequirements: ["Keep the supplied house number unchanged"] };

describe("Kling video provider", () => {
  it("builds a versioned accuracy-preserving prompt", () => {
    expect(KLING_SCENE_PROMPT_VERSION).toBe("koolezt-kling-scene/v1");
    const prompt = buildKlingScenePrompt({ prompt: "Product reveal", accuracyRequirements: ["Keep the name Mia"], hasReferenceImage: true });
    expect(prompt).toContain("Product reveal"); expect(prompt).toContain("Keep the name Mia"); expect(prompt).toContain("exact visible design");
  });

  it("constructs current model-routed text-to-video requests with vertical settings", async () => {
    const transport = new StubTransport(); const provider = new KlingVideoGenerationProvider(transport, { model: "kling-3.0-turbo" });
    const result = await provider.submit(baseInput, context);
    expect(transport.creates[0]?.path).toBe("/text-to-video/kling-3.0-turbo");
    expect(transport.creates[0]?.body).toMatchObject({ settings: { resolution: "720p", aspect_ratio: "9:16", duration: 5 }, options: { watermark_info: { enabled: false } } });
    expect(JSON.stringify(transport.creates[0]?.body)).not.toContain("storageKey");
    expect(result).toMatchObject({ provider: "kling", model: "kling-3.0-turbo", providerTaskId: "task-1" });
  });

  it("constructs image-to-video requests from staged references only", async () => {
    const transport = new StubTransport(); const provider = new KlingVideoGenerationProvider(transport, { model: "kling-3.0-turbo", resolution: "1080p" });
    await provider.submit({ ...baseInput, generationMode: "IMAGE_TO_VIDEO", referenceAssetIds: ["asset"], referenceImage: { assetId: "asset", sha256: "a".repeat(64), mimeType: "image/png", reference: { url: "https://signed.example/input", expiresAt: "2030-01-01T00:00:00Z", contentType: "image/png", size: 10 } } }, context);
    expect(transport.creates[0]?.path).toBe("/image-to-video/kling-3.0-turbo");
    expect(transport.creates[0]?.body).toMatchObject({ contents: [{ type: "image", url: "https://signed.example/input" }, { type: "text" }], settings: { resolution: "1080p", duration: 5 } });
  });

  it("maps processing, success with billing, and failure states", async () => {
    const transport = new StubTransport(); const provider = new KlingVideoGenerationProvider(transport, { model: "kling-3.0-turbo" });
    transport.task = { id: "task-1", status: "processing" }; expect(await provider.getStatus("task-1")).toEqual({ state: "PROCESSING" });
    transport.task = { id: "task-1", status: "succeeded", outputs: [{ type: "video", id: "video-1", url: "https://cdn.klingai.com/video.mp4", duration: "5" }], billing: [{ amount: "1", charge_type: "unit" }] };
    expect(await provider.getStatus("task-1")).toMatchObject({ state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: "kling", outputId: "video-1" } });
    transport.task = { id: "task-1", status: "failed", message: "content rejected" }; expect(await provider.getStatus("task-1")).toEqual({ state: "FAILED", message: "content rejected", retryable: false });
  });

  it("maps authentication, rate, quota and ambiguous submission failures", async () => {
    const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    for (const [status, body, code] of [[401, {}, "KLING_AUTHENTICATION_FAILED"], [429, { message: "concurrency" }, "KLING_CONCURRENCY_LIMITED"], [402, {}, "KLING_QUOTA_EXCEEDED"]] as const) {
      const transport = new HttpKlingTransport("key", undefined, vi.fn(async () => response(status, body)) as typeof fetch);
      await expect(transport.createTask("/text-to-video/kling-3.0-turbo", {})).rejects.toMatchObject({ code });
    }
    const transport = new HttpKlingTransport("key", undefined, vi.fn(async () => { throw new Error("lost response"); }) as typeof fetch);
    await expect(transport.createTask("/text-to-video/kling-3.0-turbo", {})).rejects.toMatchObject({ code: "KLING_SUBMISSION_UNKNOWN" });
  });

  it("parses the current /tasks response and rejects malformed states", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0, request_id: "req", data: [{ id: "task-1", status: "processing" }] }), { status: 200 })) as typeof fetch;
    expect(await new HttpKlingTransport("key", undefined, fetchImpl).getTask("task-1")).toMatchObject({ id: "task-1", status: "processing", requestId: "req" });
    const malformed = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })) as typeof fetch;
    await expect(new HttpKlingTransport("key", undefined, malformed).getTask("task-1")).rejects.toMatchObject({ code: "KLING_STATUS_INVALID" });
  });

  it("ingests only bounded trusted Kling HTTPS output", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-length": "3" } })) as typeof fetch;
    const ingestor = new KlingOutputIngestor(fetchImpl, 4);
    const result = await ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "kling", outputId: "video", url: "https://p2-kling.klingai.com/video.mp4", metadata: {} });
    expect(result.bytes).toEqual(bytes); expect(result.metadata).toMatchObject({ provider: "kling", outputId: "video" });
    await expect(ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "kling", outputId: "video", url: "https://attacker.example/video.mp4", metadata: {} })).rejects.toBeInstanceOf(DomainError);
    await expect(new KlingOutputIngestor(fetchImpl, 2).ingest({ kind: "TRUSTED_REMOTE", provider: "kling", outputId: "video", url: "https://klingai.com/video.mp4", metadata: {} })).rejects.toMatchObject({ code: "KLING_OUTPUT_DOWNLOAD_FAILED" });
  });
});
