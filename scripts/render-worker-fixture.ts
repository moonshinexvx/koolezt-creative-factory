import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { probeOutput, render } from "../apps/render-worker/src/renderer.js";
import type { RenderManifest } from "../apps/render-worker/src/types.js";

const run = promisify(execFile);
if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable.");
const root = await mkdtemp(join(tmpdir(), "koolezt-desktop-render-"));
try {
  const dimensions = ["960x960", "540x960", "720x1280"];
  const colors = ["0x284B63", "0x3C6E71", "0xD9D9D9"];
  const durations = [5.2, 5.2, 5.2];
  const scenes: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const path = join(root, `scene-${index}.mp4`); scenes.push(path);
    await run(ffmpeg, ["-y", "-f", "lavfi", "-i", `color=c=${colors[index]}:s=${dimensions[index]}:r=30:d=${durations[index]}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], { timeout: 120_000 });
  }
  const narration = join(root, "narration.mp3");
  await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=15", "-c:a", "libmp3lame", narration], { timeout: 30_000 });
  const manifest: RenderManifest = {
    protocolVersion: "render-worker/v1", jobId: "fixture-job", projectId: "fixture-project", projectPublicId: "CF-FIXTURE", renderAttemptId: "fixture-render", leaseToken: "fixture", leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    scenes: [5_334, 5_333, 5_333].map((durationMs, position) => ({ position, assetId: `scene-${position}`, sha256: "0".repeat(64), durationMs, sourceDurationMs: Math.round(durations[position]! * 1000), downloadPath: "unused" })),
    narration: { assetId: "voice", sha256: "0".repeat(64), downloadPath: "unused", durationMs: 13_600, leadInMs: 400, atempo: 1 }, overlays: [{ text: "PERSONALIZED FOR HOME", sceneIndex: 0 }, { text: "BUILT FOR YOUR STORY", sceneIndex: 1 }, { text: "MADE FOR YOU", sceneIndex: 2 }], cta: "CREATE YOURS TODAY",
    timeline: { transition: "SOFT_DISSOLVE", transitionDurationMs: 500, sourceAudio: false }, output: { width: 1080, height: 1920, fps: 30, durationMs: 15_000, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" }
  };
  const output = join(root, "output.mp4");
  await render(manifest, scenes, narration, output, ffmpeg, "libx264", join(root, "job"));
  const inspection = await probeOutput(ffprobe.path, output, manifest);
  console.log(JSON.stringify({ ...inspection, byteSize: (await stat(output)).size, sourceDimensions: dimensions, sourceAudioMuted: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
