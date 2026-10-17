import { createHash } from "node:crypto";
import { DomainError } from "@koolezt/domain";
import type { MediaPayload, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, VoiceProvider } from "@koolezt/domain";

export type CaptionTiming = Readonly<{ startMs: number; endMs: number; text: string }>;
type Alignment = Readonly<{ characters: readonly string[]; character_start_times_seconds: readonly number[]; character_end_times_seconds: readonly number[] }>;
export type ElevenLabsVoiceProfile = Readonly<{ providerVoiceId: string; modelId?: string; settings?: Readonly<Record<string, unknown>> }>;

export function normalizeElevenLabsAlignment(alignment: Alignment | null | undefined): readonly CaptionTiming[] {
  if (!alignment || alignment.characters.length !== alignment.character_start_times_seconds.length || alignment.characters.length !== alignment.character_end_times_seconds.length) throw new DomainError("ELEVENLABS_ALIGNMENT_INVALID", "ElevenLabs returned malformed timing alignment.");
  const words: CaptionTiming[] = []; let token = ""; let start = 0; let end = 0;
  alignment.characters.forEach((char, index) => { const charStart = alignment.character_start_times_seconds[index]!; const charEnd = alignment.character_end_times_seconds[index]!; if (/\s/.test(char)) { if (token) words.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text: token }); token = ""; return; } if (!token) start = charStart; token += char; end = charEnd; });
  if (token) words.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text: token });
  return words;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  private readonly results = new Map<string, MediaPayload>();
  constructor(private readonly config: Readonly<{ apiKey: string; modelId: string; outputFormat: string; profiles: Readonly<Record<string, ElevenLabsVoiceProfile>>; fetch?: typeof fetch }>) {
    if (!config.apiKey || !config.modelId || !config.outputFormat) throw new DomainError("ELEVENLABS_CONFIGURATION_MISSING", "ELEVENLABS_API_KEY, ELEVENLABS_MODEL_ID, and ELEVENLABS_OUTPUT_FORMAT are required when VOICE_PROVIDER=elevenlabs.");
  }
  async submit(input: Readonly<{ voiceProfileId: string; script: string }>, context: ProviderOperationContext): Promise<ProviderSubmission> {
    const profile = this.config.profiles[input.voiceProfileId];
    if (!profile) throw new DomainError("ELEVENLABS_VOICE_PROFILE_NOT_FOUND", "The selected ElevenLabs voice profile is not configured.");
    const modelId = profile.modelId ?? this.config.modelId;
    const fingerprint = createHash("sha256").update(JSON.stringify({ script: input.script, voice: profile.providerVoiceId, modelId, settings: profile.settings ?? {}, output: this.config.outputFormat })).digest("hex");
    const response = await (this.config.fetch ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(profile.providerVoiceId)}/with-timestamps?output_format=${encodeURIComponent(this.config.outputFormat)}`, { method: "POST", headers: { "xi-api-key": this.config.apiKey, "content-type": "application/json" }, body: JSON.stringify({ text: input.script, model_id: modelId, ...(profile.settings ? { voice_settings: profile.settings } : {}) }) });
    if (!response.ok) { const code = response.status; if (code === 401 || code === 403) throw new DomainError("ELEVENLABS_AUTHENTICATION_FAILED", "ElevenLabs authentication was rejected."); if (code === 429) throw new DomainError("ELEVENLABS_RATE_LIMITED", "ElevenLabs rate or concurrency limit reached; retry later."); if (code === 404) throw new DomainError("ELEVENLABS_INVALID_VOICE", "Configured ElevenLabs voice was not found."); throw new DomainError("ELEVENLABS_REQUEST_FAILED", "ElevenLabs voice generation failed."); }
    const data = await response.json() as Readonly<{ audio_base64?: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null }>;
    if (!data.audio_base64) throw new DomainError("ELEVENLABS_AUDIO_INVALID", "ElevenLabs returned no narration audio.");
    const timings = normalizeElevenLabsAlignment(data.normalized_alignment ?? data.alignment);
    const taskId = `elevenlabs:${context.operationKey}`;
    this.results.set(taskId, { bytes: Buffer.from(data.audio_base64, "base64"), mimeType: this.config.outputFormat.startsWith("mp3") ? "audio/mpeg" : "audio/wav", extension: this.config.outputFormat.startsWith("mp3") ? "mp3" : "wav", metadata: { provider: "elevenlabs", providerVoiceId: profile.providerVoiceId, modelId, outputFormat: this.config.outputFormat, fingerprint, captionTimings: timings, rawAlignment: data.alignment } });
    return { providerTaskId: taskId, requestId: response.headers.get("request-id") ?? taskId, provider: "elevenlabs", model: modelId, metadata: { providerVoiceId: profile.providerVoiceId, outputFormat: this.config.outputFormat, fingerprint, captionTimings: timings } };
  }
  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<MediaPayload>> { const result = this.results.get(providerTaskId); return result ? { state: "SUCCEEDED", result } : { state: "FAILED", message: "Unknown ElevenLabs task.", retryable: false }; }
}
