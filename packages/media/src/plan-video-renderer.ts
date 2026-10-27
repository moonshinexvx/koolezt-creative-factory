import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@koolezt/domain";
import type { VideoPlanMotion } from "@koolezt/domain";

export const PLAN_VIDEO_WIDTH = 1080;
export const PLAN_VIDEO_HEIGHT = 1920;
export const PLAN_VIDEO_FPS = 30;
const TRANSITION_MS = 300;
const VOICE_LEAD_IN_MS = 300;
const VOICE_TAIL_MS = 700;
const CTA_MS = 2_500;
const MOTION_ZOOM = 0.12;

export type PlanRenderScene = Readonly<{ photoPath: string; photoWidth: number; photoHeight: number; motion: VideoPlanMotion; caption: string; durationMs: number }>;
export type PlanRenderInput = Readonly<{ scenes: readonly PlanRenderScene[]; hookText: string; ctaText: string; voicePath: string; voiceDurationMs: number; targetDurationMs: number }>;

/** Greedy word wrap; words longer than a line are kept whole rather than split mid-word. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const current = lines.at(-1);
    if (current !== undefined && (current + " " + word).length <= maxChars) lines[lines.length - 1] = `${current} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[.,;:!?]*$/, "")}…`;
  return kept;
}

/** Scene lengths stretched so the video is the target length, or long enough for the whole voiceover. */
export function planTimeline(scenes: readonly Readonly<{ durationMs: number }>[], targetDurationMs: number, voiceDurationMs: number): Readonly<{ totalMs: number; sceneMs: readonly number[] }> {
  const totalMs = Math.max(targetDurationMs, voiceDurationMs + VOICE_LEAD_IN_MS + VOICE_TAIL_MS);
  const planned = scenes.reduce((sum, scene) => sum + Math.max(1, scene.durationMs), 0);
  const sceneMs = scenes.map((scene) => Math.round((Math.max(1, scene.durationMs) / planned) * totalMs));
  sceneMs[sceneMs.length - 1] = totalMs - sceneMs.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return { totalMs, sceneMs };
}

/** Foreground box that keeps the photo's aspect ratio inside the upper part of the frame (even pixel sizes). */
export function foregroundBox(width: number, height: number): Readonly<{ width: number; height: number }> {
  const maxW = 1000;
  const maxH = 1240;
  const scale = Math.min(maxW / width, maxH / height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

function motionExpressions(motion: VideoPlanMotion, frames: number): Readonly<{ z: string; x: string; y: string }> {
  const progress = `min(on/${Math.max(1, frames - 1)},1)`;
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  if (motion === "ZOOM_OUT") return { z: `${1 + MOTION_ZOOM}-${MOTION_ZOOM}*${progress}`, x: centerX, y: centerY };
  if (motion === "PAN_LEFT") return { z: `${1 + MOTION_ZOOM}`, x: `(iw-iw/zoom)*(1-${progress})`, y: centerY };
  if (motion === "PAN_RIGHT") return { z: `${1 + MOTION_ZOOM}`, x: `(iw-iw/zoom)*${progress}`, y: centerY };
  return { z: `1+${MOTION_ZOOM}*${progress}`, x: centerX, y: centerY };
}

/** Escapes a path for use inside an FFmpeg filter argument (Windows drive colons and backslashes included). */
export function filterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

type TextLayer = Readonly<{ file: string; fontSize: number; y: number; startMs: number; endMs: number; box?: string; border?: number }>;

/** Builds the FFmpeg argument list for one plan video. Pure: the caller writes the text files it references. */
export function buildPlanVideoArguments(input: Readonly<{
  scenes: readonly PlanRenderScene[]; sceneMs: readonly number[]; totalMs: number; voicePath: string; outputPath: string;
  fontPath: string; textLayers: readonly TextLayer[]; threads: number;
}>): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const last = input.scenes.length - 1;
  input.scenes.forEach((scene, index) => {
    const clipMs = input.sceneMs[index]! + (index < last ? TRANSITION_MS : 0);
    args.push("-loop", "1", "-framerate", String(PLAN_VIDEO_FPS), "-t", (clipMs / 1000).toFixed(3), "-i", scene.photoPath);
  });
  args.push("-i", input.voicePath);
  const filters: string[] = [];
  input.scenes.forEach((scene, index) => {
    const clipMs = input.sceneMs[index]! + (index < last ? TRANSITION_MS : 0);
    const frames = Math.round((clipMs / 1000) * PLAN_VIDEO_FPS);
    const box = foregroundBox(scene.photoWidth, scene.photoHeight);
    const motion = motionExpressions(scene.motion, frames);
    // Upscaling before zoompan keeps slow zooms smooth instead of stepping a pixel at a time.
    filters.push(
      `[${index}:v]split[bgsrc${index}][fgsrc${index}]`,
      `[bgsrc${index}]scale=${PLAN_VIDEO_WIDTH}:${PLAN_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${PLAN_VIDEO_WIDTH}:${PLAN_VIDEO_HEIGHT},gblur=sigma=30,eq=brightness=-0.06[bg${index}]`,
      `[fgsrc${index}]scale=${box.width * 2}:${box.height * 2},zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=1:s=${box.width}x${box.height}:fps=${PLAN_VIDEO_FPS}[fg${index}]`,
      `[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2-140:shortest=1,trim=duration=${(clipMs / 1000).toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[s${index}]`
    );
  });
  let stream = "s0";
  let offsetMs = 0;
  for (let index = 1; index <= last; index++) {
    offsetMs += input.sceneMs[index - 1]!;
    filters.push(`[${stream}][s${index}]xfade=transition=fade:duration=${(TRANSITION_MS / 1000).toFixed(3)}:offset=${(offsetMs / 1000).toFixed(3)}[x${index}]`);
    stream = `x${index}`;
  }
  const font = filterPath(input.fontPath);
  const text = input.textLayers.map((layer) => `drawtext=fontfile='${font}':textfile='${filterPath(layer.file)}':fontcolor=white:fontsize=${layer.fontSize}:x=(w-text_w)/2:y=${layer.y}${layer.border ? `:borderw=${layer.border}:bordercolor=black` : ""}${layer.box ? `:box=1:boxcolor=${layer.box}:boxborderw=22` : ""}:enable='between(t,${(layer.startMs / 1000).toFixed(3)},${(layer.endMs / 1000).toFixed(3)})'`);
  filters.push(`[${stream}]${text.length ? text.join(",") : "null"},trim=duration=${(input.totalMs / 1000).toFixed(3)}[v]`);
  const totalSec = (input.totalMs / 1000).toFixed(3);
  filters.push(`[${input.scenes.length}:a]adelay=${VOICE_LEAD_IN_MS}|${VOICE_LEAD_IN_MS},apad,atrim=0:${totalSec},afade=t=out:st=${Math.max(0, input.totalMs / 1000 - 0.4).toFixed(3)}:d=0.4,alimiter=limit=0.95[a]`);
  args.push("-filter_complex", filters.join(";"), "-filter_complex_threads", String(input.threads), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", String(input.threads), "-pix_fmt", "yuv420p", "-r", String(PLAN_VIDEO_FPS),
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", totalSec, input.outputPath);
  return args;
}

export function defaultRenderFontPath(): string {
  return process.platform === "win32" ? "C:\\Windows\\Fonts\\arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
}

function runProcess(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
    child.on("error", () => { clearTimeout(timer); reject(new DomainError("VIDEO_RENDER_TOOL_UNAVAILABLE", "FFmpeg is unavailable on this server.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new DomainError("VIDEO_RENDER_FAILED", `Video rendering failed: ${Buffer.concat(err).toString("utf8").slice(-400) || `exit ${code}`}`));
    });
  });
}

export class PlanVideoRenderer {
  constructor(private readonly options: Readonly<{ ffmpegPath?: string; ffprobePath?: string; fontPath?: string; threads?: number; lowPriority?: boolean; timeoutMs?: number }> = {}) {}

  private get ffmpeg() { return this.options.ffmpegPath ?? "ffmpeg"; }
  private get ffprobe() { return this.options.ffprobePath ?? "ffprobe"; }

  async probe(path: string): Promise<Readonly<{ width?: number; height?: number; durationMs?: number }>> {
    const out = JSON.parse(await runProcess(this.ffprobe, ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", path], 30_000)) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const stream = out.streams?.find((item) => item.width && item.height);
    const duration = Number(out.format?.duration);
    return { ...(stream ? { width: Number(stream.width), height: Number(stream.height) } : {}), ...(Number.isFinite(duration) ? { durationMs: Math.round(duration * 1000) } : {}) };
  }

  /** Renders to MP4 bytes. On Linux FFmpeg runs at the lowest CPU and disk priority so other services always come first. */
  async render(input: PlanRenderInput): Promise<Readonly<{ bytes: Uint8Array; durationMs: number }>> {
    if (!input.scenes.length) throw new DomainError("VIDEO_PLAN_INVALID", "A video needs at least one scene.");
    const fontPath = this.options.fontPath ?? defaultRenderFontPath();
    if (!existsSync(fontPath)) throw new DomainError("VIDEO_RENDER_FONT_MISSING", `The caption font is missing: ${fontPath}`);
    const root = await mkdtemp(join(tmpdir(), "koolezt-plan-video-"));
    try {
      const { totalMs, sceneMs } = planTimeline(input.scenes, input.targetDurationMs, input.voiceDurationMs);
      const layers: TextLayer[] = [];
      const addText = async (name: string, value: string, maxChars: number, maxLines: number, base: Omit<TextLayer, "file" | "y"> & { y: number; lineHeight: number }) => {
        const lines = wrapText(value, maxChars, maxLines);
        for (const [index, line] of lines.entries()) {
          const file = join(root, `${name}-${index}.txt`);
          await writeFile(file, line, "utf8");
          const { lineHeight: _l, ...layer } = base;
          void _l;
          layers.push({ ...layer, file, y: base.y + index * base.lineHeight });
        }
      };
      const hookEnd = Math.min(sceneMs[0]!, 3_200);
      if (input.hookText.trim()) await addText("hook", input.hookText, 18, 3, { fontSize: 78, border: 7, startMs: 150, endMs: hookEnd, y: Math.round(PLAN_VIDEO_HEIGHT * 0.1), lineHeight: 96 });
      let start = 0;
      for (const [index, scene] of input.scenes.entries()) {
        const end = start + sceneMs[index]!;
        const captionStart = index === 0 ? hookEnd : start + 150;
        const captionEnd = index === input.scenes.length - 1 ? Math.min(end, totalMs - CTA_MS) : end;
        if (scene.caption.trim() && captionEnd - captionStart > 600) await addText(`caption${index}`, scene.caption, 24, 2, { fontSize: 58, box: "black@0.5", startMs: captionStart, endMs: captionEnd, y: Math.round(PLAN_VIDEO_HEIGHT * 0.73), lineHeight: 84 });
        start = end;
      }
      if (input.ctaText.trim()) await addText("cta", input.ctaText, 20, 2, { fontSize: 68, box: "0xE95B28@0.92", startMs: totalMs - CTA_MS, endMs: totalMs, y: Math.round(PLAN_VIDEO_HEIGHT * 0.78), lineHeight: 100 });
      const outputPath = join(root, "video.mp4");
      const args = buildPlanVideoArguments({ scenes: input.scenes, sceneMs, totalMs, voicePath: input.voicePath, outputPath, fontPath, textLayers: layers, threads: this.options.threads ?? 2 });
      const lowPriority = (this.options.lowPriority ?? true) && process.platform === "linux";
      // nice 19 + ionice idle: the kernel serves every other process first.
      if (lowPriority) await runProcess("nice", ["-n", "19", "ionice", "-c", "3", this.ffmpeg, ...args], this.options.timeoutMs ?? 600_000);
      else await runProcess(this.ffmpeg, args, this.options.timeoutMs ?? 600_000);
      const probed = await this.probe(outputPath);
      if (probed.width !== PLAN_VIDEO_WIDTH || probed.height !== PLAN_VIDEO_HEIGHT) throw new DomainError("VIDEO_RENDER_FAILED", "The rendered video has the wrong size.");
      return { bytes: new Uint8Array(await readFile(outputPath)), durationMs: probed.durationMs ?? totalMs };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
