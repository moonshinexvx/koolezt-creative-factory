import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OpenAIVoiceProvider } from "@koolezt/providers";

const execFileAsync = promisify(execFile);
const script = "Your home tells your story. Make your address sign part of it.";

if (process.env.VOICE_PROVIDER !== "openai" || process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true") {
  throw new Error("Refusing paid OpenAI TTS smoke test: set VOICE_PROVIDER=openai and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
}

const provider = new OpenAIVoiceProvider({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model: process.env.OPENAI_VOICE_MODEL ?? "",
  voice: process.env.OPENAI_VOICE_NAME ?? "",
  outputFormat: (process.env.OPENAI_VOICE_OUTPUT_FORMAT ?? "mp3") as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm",
  instructions: process.env.OPENAI_VOICE_INSTRUCTIONS
});

const operationKey = `openai-voice-smoke:${Date.now()}`;
const submission = await provider.submit({ voiceProfileId: "smoke", script }, { operationKey, projectId: "smoke", targetId: "voice" });
const status = await provider.getStatus(submission.providerTaskId);
if (status.state !== "SUCCEEDED") throw new Error("OpenAI TTS did not produce audio.");

const directory = await mkdtemp(join(tmpdir(), "koolezt-openai-voice-"));
const path = join(directory, `narration.${status.result.extension}`);
try {
  await writeFile(path, status.result.bytes);
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", path], { timeout: 15_000, maxBuffer: 32_768 });
  const inspection = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string }> };
  const durationMs = Math.round(Number(inspection.format?.duration ?? 0) * 1000);
  const audio = inspection.streams?.find((stream) => stream.codec_type === "audio");
  if (!audio || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error("OpenAI TTS output failed audio QA.");
  console.log(JSON.stringify({ provider: submission.provider, model: submission.model, voice: process.env.OPENAI_VOICE_NAME, outputFormat: status.result.metadata.outputFormat, byteSize: status.result.bytes.byteLength, durationMs, audioCodec: audio.codec_name, requestIdPresent: Boolean(submission.requestId), operationKey, nativeWordTimings: false, retries: 0 }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
