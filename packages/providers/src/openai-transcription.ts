import OpenAI, { toFile } from "openai";
import { DomainError } from "@koolezt/domain";
import type { CreativeDnaTranscriber, CreativeDnaTranscription } from "@koolezt/domain";

// Whisper reports a per-segment probability that no speech is present. Music-only ads otherwise
// produce invented phrases, so segments above this are dropped before analysis.
const MAX_NO_SPEECH_PROBABILITY = 0.6;

export class OpenAIAudioTranscriber implements CreativeDnaTranscriber {
  private readonly client: OpenAI;
  constructor(private readonly config: Readonly<{ apiKey: string; model: string }>, client?: OpenAI) {
    if (!config.apiKey) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_API_KEY is required when DNA_TRANSCRIPTION_PROVIDER=openai.");
    if (!config.model) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_TRANSCRIBE_MODEL is required when DNA_TRANSCRIPTION_PROVIDER=openai.");
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, timeout: 120_000 });
  }

  async transcribe(input: Parameters<CreativeDnaTranscriber["transcribe"]>[0]): Promise<CreativeDnaTranscription> {
    const response = await this.client.audio.transcriptions.create({
      file: await toFile(input.bytes, input.fileName, { type: input.mimeType }),
      model: this.config.model,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });
    const segments = (response.segments ?? [])
      .filter((segment) => segment.no_speech_prob <= MAX_NO_SPEECH_PROBABILITY && segment.text.trim())
      .map((segment) => ({ startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), text: segment.text.trim().slice(0, 500) }));
    return {
      provider: "openai",
      model: this.config.model,
      ...(response.language ? { language: response.language } : {}),
      text: segments.map((segment) => segment.text).join(" ").slice(0, 10_000),
      segments
    };
  }
}
