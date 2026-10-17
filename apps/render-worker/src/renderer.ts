import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { calculateSceneTimeline } from "@koolezt/domain";
import { assertRenderFont, DEFAULT_RENDER_FONT_PATH, planOverlay } from "./overlay.js";
import type { RenderManifest } from "./types.js";

const run = promisify(execFile);
export const ENCODERS = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] as const;

export async function detectEncoder(ffmpegPath: string, preferred?: string, runner: (file: string, args: readonly string[], options: Readonly<{ timeout: number }>) => Promise<unknown> = run): Promise<string> {
  const candidates = preferred ? [preferred, ...ENCODERS.filter((item) => item !== preferred)] : [...ENCODERS];
  for (const encoder of candidates) {
    try { await runner(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=64x64:rate=1:duration=0.1", "-c:v", encoder, "-f", "null", "-"], { timeout: 15_000 }); return encoder; } catch { /* unavailable */ }
  }
  throw new Error("No supported H.264 encoder is available.");
}

export async function detectTools(ffmpegPath: string, ffprobePath: string, fontPath?: string): Promise<void> {
  if (fontPath) assertRenderFont(fontPath);
  await run(ffmpegPath, ["-version"], { timeout: 10_000 });
  await run(ffprobePath, ["-version"], { timeout: 10_000 });
}

const filterPath = (path: string) => resolve(path).replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:").replaceAll("'", "\\'");
const overlaps = (manifest: RenderManifest) => manifest.timeline.transition !== "CUT";
function variantTransform(manifest: RenderManifest, index: number) {
  return manifest.variant?.recipe.scenes[index]?.transform;
}

/** A bounded, deterministic motion plan. The values are snapshotted in the immutable recipe. */
function variantMotion(manifest: RenderManifest, index: number): string {
  const transform = variantTransform(manifest, index);
  if (!transform) return "";
  const start = Math.max(1, Math.min(1.18, transform.startScale));
  const end = Math.max(1, Math.min(1.18, transform.endScale));
  const frames = Math.max(2, Math.round(manifest.scenes[index]!.durationMs / 1000 * manifest.output.fps));
  const delta = Math.abs(end - start) / frames;
  // ALTERNATE_ZOOM can genuinely reveal (decrease zoom); it is not coerced into PUSH_IN.
  const zoom = end >= start ? `min(zoom+${delta.toFixed(6)},${end.toFixed(4)})` : `max(zoom-${delta.toFixed(6)},${end.toFixed(4)})`;
  const sx = Math.max(0, Math.min(1, transform.panX ?? 0.5));
  const sy = Math.max(0, Math.min(1, transform.panY ?? 0.5));
  const ex = Math.max(0, Math.min(1, transform.endPanX ?? sx));
  const ey = Math.max(0, Math.min(1, transform.endPanY ?? sy));
  return `,zoompan=z='if(eq(on,0),${start.toFixed(4)},${zoom})':x='(iw-iw/zoom)*(${sx.toFixed(3)}+(${(ex - sx).toFixed(3)})*on/${frames})':y='(ih-ih/zoom)*(${sy.toFixed(3)}+(${(ey - sy).toFixed(3)})*on/${frames})':d=1:s=${manifest.output.width}x${manifest.output.height}:fps=${manifest.output.fps}`;
}

/** FAST_HOOK starts from the explicitly snapshotted source offset; never from mutable project state. */
function variantSourceOffset(manifest: RenderManifest, index: number): string {
  const offsetMs = variantTransform(manifest, index)?.startOffsetMs ?? 0;
  return offsetMs > 0 ? `trim=start=${(offsetMs / 1000).toFixed(3)},setpts=PTS-STARTPTS,` : "";
}

export function buildFfmpegArguments(manifest: RenderManifest, scenePaths: readonly string[], narrationPath: string, outputPath: string, encoder: string, overlayFiles: readonly string[], ctaFile: string, musicPath?: string, fontPath = DEFAULT_RENDER_FONT_PATH): string[] {
  assertRenderFont(fontPath);
  const args = ["-y"];
  for (const path of scenePaths) args.push("-i", path);
  args.push("-i", narrationPath); if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  const filters: string[] = []; const videoLabels: string[] = [];
  manifest.scenes.forEach((scene, index) => {
    const duration = scene.durationMs / 1000;
    const sourceDuration = (scene.sourceDurationMs ?? scene.durationMs) / 1000;
    const speed = sourceDuration / duration;
    // Small ±8% timing correction avoids visible holds; larger shortages hold only the final frame.
    const timing = speed >= 0.92 && speed <= 1.08 ? `setpts=PTS/${speed.toFixed(4)},` : "setpts=PTS-STARTPTS,";
    filters.push(`[${index}:v]${variantSourceOffset(manifest, index)}split=2[bg${index}][fg${index}]`, `[bg${index}]scale=${manifest.output.width}:${manifest.output.height}:force_original_aspect_ratio=increase,crop=${manifest.output.width}:${manifest.output.height},gblur=sigma=30[bb${index}]`, `[fg${index}]scale=${manifest.output.width}:${manifest.output.height}:force_original_aspect_ratio=decrease[ff${index}]`, `[bb${index}][ff${index}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${manifest.output.fps}${variantMotion(manifest, index)},${timing}trim=duration=${duration},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`);
    videoLabels.push(`[v${index}]`);
  });
  const video = "vbase";
  if (overlaps(manifest) && scenePaths.length > 1) {
    let prior = "v0"; let cumulative = manifest.scenes[0]!.durationMs / 1000;
    for (let index = 1; index < scenePaths.length; index += 1) {
      const out = index === scenePaths.length - 1 ? video : `vx${index}`;
      const dissolve = manifest.timeline.transitionDurationMs / 1000;
      // FFmpeg's fade xfade is a continuous opacity dissolve: no black intermediary or scene-audio cut.
      filters.push(`[${prior}][v${index}]xfade=transition=fade:duration=${dissolve}:offset=${Math.max(0, cumulative - dissolve)}[${out}]`);
      prior = out; cumulative += manifest.scenes[index]!.durationMs / 1000 - dissolve;
    }
  } else filters.push(`${videoLabels.join("")}concat=n=${scenePaths.length}:v=1:a=0[${video}]`);

  let decorated = video;
  overlayFiles.forEach((path, index) => {
    const next = `vo${index}`;
    const sceneIndex = Math.min(manifest.overlays[index]?.sceneIndex ?? index, manifest.scenes.length - 1);
    const scene = manifest.scenes[sceneIndex]!;
    const overlapBefore = overlaps(manifest) ? manifest.timeline.transitionDurationMs * sceneIndex : 0;
    const start = (manifest.scenes.slice(0, sceneIndex).reduce((sum, item) => sum + item.durationMs, 0) - overlapBefore) / 1000;
    const end = start + scene.durationMs / 1000;
    const layout = planOverlay(manifest.overlays[index]!.text, manifest.output.width, manifest.output.height, "HEADLINE");
    filters.push(`[${decorated}]drawtext=fontfile='${filterPath(fontPath)}':textfile='${filterPath(path)}':expansion=none:fontcolor=white:fontsize=${layout.fontSize}:line_spacing=12:borderw=4:bordercolor=black:x=${layout.safeLeft}+(${layout.maxWidth}-text_w)/2:y=${layout.y}:enable='between(t,${start},${end})'[${next}]`);
    decorated = next;
  });
  const cta = planOverlay(manifest.cta, manifest.output.width, manifest.output.height, "CTA");
  filters.push(`[${decorated}]drawtext=fontfile='${filterPath(fontPath)}':textfile='${filterPath(ctaFile)}':expansion=none:fontcolor=white:fontsize=${cta.fontSize}:line_spacing=10:box=1:boxcolor=0xE95B28CC:boxborderw=24:x=${cta.safeLeft + 24}+(${cta.maxWidth}-text_w)/2:y=${cta.y}:enable='gte(t,${Math.max(0, manifest.output.durationMs / 1000 - 4)})'[vout]`);

  const voiceIndex = scenePaths.length; const voiceLeadIn = Math.max(0, manifest.narration.leadInMs ?? 0); const voiceTempoFilter = manifest.narration.atempo && manifest.narration.atempo !== 1 ? `atempo=${manifest.narration.atempo},` : "";
  filters.push(`[${voiceIndex}:a]${voiceTempoFilter}adelay=${voiceLeadIn}|${voiceLeadIn},atrim=duration=${manifest.output.durationMs / 1000},apad=pad_dur=${manifest.output.durationMs / 1000},volume=1.0[voice]`);
  if (musicPath) filters.push(`[${voiceIndex + 1}:a]atrim=duration=${manifest.output.durationMs / 1000},volume=0.14,afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, manifest.output.durationMs / 1000 - 1)}:d=1[music]`, "[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]"); else filters.push("[voice]alimiter=limit=0.95[aout]");
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", encoder);
  if (encoder === "libx264") args.push("-preset", "veryfast", "-crf", "21");
  args.push("-pix_fmt", manifest.output.pixelFormat, "-r", String(manifest.output.fps), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", String(manifest.output.durationMs / 1000), outputPath);
  return args;
}

export async function render(manifest: RenderManifest, scenePaths: readonly string[], narrationPath: string, outputPath: string, ffmpegPath: string, encoder: string, workspace: string, musicPath?: string, fontPath = DEFAULT_RENDER_FONT_PATH): Promise<void> {
  assertRenderFont(fontPath);
  await mkdir(workspace, { recursive: true }); const overlayFiles: string[] = [];
  for (let index = 0; index < manifest.overlays.length; index += 1) {
    const layout = planOverlay(manifest.overlays[index]!.text, manifest.output.width, manifest.output.height, "HEADLINE");
    const path = join(workspace, `overlay-${index}.txt`); await writeFile(path, layout.lines.join("\n"), "utf8"); overlayFiles.push(path);
  }
  const cta = planOverlay(manifest.cta, manifest.output.width, manifest.output.height, "CTA");
  const ctaPath = join(workspace, "cta.txt"); await writeFile(ctaPath, cta.lines.join("\n"), "utf8");
  await run(ffmpegPath, buildFfmpegArguments(manifest, scenePaths, narrationPath, outputPath, encoder, overlayFiles, ctaPath, musicPath, fontPath), { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}

export async function probeOutput(ffprobePath: string, outputPath: string, manifest: RenderManifest): Promise<Readonly<{ width: number; height: number; durationMs: number; fps: number; videoCodec: string; audioCodec: string }>> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath], { timeout: 30_000 }); const data = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const video = data.streams?.find((item) => item.codec_type === "video"); const audio = data.streams?.find((item) => item.codec_type === "audio"); const durationMs = Math.round(Number(data.format?.duration ?? video?.duration ?? 0) * 1000); const rate = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number); const fps = rate[1] ? rate[0]! / rate[1]! : 0;
  const expectedSceneDurations = calculateSceneTimeline(manifest.output.durationMs, manifest.scenes.length, overlaps(manifest) ? manifest.timeline.transitionDurationMs : 0);
  if (expectedSceneDurations.some((duration, index) => Math.abs(duration - manifest.scenes[index]!.durationMs) > 1) || !video || !audio || Number(video.width) !== manifest.output.width || Number(video.height) !== manifest.output.height || String(video.codec_name) !== "h264" || String(audio.codec_name) !== "aac" || Math.abs(fps - manifest.output.fps) > 0.5 || Math.abs(durationMs - manifest.output.durationMs) > 250) throw new Error("Rendered output failed local ffprobe QA.");
  return { width: Number(video.width), height: Number(video.height), durationMs, fps, videoCodec: String(video.codec_name), audioCodec: String(audio.codec_name) };
}