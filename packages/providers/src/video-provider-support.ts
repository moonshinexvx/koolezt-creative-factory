import { DomainError } from "@koolezt/domain";
import type {
  MediaPayload,
  ProviderJobStatus,
  ProviderOperationContext,
  ProviderSubmission,
  VideoGenerationOutput,
  VideoGenerationProvider,
  VideoOutputIngestor
} from "@koolezt/domain";

/** Keeps selectable real providers safe when their server-side configuration is incomplete. */
export class UnavailableVideoGenerationProvider implements VideoGenerationProvider {
  readonly requiresExternalMedia = true;

  constructor(
    readonly providerKey: string,
    readonly defaultModel: string,
    private readonly errorCode: string,
    private readonly safeMessage: string
  ) {}

  async submit(_input: Parameters<VideoGenerationProvider["submit"]>[0], _context: ProviderOperationContext): Promise<ProviderSubmission> {
    void _input;
    void _context;
    throw new DomainError(this.errorCode, this.safeMessage);
  }

  async getStatus(_providerTaskId: string): Promise<ProviderJobStatus<VideoGenerationOutput>> {
    void _providerTaskId;
    return { state: "FAILED", message: this.safeMessage, retryable: false };
  }
}

/** Routes trusted output only to an ingestor registered for its provider key. */
export class RoutedVideoOutputIngestor implements VideoOutputIngestor {
  constructor(
    private readonly inlineIngestor: VideoOutputIngestor,
    private readonly ingestors: Readonly<Record<string, VideoOutputIngestor>>
  ) {}

  async ingest(output: VideoGenerationOutput): Promise<MediaPayload> {
    if (output.kind === "INLINE") return this.inlineIngestor.ingest(output);
    const ingestor = this.ingestors[output.provider];
    if (!ingestor) throw new DomainError("VIDEO_OUTPUT_INVALID", "No trusted output ingestor is configured for this video provider.");
    return ingestor.ingest(output);
  }
}
