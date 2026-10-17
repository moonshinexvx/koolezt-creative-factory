import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FfprobeMediaInspector, LocalStorageProvider, mediaSecurity } from "@koolezt/media";

const ffprobe = process.env.FFPROBE_PATH ?? resolve(
  `node_modules/ffprobe-static/bin/${process.platform}/${process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64"}/ffprobe${process.platform === "win32" ? ".exe" : ""}`
);
describe("ffprobe media inspection", () => {
  it("accepts the deterministic 1080x1920 MP4 fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-factory-media-"));
    const storage = new LocalStorageProvider(root);
    const fixture = await readFile("tests/fixtures/vertical-1080x1920.mp4");
    const asset = await storage.put("renders/final.mp4", { bytes: fixture, mimeType: "video/mp4", extension: "mp4", metadata: {} });
    const inspected = await new FfprobeMediaInspector(root, ffprobe).inspect(asset, { width: 1080, height: 1920, durationMs: 15_000, requireAudio: true });
    expect(inspected.passed).toBe(true);
    expect(inspected.hasAudio).toBe(true);
  });

  it("rejects corrupt media and path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-factory-media-"));
    await writeFile(join(root, "bad.mp4"), "not media");
    const result = await new FfprobeMediaInspector(root, ffprobe).inspect({ id: "asset", kind: "RENDER", storageKey: "bad.mp4", mimeType: "video/mp4", byteSize: 9, sha256: "0".repeat(64), metadata: {}, createdAt: new Date().toISOString() }, { width: 1080, height: 1920, durationMs: 15_000, requireAudio: true });
    expect(result.passed).toBe(false);
    expect(() => mediaSecurity.containedPath(root, "../escape.mp4")).toThrow(/escapes/);
  });
});
