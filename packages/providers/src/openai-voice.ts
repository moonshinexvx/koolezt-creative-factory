import OpenAI from "openai";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import { DomainError } from "@koolezt/domain";
import type { MediaPayload, ProviderJobStatus, ProviderOperationContext, ProviderSubmission, VoiceProvider } from "@koolezt/domain";

export const OPENAI_VOICE_DEFAULT_STYLE = "Warm, natural and engaging social-media ad voice. Friendly and conversational, with confident pacing. Avoid exaggerated announcer delivery.";

type OpenAIAudioClient = Readonly<{
  audio: Readonly<{
    speech: Readonly<{
      create: (input: SpeechCreateParams) => Readonly<{
        withResponse: () => Promise<Readonly<{ data: Response; request_id: string | null }>>;
      }>;
    }>;
  }>;
}>;

type OpenAIVoiceConfig = Readonly<{
  apiKey: string;
  model: string;
  voice: string;
  outputFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm" | undefined;
  instructions?: string | undefined;
}>;

const supportedFormats = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
// Keep legacy profile IDs mapped to the configured default while allowing the
// documented OpenAI TTS voice names used by Creative Variant packages.
const selectableVoices = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse", "cedar"]);

function formatDetails(format: NonNullable<OpenAIVoiceConfig["outputFormat"]>): Readonly<{ extension: string; mimeType: string }> {
  switch (format) {
    case "aac": return { extension: "aac", mimeType: "audio/aac" };
    case "flac": return { extension: "flac", mimeType: "audio/flac" };
    case "opus": return { extension: "opus", mimeType: "audio/ogg" };
    case "wav": return { extension: "wav", mimeType: "audio/wav" };
    case "pcm": return { extension: "pcm", mimeType: "audio/L16" };
    default: return { extension: "mp3", mimeType: "audio/mpeg" };
  }
}

/**
 * OpenAI's synchronous speech endpoint returns audio bytes, not a provider task or
 * native word alignment. The application stores the bytes through its existing
 * VoiceProvider flow and deliberately leaves captionTimings absent.
 */
export class OpenAIVoiceProvider implements VoiceProvider {
  private readonly client: OpenAIAudioClient;
  private readonly results = new Map<string, MediaPayload>();
  private readonly format: NonNullable<OpenAIVoiceConfig["outputFormat"]>;

  constructor(private readonly config: OpenAIVoiceConfig, client?: OpenAIAudioClient) {
    if (!config.apiKey) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_API_KEY is required when VOICE_PROVIDER=openai.");
    if (!config.model) throw new DomainError("OPENAI_VOICE_CONFIGURATION_MISSING", "OPENAI_VOICE_MODEL is required when VOICE_PROVIDER=openai.");
    if (!config.voice) throw new DomainError("OPENAI_VOICE_CONFIGURATION_MISSING", "OPENAI_VOICE_NAME is required when VOICE_PROVIDER=openai.");
    const requestedFormat = config.outputFormat ?? "mp3";
    if (!supportedFormats.includes(requestedFormat)) throw new DomainError("OPENAI_VOICE_CONFIGURATION_MISSING", "OPENAI_VOICE_OUTPUT_FORMAT is unsupported.");
    this.format = requestedFormat;
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: 30_000 });
  }

  async submit(
    input: Readonly<{ voiceProfileId: string; script: string; instructions?: string }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission> {
    const providerTaskId = `openai-tts:${context.operationKey}`;
    try {
      const instructions = input.instructions ?? this.config.instructions;
      const voice = selectableVoices.has(input.voiceProfileId) ? input.voiceProfileId : this.config.voice;
      const request = this.client.audio.speech.create({
        model: this.config.model,
        voice: voice as SpeechCreateParams["voice"],
        input: input.script,
        response_format: this.format,
        ...(instructions ? { instructions } : {})
      });
      const { data, request_id } = await request.withResponse();
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0) throw new DomainError("OPENAI_TTS_AUDIO_INVALID", "OpenAI returned empty narration audio.");
      const output = formatDetails(this.format);
      const metadata = {
        provider: "openai",
        voiceProfileId: input.voiceProfileId,
        voice,
        model: this.config.model,
        outputFormat: this.format,
        operationKey: context.operationKey,
        captionTimings: [] as const,
        nativeWordTimings: false
      };
      this.results.set(providerTaskId, { bytes, ...output, metadata });
      return { providerTaskId, requestId: request_id ?? providerTaskId, provider: "openai", model: this.config.model, metadata };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 401 || status === 403) throw new DomainError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication was rejected.");
      if (status === 429) throw new DomainError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached; retry later.");
      if (status >= 500) throw new DomainError("OPENAI_UNAVAILABLE", "OpenAI is temporarily unavailable.");
      // The endpoint is billable. A transport failure may occur after submission;
      // never retry it inside the adapter.
      throw new DomainError("OPENAI_TTS_SUBMISSION_UNKNOWN", "OpenAI voice submission outcome is unknown; do not retry automatically.");
    }
  }

  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<MediaPayload>> {
    const result = this.results.get(providerTaskId);
    return result ? { state: "SUCCEEDED", result } : { state: "FAILED", message: "Unknown OpenAI voice task.", retryable: false };
  }
}
