import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@koolezt/domain";
import type { SeedanceTask, SeedanceTransport } from "../packages/providers/src/seedance-video.js";
import {
  buildSeedanceScenePrompt,
  HttpSeedanceTransport,
  SeedanceOutputIngestor,
  SeedanceVideoGenerationProvider,
  SEEDANCE_SCENE_PROMPT_VERSION
} from "@koolezt/providers";

class StubTransport implements SeedanceTransport {
  readonly creates: Readonly<Record<string, unknown>>[] = [];
  task: SeedanceTask = { id: "seedance-task-1", status: "queued", requestId: "seedance-request-1" };
  async createTask(body: Readonly<Record<string, unknown>>): Promise<SeedanceTask> { this.creates.push(body); return this.task; }
  async getTask(): Promise<SeedanceTask> { return this.task; }
}

const context = { operationKey: "scene:abc:attempt:1:generate", projectId: "project", targetId: "attempt" };
const input = { sceneNumber: 1, durationMs: 5_000, prompt: "Slow push-in on a generic address plaque.", sourceType: "AI_VIDEO" as const, referenceAssetIds: [] as string[], generationMode: "TEXT_TO_VIDEO" as const, accuracyRequirements: ["No readable text"] };

describe("Seedance video provider", () => {
  it("builds a versioned accuracy-preserving provider request without local paths", async () => {
    const transport = new StubTransport();
    const provider = new SeedanceVideoGenerationProvider(transport, { model: "dreamina-seedance-2-5-260628" });
    const result = await provider.submit(input, context);
    expect(SEEDANCE_SCENE_PROMPT_VERSION).toBe("koolezt-seedance-scene/v1");
    expect(transport.creates[0]).toMatchObject({ model: "dreamina-seedance-2-5-260628", duration: 5, ratio: "9:16", watermark: false, generate_audio: false, content: [{ type: "text" }] });
    expect(JSON.stringify(transport.creates[0])).not.toContain("storageKey");
    expect(result).toMatchObject({ provider: "seedance", model: "dreamina-seedance-2-5-260628", providerTaskId: "seedance-task-1" });
    expect(buildSeedanceScenePrompt({ prompt: "Reveal", accuracyRequirements: ["No readable text"], hasReferenceImage: false })).toContain("No readable text");
  });

  it("maps staged image references, task states, and trusted output", async () => {
    const transport = new StubTransport();
    const provider = new SeedanceVideoGenerationProvider(transport, { model: "dreamina-seedance-2-5-260628", resolution: "720p" });
    await provider.submit({ ...input, generationMode: "IMAGE_TO_VIDEO", referenceAssetIds: ["asset"], referenceImage: { assetId: "asset", sha256: "a".repeat(64), mimeType: "image/png", reference: { url: "https://signed.example/input.png", expiresAt: "2030-01-01T00:00:00.000Z", contentType: "image/png", size: 10 } } }, context);
    expect(transport.creates[0]).toMatchObject({ content: [{ type: "text" }, { type: "image_url", role: "reference_image", image_url: { url: "https://signed.example/input.png" } }] });
    expect(await provider.getStatus("seedance-task-1")).toEqual({ state: "PROCESSING" });
    transport.task = { id: "seedance-task-1", status: "succeeded", outputUrl: "https://cdn.volces.com/video.mp4" };
    expect(await provider.getStatus("seedance-task-1")).toMatchObject({ state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: "seedance" } });
    transport.task = { id: "seedance-task-1", status: "failed", message: "invalid content" };
    expect(await provider.getStatus("seedance-task-1")).toEqual({ state: "FAILED", message: "invalid content", retryable: false });
  });

  it("maps HTTP errors and never turns an uncertain creation response into a retry", async () => {
    const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    for (const [status, body, code] of [[401, {}, "SEEDANCE_AUTHENTICATION_FAILED"], [429, { message: "concurrency" }, "SEEDANCE_CONCURRENCY_LIMITED"], [402, {}, "SEEDANCE_QUOTA_EXCEEDED"]] as const) {
      const transport = new HttpSeedanceTransport("key", undefined, vi.fn(async () => response(status, body)) as typeof fetch);
      await expect(transport.createTask({})).rejects.toMatchObject({ code });
    }
    const fetchImpl = vi.fn(async () => { throw new Error("network lost"); }) as typeof fetch;
    await expect(new HttpSeedanceTransport("key", undefined, fetchImpl).createTask({})).rejects.toMatchObject({ code: "SEEDANCE_SUBMISSION_UNKNOWN" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses known task responses and ingests only bounded trusted output", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: "task-1", status: "processing", request_id: "req" } }), { status: 200 })) as typeof fetch;
    expect(await new HttpSeedanceTransport("key", undefined, fetchImpl).getTask("task-1")).toMatchObject({ id: "task-1", status: "processing", requestId: "req" });
    const malformed = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as typeof fetch;
    await expect(new HttpSeedanceTransport("key", undefined, malformed).getTask("task-1")).rejects.toMatchObject({ code: "SEEDANCE_STATUS_INVALID" });
    const bytes = new Uint8Array([1, 2, 3]);
    const download = vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-length": "3" } })) as typeof fetch;
    const ingestor = new SeedanceOutputIngestor(download, 4);
    expect((await ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "seedance", outputId: "video", url: "https://cdn.volces.com/video.mp4", metadata: {} })).bytes).toEqual(bytes);
    await expect(ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "seedance", outputId: "video", url: "https://attacker.example/video.mp4", metadata: {} })).rejects.toBeInstanceOf(DomainError);
    await expect(new SeedanceOutputIngestor(download, 2).ingest({ kind: "TRUSTED_REMOTE", provider: "seedance", outputId: "video", url: "https://cdn.volces.com/video.mp4", metadata: {} })).rejects.toMatchObject({ code: "SEEDANCE_OUTPUT_DOWNLOAD_FAILED" });
  });
});
