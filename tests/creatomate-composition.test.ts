import { describe, expect, it } from "vitest";
import type { CompositionMediaInput, DomainError, RenderInputSnapshot } from "@koolezt/domain";
import {
  CreatomateCompositionProvider,
  CreatomateOutputIngestor,
  HttpCreatomateTransport,
  buildKooleztUgcFastRenderScript,
  KOOLEZT_UGC_FAST_TEMPLATE_VERSION
} from "@koolezt/providers";

const snapshot: RenderInputSnapshot = {
  templateVersion: KOOLEZT_UGC_FAST_TEMPLATE_VERSION,
  sceneInputs: [
    { attemptId: "scene-1", assetId: "asset-1", sha256: "a".repeat(64), intendedDurationMs: 4_000 },
    { attemptId: "scene-2", assetId: "asset-2", sha256: "b".repeat(64), intendedDurationMs: 5_000 },
    { attemptId: "scene-3", assetId: "asset-3", sha256: "c".repeat(64), intendedDurationMs: 6_000 }
  ],
  narration: { voiceGenerationId: "voice-1", assetId: "voice-asset", sha256: "d".repeat(64), captionTimings: [{ text: "Create", startMs: 0, endMs: 400 }, { text: "yours", startMs: 400, endMs: 900 }] },
  marketingOverlays: ["FIRST", "SECOND", "THIRD"], cta: "Create yours →", target: { width: 1080, height: 1920, durationMs: 15_000 }
};
function media(assetId: string, mimeType: string): CompositionMediaInput {
  return { assetId, sha256: "e".repeat(64), mimeType, reference: { url: `https://staging.example.test/${assetId}`, expiresAt: "2026-08-30T00:00:00.000Z", contentType: mimeType, size: 100 } };
}

describe("Creatomate RenderScript adapter", () => {
  it("builds a controlled vertical script with media, captions, overlays, and CTA", () => {
    const script = buildKooleztUgcFastRenderScript({ snapshot, scenes: [media("asset-1", "video/mp4"), media("asset-2", "image/png"), media("asset-3", "video/mp4")], narration: media("voice-asset", "audio/mpeg"), music: media("music", "audio/mpeg") });
    expect(script.output_format).toBe("mp4"); expect(script.width).toBe(1080); expect(script.height).toBe(1920);
    const elements = script.elements as Array<Record<string, unknown>>;
    expect(elements.filter((item) => String(item.name).startsWith("Scene-")).map((item) => [item.type, item.time, item.duration])).toEqual([["video", 0, 4], ["image", 4, 5], ["video", 9, 6]]);
    expect(elements.find((item) => item.name === "Narration")?.source).toBe("https://staging.example.test/voice-asset");
    expect(elements.find((item) => item.name === "Narration-Captions")?.transcript_source).toEqual([{ time: 0, duration: 0.4, value: "Create" }, { time: 0.4, duration: 0.5, value: "yours" }]);
    expect(JSON.stringify(script)).not.toContain("projects/");
  });

  it("submits once and maps documented Creatomate statuses without network access", async () => {
    const created: unknown[] = [];
    const provider = new CreatomateCompositionProvider({
      async createRender(script) { created.push(script); return { id: "render-1", status: "planned" }; },
      async getRender() { return { id: "render-1", status: "succeeded", url: "https://cdn.creatomate.com/renders/render-1.mp4", output_format: "mp4" }; }
    });
    const input = { snapshot, sceneAssets: [media("asset-1", "video/mp4"), media("asset-2", "image/png"), media("asset-3", "video/mp4")], narration: media("voice-asset", "audio/mpeg"), captionTimings: snapshot.narration.captionTimings, marketingOverlays: snapshot.marketingOverlays, cta: snapshot.cta, compositionStyleKey: "UGC_FAST/v1", target: snapshot.target };
    const submission = await provider.submit(input, { projectId: "project", targetId: "render", operationKey: "render:project:attempt:1:compose" });
    expect(submission.provider).toBe("creatomate"); expect(created).toHaveLength(1);
    await expect(provider.getStatus(submission.providerTaskId)).resolves.toMatchObject({ state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: "creatomate" } });
  });

  it("maps processing, provider failure, and authentication failures to stable outcomes", async () => {
    const processing = new CreatomateCompositionProvider({ async createRender() { return { id: "r", status: "planned" }; }, async getRender() { return { id: "r", status: "rendering" }; } });
    await expect(processing.getStatus("r")).resolves.toEqual({ state: "PROCESSING" });
    const failed = new CreatomateCompositionProvider({ async createRender() { return { id: "r", status: "planned" }; }, async getRender() { return { id: "r", status: "failed", error_message: "bad input" }; } });
    await expect(failed.getStatus("r")).resolves.toEqual({ state: "FAILED", message: "bad input", retryable: false });
    const transport = new HttpCreatomateTransport("not-a-secret", async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await expect(transport.getRender("r")).rejects.toMatchObject({ code: "CREATOMATE_AUTHENTICATION_FAILED" });
  });

  it("only ingests a trusted Creatomate HTTPS output and enforces size", async () => {
    const ingestor = new CreatomateOutputIngestor(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }));
    await expect(ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "creatomate", outputId: "r", url: "https://cdn.creatomate.com/renders/r.mp4", metadata: {} })).resolves.toMatchObject({ mimeType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) });
    await expect(ingestor.ingest({ kind: "TRUSTED_REMOTE", provider: "creatomate", outputId: "r", url: "https://not-trusted.example/r.mp4", metadata: {} })).rejects.toMatchObject({ code: "CREATOMATE_OUTPUT_INVALID" } satisfies Partial<DomainError>);
    const tooLarge = new CreatomateOutputIngestor(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }), 2);
    await expect(tooLarge.ingest({ kind: "TRUSTED_REMOTE", provider: "creatomate", outputId: "r", url: "https://cdn.creatomate.com/renders/r.mp4", metadata: {} })).rejects.toMatchObject({ code: "CREATOMATE_OUTPUT_DOWNLOAD_FAILED" });
  });
});
