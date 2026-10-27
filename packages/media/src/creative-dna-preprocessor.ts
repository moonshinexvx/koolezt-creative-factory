import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@koolezt/domain";
import type { CreativeDnaAudioLevels, CreativeDnaAudioTranscript, CreativeDnaFrame, CreativeDnaPacing, CreativeDnaPreprocessed, CreativeDnaPreprocessor, CreativeDnaTranscriber, GeneratedAsset, StorageProvider } from "@koolezt/domain";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const MAX_CREATIVE_DNA_FRAMES = 30;
export const CREATIVE_DNA_SCENE_THRESHOLD = 0.3;
const HOOK_TIMESTAMPS = [0, 250, 500, 1000, 1500, 2000, 3000];
// Frames closer than this add little information; the frame after a cut is taken this far into the new shot.
const MIN_FRAME_GAP_MS = 150;
const MAX_SCENE_CUTS = 200;
const MAX_TRANSCRIBED_DURATION_MS = 10 * 60_000;

function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]!);
}

/**
 * Hook-heavy sampling: the first three seconds and the final frame are always kept, then one frame
 * just inside each detected shot, then evenly spaced fill. Cuts are thinned evenly when over budget.
 */
export function creativeDnaSampleTimestamps(durationMs: number, maxFrames = MAX_CREATIVE_DNA_FRAMES, sceneCutsMs: readonly number[] = []): readonly number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new DomainError("CREATIVE_DNA_MEDIA_INVALID", "Creative DNA analysis requires a positive video duration.");
  const end = Math.max(0, durationMs - 100);
  const chosen: number[] = [];
  const add = (timestampMs: number) => {
    if (chosen.length >= maxFrames || timestampMs < 0 || timestampMs > end) return;
    if (chosen.some((existing) => Math.abs(existing - timestampMs) < MIN_FRAME_GAP_MS)) return;
    chosen.push(timestampMs);
  };
  for (const timestampMs of HOOK_TIMESTAMPS) add(timestampMs);
  add(end);
  const shotStarts = sceneCutsMs.map((cut) => Math.min(end, Math.round(cut) + MIN_FRAME_GAP_MS)).filter((value) => value > 0 && value < end);
  for (const timestampMs of evenlySpaced(shotStarts, maxFrames - chosen.length)) add(timestampMs);
  const remaining = maxFrames - chosen.length;
  for (let i = 1; i <= remaining; i++) add(Math.round(3000 + ((end - 3000) * i) / (remaining + 1)));
  return chosen.sort((a, b) => a - b);
}

export function creativeDnaPacing(durationMs: number, sceneCutsMs: readonly number[], detectionThreshold = CREATIVE_DNA_SCENE_THRESHOLD): CreativeDnaPacing {
  const shotCount = sceneCutsMs.length + 1;
  return { sceneCutsMs, shotCount, averageShotMs: Math.round(durationMs / shotCount), ...(sceneCutsMs.length ? { firstCutMs: sceneCutsMs[0]! } : {}), detectionThreshold };
}

/** Parses FFmpeg showinfo output into sorted, de-duplicated cut timestamps in milliseconds. */
export function parseSceneCuts(showinfoLog: string, durationMs: number): readonly number[] {
  const cuts: number[] = [];
  for (const match of showinfoLog.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const timestampMs = Math.round(Number(match[1]) * 1000);
    if (timestampMs <= 0 || timestampMs >= durationMs) continue;
    if (cuts.length && timestampMs - cuts.at(-1)! < 200) continue;
    cuts.push(timestampMs);
  }
  return cuts.sort((a, b) => a - b).slice(0, MAX_SCENE_CUTS);
}

// Silence below this level counts as no audio; -70 LUFS is FFmpeg's reported floor for silent tracks.
const SILENCE_THRESHOLD_DB = -45;
const LOUDNESS_FLOOR_LUFS = -69;

/** Parses silencedetect and ebur128 summary output. Silence that runs to the end has no silence_end line. */
export function parseAudioLevels(log: string, durationMs: number): CreativeDnaAudioLevels {
  let silentMs = 0;
  let openStartMs: number | undefined;
  for (const match of log.matchAll(/silence_(start|end):\s*(-?[0-9]+(?:\.[0-9]+)?)/g)) {
    const atMs = Math.max(0, Math.round(Number(match[2]) * 1000));
    if (match[1] === "start") openStartMs = atMs;
    else if (openStartMs !== undefined) { silentMs += Math.max(0, atMs - openStartMs); openStartMs = undefined; }
  }
  if (openStartMs !== undefined) silentMs += Math.max(0, durationMs - openStartMs);
  const loudness = [...log.matchAll(/^\s*I:\s*(-?[0-9]+(?:\.[0-9]+)?) LUFS/gm)].at(-1);
  const integratedLufs = loudness ? Number(loudness[1]) : undefined;
  const audioPresentRatio = durationMs > 0 ? Math.min(1, Math.max(0, 1 - silentMs / durationMs)) : 0;
  return { audioPresentRatio: Math.round(audioPresentRatio * 1000) / 1000, ...(integratedLufs !== undefined && integratedLufs > LOUDNESS_FLOOR_LUFS ? { integratedLufs } : {}) };
}

function run(command: string, args: readonly string[]): Promise<Readonly<{ stdout: Buffer; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (x) => out.push(Buffer.from(x)));
    child.stderr.on("data", (x) => err.push(Buffer.from(x)));
    child.on("error", () => reject(new DomainError("CREATIVE_DNA_MEDIA_TOOL_UNAVAILABLE", "FFmpeg/ffprobe is unavailable.")));
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new DomainError("CREATIVE_DNA_MEDIA_INVALID", stderr.slice(0, 500) || "Media preprocessing failed."));
    });
  });
}

export class FfmpegCreativeDnaPreprocessor implements CreativeDnaPreprocessor {
  constructor(
    private readonly storage: StorageProvider,
    private readonly ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe",
    private readonly options: Readonly<{ transcriber?: CreativeDnaTranscriber; maxFrames?: number }> = {}
  ) {}

  async preprocess(asset: GeneratedAsset): Promise<CreativeDnaPreprocessed> {
    if (asset.kind !== "VIDEO") throw new DomainError("CREATIVE_DNA_VIDEO_REQUIRED", "Creative DNA analysis requires a video asset.");
    const root = await mkdtemp(join(tmpdir(), "koolezt-dna-"));
    try {
      const input = join(root, `source-${randomUUID()}.video`);
      await writeFile(input, await this.storage.read(asset.storageKey), { mode: 0o600 });
      const probe = JSON.parse((await run(this.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", input])).stdout.toString("utf8")) as any;
      const video = probe.streams?.find((s: any) => s.codec_type === "video");
      if (!video) throw new DomainError("CREATIVE_DNA_MEDIA_INVALID", "Historical creative has no video stream.");
      const durationMs = Math.round(Number(probe.format?.duration ?? video.duration) * 1000);
      const [numerator, denominator] = String(video.avg_frame_rate ?? "0/1").split("/").map(Number);
      const frameRate = numerator && denominator ? numerator / denominator : undefined;
      const hasAudio = Boolean(probe.streams?.some((s: any) => s.codec_type === "audio"));
      const mediaMetadata = { durationMs, width: Number(video.width), height: Number(video.height), ...(frameRate && Number.isFinite(frameRate) ? { frameRate } : {}), hasAudio, mimeType: asset.mimeType };
      const sceneCutsMs = await this.detectSceneCuts(input, durationMs);
      const frames: CreativeDnaFrame[] = [];
      for (const timestampMs of creativeDnaSampleTimestamps(durationMs, this.options.maxFrames ?? MAX_CREATIVE_DNA_FRAMES, sceneCutsMs)) {
        const output = join(root, `frame-${timestampMs}.jpg`);
        await run(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", (timestampMs / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "3", "-y", output]);
        const bytes = await readFile(output);
        frames.push({ timestampMs, mimeType: "image/jpeg", bytesBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      const audioTranscript = await this.transcribe(root, input, durationMs, hasAudio);
      const audioLevels = hasAudio ? await this.measureAudioLevels(input, durationMs) : undefined;
      return { mediaMetadata, frames, pacing: creativeDnaPacing(durationMs, sceneCutsMs), audioTranscript, ...(audioLevels ? { audioLevels } : {}) };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async detectSceneCuts(input: string, durationMs: number): Promise<readonly number[]> {
    const { stderr } = await run(this.ffmpegPath, ["-hide_banner", "-loglevel", "info", "-i", input, "-an", "-vf", `scale=320:-2,select='gt(scene,${CREATIVE_DNA_SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"]);
    return parseSceneCuts(stderr, durationMs);
  }

  private async measureAudioLevels(input: string, durationMs: number): Promise<CreativeDnaAudioLevels | undefined> {
    try {
      const { stderr } = await run(this.ffmpegPath, ["-hide_banner", "-nostats", "-loglevel", "info", "-i", input, "-vn", "-af", `silencedetect=n=${SILENCE_THRESHOLD_DB}dB:d=0.4,ebur128=framelog=verbose`, "-f", "null", "-"]);
      return parseAudioLevels(stderr, durationMs);
    } catch {
      return undefined;
    }
  }

  /** Transcription is best-effort context: a failure is reported to the analysis instead of failing it. */
  private async transcribe(root: string, input: string, durationMs: number, hasAudio: boolean): Promise<CreativeDnaAudioTranscript> {
    if (!hasAudio) return { status: "NO_AUDIO" };
    if (!this.options.transcriber) return { status: "DISABLED" };
    if (durationMs > MAX_TRANSCRIBED_DURATION_MS) return { status: "FAILED", reason: "Audio is longer than the 10 minute transcription limit." };
    try {
      const output = join(root, "audio.mp3");
      await run(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-y", output]);
      const transcription = await this.options.transcriber.transcribe({ bytes: await readFile(output), mimeType: "audio/mpeg", fileName: "historical-ad-audio.mp3", durationMs });
      return { status: "TRANSCRIBED", ...transcription };
    } catch (error) {
      return { status: "FAILED", reason: (error instanceof Error ? error.message : "Transcription failed.").slice(0, 300) };
    }
  }
}
