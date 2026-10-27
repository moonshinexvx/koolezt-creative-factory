import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeCreativeDna } from "@koolezt/application";
import { creativeDnaPacing, creativeDnaSampleTimestamps, FfmpegCreativeDnaPreprocessor, LocalStorageProvider, parseSceneCuts } from "@koolezt/media";
import { OpenAIAudioTranscriber } from "@koolezt/providers";
import type { CreativeDnaAnalysisInput, CreativeDnaTranscriber } from "@koolezt/domain";

const draft = { openingPattern: "o", openingProductVisible: true, visualHookMechanism: "v", productProminence: "p", personalizationVisibility: "p", repeatedExamplePattern: "r", pacingPattern: "p", beatStructure: "b", overlayTextPattern: "o", offerVisibilityPattern: "o", ctaPattern: "c", proofPattern: "p", visualFormat: "v", lifestyleVsProductBalance: "l", soundOffComprehension: "s", directResponsePattern: "d", closingPattern: "c", preserveTraits: [], safeToVaryTraits: [], avoidTraits: [] };
const baseInput = { referenceId: "r", displayName: "Winner", mediaMetadata: { durationMs: 15_000, width: 1080, height: 1920, hasAudio: true, mimeType: "video/mp4" }, frames: [{ timestampMs: 0, mimeType: "image/jpeg" as const, bytesBase64: "x", sha256: "a".repeat(64) }] };

describe("Creative DNA scene-cut sampling", () => {
  it("keeps the hook and ending, adds a frame just inside each detected shot, and respects the budget", () => {
    const timestamps = creativeDnaSampleTimestamps(20_000, 30, [4_000, 8_500, 13_000]);
    expect(timestamps.filter((value) => value <= 3_000)).toEqual([0, 250, 500, 1000, 1500, 2000, 3000]);
    expect(timestamps).toEqual(expect.arrayContaining([4_150, 8_650, 13_150, 19_900]));
    expect(timestamps.length).toBeLessThanOrEqual(30);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("thins dense cuts evenly instead of dropping the end of the ad", () => {
    const cuts = Array.from({ length: 80 }, (_, i) => 3_200 + i * 400);
    const timestamps = creativeDnaSampleTimestamps(40_000, 20, cuts);
    expect(timestamps).toHaveLength(20);
    expect(timestamps.at(-1)).toBe(39_900);
    expect(timestamps.filter((value) => value > 20_000).length).toBeGreaterThan(3);
  });

  it("parses showinfo output into ordered cuts and derives pacing", () => {
    const log = "[Parsed_showinfo_2] n:0 pts:61440 pts_time:4.0 duration:512\n[Parsed_showinfo_2] n:1 pts_time:4.1 \n[Parsed_showinfo_2] n:2 pts_time:8.52\n[Parsed_showinfo_2] n:3 pts_time:99";
    const cuts = parseSceneCuts(log, 15_000);
    expect(cuts).toEqual([4_000, 8_520]);
    expect(creativeDnaPacing(15_000, cuts)).toEqual({ sceneCutsMs: [4_000, 8_520], shotCount: 3, averageShotMs: 5_000, firstCutMs: 4_000, detectionThreshold: 0.3 });
  });
});

describe("Creative DNA audio transcription", () => {
  it("requests timestamped segments and drops segments that are probably not speech", async () => {
    let request: Record<string, unknown> = {};
    const create = vi.fn(async (value: Record<string, unknown>) => { request = value; return { text: "ignored", language: "english", duration: 15, segments: [
      { id: 0, start: 0.2, end: 1.84, text: " Your pet. Your number. ", no_speech_prob: 0.05 },
      { id: 1, start: 9, end: 12, text: " Thank you for watching.", no_speech_prob: 0.9 },
      { id: 2, start: 12.5, end: 14.1, text: " Order yours today.", no_speech_prob: 0.1 }
    ] }; });
    const transcriber = new OpenAIAudioTranscriber({ apiKey: "test-secret", model: "whisper-1" }, { audio: { transcriptions: { create } } } as never);
    const result = await transcriber.transcribe({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg", fileName: "a.mp3", durationMs: 15_000 });
    expect(request).toMatchObject({ model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["segment"] });
    expect(result).toEqual({ provider: "openai", model: "whisper-1", language: "english", text: "Your pet. Your number. Order yours today.", segments: [{ startMs: 200, endMs: 1_840, text: "Your pet. Your number." }, { startMs: 12_500, endMs: 14_100, text: "Order yours today." }] });
  });

  it("transcribes the fixture's audio track and reports a transcriber failure without failing preprocessing", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-dna-audio-"));
    try {
      const storage = new LocalStorageProvider(root);
      const asset = await storage.put("history/fixture.mp4", { bytes: await readFile("tests/fixtures/vertical-1080x1920.mp4"), mimeType: "video/mp4", extension: "mp4", metadata: {} });
      const architecture = process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64";
      const ffmpeg = resolve(`node_modules/ffmpeg-static/ffmpeg${process.platform === "win32" ? ".exe" : ""}`);
      const ffprobe = resolve(`node_modules/ffprobe-static/bin/${process.platform}/${architecture}/ffprobe${process.platform === "win32" ? ".exe" : ""}`);
      const received: { bytes: number; mimeType: string }[] = [];
      const transcriber: CreativeDnaTranscriber = { async transcribe(input) { received.push({ bytes: input.bytes.byteLength, mimeType: input.mimeType }); return { provider: "fake", model: "fake-stt", text: "Hello", segments: [{ startMs: 0, endMs: 900, text: "Hello" }] }; } };
      const result = await new FfmpegCreativeDnaPreprocessor(storage, ffmpeg, ffprobe, { transcriber, maxFrames: 16 }).preprocess(asset);
      expect(received).toHaveLength(1);
      expect(received[0]!.bytes).toBeGreaterThan(1_000);
      expect(received[0]!.mimeType).toBe("audio/mpeg");
      expect(result.audioTranscript).toMatchObject({ status: "TRANSCRIBED", model: "fake-stt", text: "Hello" });
      expect(result.frames.length).toBeLessThanOrEqual(16);
      const failing: CreativeDnaTranscriber = { async transcribe() { throw new Error("upstream 503"); } };
      expect((await new FfmpegCreativeDnaPreprocessor(storage, ffmpeg, ffprobe, { transcriber: failing }).preprocess(asset)).audioTranscript).toEqual({ status: "FAILED", reason: "upstream 503" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("Creative DNA measured evidence", () => {
  it("keeps SCENE_CUT evidence only near a measured cut and AUDIO_TRANSCRIPT only when a transcript exists", () => {
    const sourceEvidence = [
      { kind: "SCENE_CUT", observation: "Cut to the installed sign", timestampMs: 4_100, endTimestampMs: null, frameSha256: null },
      { kind: "SCENE_CUT", observation: "Invented cut", timestampMs: 7_000, endTimestampMs: null, frameSha256: null },
      { kind: "AUDIO_TRANSCRIPT", observation: "Spoken hook: Your pet. Your number.", timestampMs: 200, endTimestampMs: 1_840, frameSha256: null }
    ];
    const withTranscript: CreativeDnaAnalysisInput = { ...baseInput, pacing: creativeDnaPacing(15_000, [4_000]), audioTranscript: { status: "TRANSCRIBED", provider: "openai", model: "whisper-1", text: "Your pet. Your number.", segments: [{ startMs: 200, endMs: 1_840, text: "Your pet. Your number." }] } };
    expect(canonicalizeCreativeDna({ ...draft, sourceEvidence }, withTranscript).sourceEvidence.map((item) => item.observation)).toEqual(["Cut to the installed sign", "Spoken hook: Your pet. Your number."]);
    const withoutTranscript: CreativeDnaAnalysisInput = { ...baseInput, pacing: creativeDnaPacing(15_000, [4_000]), audioTranscript: { status: "DISABLED" } };
    expect(canonicalizeCreativeDna({ ...draft, sourceEvidence }, withoutTranscript).sourceEvidence.map((item) => item.kind)).toEqual(["SCENE_CUT"]);
  });
});
