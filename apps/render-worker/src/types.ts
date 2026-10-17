import type { VariantRecipe } from "@koolezt/domain";
export const PROTOCOL_VERSION = "render-worker/v1";
export const WORKER_CAPABILITIES = ["standard-render-v1", "variant-effects-v1"] as const;
export type WorkerConfig = Readonly<{ serverUrl: string; workerId: string; workerVersion: string; token: string; ffmpegPath: string; ffprobePath: string; dataRoot: string; cacheMaxBytes: number; preferredEncoder?: string; fontPath?: string }>;
export type RenderAssetReference = Readonly<{ assetId: string; sha256: string; downloadPath: string; downloadUrl?: string; downloadExpiresAt?: string }>;
export type RenderManifest = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION; jobId: string; projectId: string; projectPublicId: string; renderAttemptId: string; leaseToken: string; leaseExpiresAt: string;
  scenes: readonly (RenderAssetReference & Readonly<{ position: number; durationMs: number; sourceDurationMs?: number }>)[];
  narration: RenderAssetReference & Readonly<{ durationMs?: number; leadInMs?: number; atempo?: number }>;
  music?: RenderAssetReference;
  overlays: readonly Readonly<{ text: string; sceneIndex: number }>[]; cta: string;
  timeline: Readonly<{ transition: "CUT" | "CROSSFADE" | "SOFT_DISSOLVE"; transitionDurationMs: number; sourceAudio: false }>;
  output: Readonly<{ width: number; height: number; fps: number; durationMs: number; videoCodec: "h264"; audioCodec: "aac"; pixelFormat: "yuv420p" }>;
  variant?: Readonly<{ variantId: string; publicId: string; recipeHash: string; recipe: VariantRecipe }>;
}>;
