import { HttpKlingTransport, KlingVideoGenerationProvider } from "@koolezt/providers";

if (process.env.VIDEO_PROVIDER !== "kling" || process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true") {
  throw new Error("Refusing paid smoke test: set VIDEO_PROVIDER=kling and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
}
if (!process.env.KLING_API_KEY || !process.env.KLING_VIDEO_MODEL) {
  throw new Error("KLING_API_KEY and KLING_VIDEO_MODEL are required for the explicit paid smoke test.");
}
const provider = new KlingVideoGenerationProvider(
  new HttpKlingTransport(process.env.KLING_API_KEY, process.env.KLING_API_BASE_URL),
  { model: process.env.KLING_VIDEO_MODEL, resolution: "720p", aspectRatio: "9:16" }
);
const result = await provider.submit(
  { sceneNumber: 1, durationMs: 3_000, prompt: "A simple realistic vertical shot of a blank tabletop in natural daylight, gentle camera push-in.", sourceType: "KLING_VIDEO", referenceAssetIds: [], generationMode: "TEXT_TO_VIDEO", accuracyRequirements: [] },
  { operationKey: `kling-smoke:${Date.now()}`, projectId: "smoke", targetId: "scene" }
);
console.log(JSON.stringify({ provider: result.provider, taskId: result.providerTaskId, model: result.model }));
