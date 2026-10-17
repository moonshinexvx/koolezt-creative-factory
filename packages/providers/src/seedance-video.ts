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

/** Versioned mapping of Koolezt scene constraints to the Seedance request. */
export const SEEDANCE_SCENE_PROMPT_VERSION = "koolezt-seedance-scene/v1";

export type SeedanceTask = Readonly<{
  id: string;
  status: string;
  message?: string;
  outputUrl?: string;
  requestId?: string;
  usage?: Readonly<Record<string, unknown>>;
}>;

export interface SeedanceTransport {
  createTask(body: Readonly<Record<string, unknown>>): Promise<SeedanceTask>;
  getTask(taskId: string): Promise<SeedanceTask>;
}

type SeedanceHttpBody = Readonly<Record<string, unknown>>;

function safeTask(task: SeedanceHttpBody): SeedanceTask {
  const id = task.id;
  const status = task.status;
  if (typeof id !== "string" || typeof status !== "string") {
    throw new DomainError("SEEDANCE_STATUS_INVALID", "Seedance returned malformed task identity or status.");
  }
  const content = task.content && typeof task.content === "object" ? task.content as Record<string, unknown> : undefined;
  const output = task.output && typeof task.output === "object" ? task.output as Record<string, unknown> : undefined;
  const url = content?.video_url ?? content?.url ?? output?.video_url ?? output?.url ?? task.video_url ?? task.url;
  return {
    id,
    status,
    ...(typeof task.message === "string" ? { message: task.message } : {}),
    ...(typeof url === "string" ? { outputUrl: url } : {}),
    ...(typeof task.request_id === "string" ? { requestId: task.request_id } : {}),
    ...(task.usage && typeof task.usage === "object" ? { usage: task.usage as Record<string, unknown> } : {})
  };
}

function providerError(status: number, raw: SeedanceHttpBody | undefined, submission: boolean): never {
  const errorValue = raw?.error;
  const errorMessage = errorValue && typeof errorValue === "object" && "message" in errorValue && typeof errorValue.message === "string" ? errorValue.message : errorValue;
  const message = String(raw?.message ?? errorMessage ?? "").toLowerCase();
  if (status === 401 || status === 403) throw new DomainError("SEEDANCE_AUTHENTICATION_FAILED", "Seedance rejected the configured API key.");
  if (status === 429) throw new DomainError(message.includes("concurr") ? "SEEDANCE_CONCURRENCY_LIMITED" : "SEEDANCE_RATE_LIMITED", "Seedance account capacity is temporarily unavailable.");
  if (status === 402 || message.includes("quota") || message.includes("credit") || message.includes("balance")) throw new DomainError("SEEDANCE_QUOTA_EXCEEDED", "Seedance account quota or balance is insufficient.");
  if (status >= 400 && status < 500) throw new DomainError("SEEDANCE_INVALID_REQUEST", "Seedance rejected the video generation request.");
  throw new DomainError(submission ? "SEEDANCE_SUBMISSION_UNKNOWN" : "SEEDANCE_UNAVAILABLE", submission
    ? "Seedance submission outcome is unknown; the paid request will not be resubmitted automatically."
    : "Seedance task status could not be checked.");
}

/** Minimal current BytePlus LAS task API client. It never retries a task creation request. */
export class HttpSeedanceTransport implements SeedanceTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://operator.las.ap-southeast-1.bytepluses.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000
  ) {
    if (!apiKey) throw new DomainError("SEEDANCE_CONFIGURATION_MISSING", "SEEDANCE_API_KEY is required when the Seedance provider is selected.");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new DomainError("SEEDANCE_CONFIGURATION_MISSING", "SEEDANCE_API_BASE_URL must use HTTPS.");
  }

  async createTask(body: Readonly<Record<string, unknown>>): Promise<SeedanceTask> {
    return this.request("/api/v1/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) }, true);
  }

  async getTask(taskId: string): Promise<SeedanceTask> {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new DomainError("SEEDANCE_STATUS_INVALID", "Seedance task ID is invalid.");
    return this.request(`/api/v1/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: "GET" }, false);
  }

  private async request(path: string, init: RequestInit, submission: boolean): Promise<SeedanceTask> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new DomainError(submission ? "SEEDANCE_SUBMISSION_UNKNOWN" : "SEEDANCE_UNAVAILABLE", submission
        ? "Seedance submission outcome is unknown; the paid request will not be resubmitted automatically."
        : "Seedance task status could not be checked.");
    }
    const parsed = await response.json().catch(() => undefined) as SeedanceHttpBody | undefined;
    if (!response.ok) providerError(response.status, parsed, submission);
    const data = parsed?.data && typeof parsed.data === "object" ? parsed.data as SeedanceHttpBody : parsed;
    if (!data) throw new DomainError("SEEDANCE_STATUS_INVALID", "Seedance returned malformed task data.");
    // Creation returns only { id } in the documented API; status is first supplied by GET.
    if (submission && typeof data.id === "string") {
      return { id: data.id, status: typeof data.status === "string" ? data.status : "submitted", ...(typeof data.request_id === "string" ? { requestId: data.request_id } : {}) };
    }
    return safeTask(data);
  }
}

function validModel(model: string): string {
  if (!/^dreamina-seedance-[a-z0-9][a-z0-9.-]*$/i.test(model)) {
    throw new DomainError("SEEDANCE_CONFIGURATION_MISSING", "SEEDANCE_VIDEO_MODEL must be a valid Seedance model slug.");
  }
  return model;
}

export function buildSeedanceScenePrompt(input: Readonly<{
  prompt: string;
  accuracyRequirements: readonly string[];
  hasReferenceImage: boolean;
}>): string {
  const requirements = input.accuracyRequirements.map((item) => item.trim()).filter(Boolean);
  return [
    input.prompt.trim(),
    "Realistic vertical mobile-ad footage. Keep the product central, motion believable, and camera movement natural.",
    input.hasReferenceImage
      ? "Preserve the supplied product's visible design, shape, artwork, spelling, numbers, names, and personalization; do not redraw product details."
      : "Do not invent product materials, dimensions, personalization options, discounts, guarantees, or shipping claims.",
    requirements.length ? `Accuracy requirements: ${requirements.join("; ")}` : ""
  ].filter(Boolean).join("\n").slice(0, 3_072);
}

export class SeedanceVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerKey = "seedance";
  readonly requiresExternalMedia = true;
  readonly defaultModel: string;
  private readonly aspectRatio: "9:16" | "16:9" | "1:1";

  constructor(
    private readonly transport: SeedanceTransport,
    config: Readonly<{ model: string; aspectRatio?: "9:16" | "16:9" | "1:1"; resolution?: string }>
  ) {
    this.defaultModel = validModel(config.model);
    this.aspectRatio = config.aspectRatio ?? "9:16";
    this.resolution = config.resolution;
  }
  private readonly resolution: string | undefined;

  async submit(input: Parameters<VideoGenerationProvider["submit"]>[0], _context: ProviderOperationContext): Promise<ProviderSubmission> {
    void _context;
    const model = validModel(input.model ?? this.defaultModel);
    // Seedance 2.5 accepts 4-30 seconds; preserve the scene's supplied duration within that provider range.
    const duration = Math.max(4, Math.min(30, Math.round(input.durationMs / 1_000)));
    const prompt = buildSeedanceScenePrompt({ prompt: input.prompt, accuracyRequirements: input.accuracyRequirements, hasReferenceImage: Boolean(input.referenceImage) });
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (input.generationMode === "IMAGE_TO_VIDEO") {
      if (!input.referenceImage) throw new DomainError("SEEDANCE_INVALID_REQUEST", "Image-to-video requires one staged reference image.");
      content.push({ type: "image_url", image_url: { url: input.referenceImage.reference.url }, role: "reference_image" });
    }
    const task = await this.transport.createTask({
      model,
      content,
      duration,
      ratio: this.aspectRatio,
      ...(this.resolution ? { resolution: this.resolution } : {}),
      watermark: false,
      generate_audio: false
    });
    return {
      providerTaskId: task.id,
      requestId: task.requestId ?? task.id,
      provider: this.providerKey,
      model,
      metadata: {
        providerStatus: task.status,
        generationMode: input.generationMode,
        promptVersion: SEEDANCE_SCENE_PROMPT_VERSION,
        durationSeconds: duration,
        aspectRatio: this.aspectRatio,
        ...(this.resolution ? { resolution: this.resolution } : {}),
        ...(task.usage ? { usage: task.usage } : {})
      }
    };
  }

  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<VideoGenerationOutput>> {
    const task = await this.transport.getTask(providerTaskId);
    const status = task.status.toLowerCase();
    if (["queued", "submitted", "waiting", "processing", "running"].includes(status)) return { state: "PROCESSING" };
    if (["failed", "cancelled", "canceled", "expired"].includes(status)) return { state: "FAILED", message: task.message ?? "Seedance video generation failed.", retryable: false };
    if (!["succeeded", "success", "completed"].includes(status)) return { state: "FAILED", message: "Seedance returned an unsupported task state.", retryable: false };
    if (!task.outputUrl) return { state: "FAILED", message: "Seedance succeeded without a usable video output.", retryable: false };
    return { state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: this.providerKey, outputId: task.id, url: task.outputUrl, metadata: { requestId: task.requestId, usage: task.usage } } };
  }
}

/** Bounded trusted-only downloader for Seedance output URLs emitted by its own task API. */
export class SeedanceOutputIngestor implements VideoOutputIngestor {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxBytes = 150 * 1024 * 1024,
    private readonly timeoutMs = 60_000,
    private readonly trustedHostSuffixes: readonly string[] = ["volces.com", "bytepluses.com"]
  ) {}

  async ingest(output: VideoGenerationOutput): Promise<MediaPayload> {
    if (output.kind === "INLINE") return output.payload;
    if (output.provider !== "seedance") throw new DomainError("SEEDANCE_OUTPUT_INVALID", "Only output from the known Seedance task may be ingested.");
    let url: URL;
    try { url = new URL(output.url); } catch { throw new DomainError("SEEDANCE_OUTPUT_INVALID", "Seedance returned an invalid output URL."); }
    const trusted = (candidate: URL) => candidate.protocol === "https:" && this.trustedHostSuffixes.some((suffix) => candidate.hostname === suffix || candidate.hostname.endsWith(`.${suffix}`));
    if (!trusted(url)) throw new DomainError("SEEDANCE_OUTPUT_INVALID", "Seedance output URL is not from a trusted HTTPS delivery host.");
    let response: Response;
    try {
      let current = url;
      response = undefined as unknown as Response;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        response = await this.fetchImpl(current, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "manual" });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("invalid redirect");
        current = new URL(location, current);
        if (!trusted(current)) throw new Error("untrusted redirect");
      }
    } catch { throw new DomainError("SEEDANCE_OUTPUT_DOWNLOAD_FAILED", "Could not download the completed Seedance video."); }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || (length > 0 && length > this.maxBytes) || !response.body) throw new DomainError("SEEDANCE_OUTPUT_DOWNLOAD_FAILED", "Seedance output download was rejected or exceeds the configured limit.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > this.maxBytes) throw new DomainError("SEEDANCE_OUTPUT_DOWNLOAD_FAILED", "Seedance output exceeds the configured limit."); chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    if (!total) throw new DomainError("SEEDANCE_OUTPUT_DOWNLOAD_FAILED", "Seedance output is empty.");
    const bytes = new Uint8Array(total); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return { bytes, mimeType: "video/mp4", extension: "mp4", metadata: { provider: "seedance", outputId: output.outputId, providerMetadata: output.metadata } };
  }
}
