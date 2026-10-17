import { createHash } from "node:crypto";
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

export const KLING_SCENE_PROMPT_VERSION = "koolezt-kling-scene/v1";

export type KlingTask = Readonly<{
  id: string;
  status: string;
  message?: string;
  outputs?: readonly Readonly<{ type?: string; id?: string; url?: string; duration?: string }>[];
  billing?: readonly Readonly<Record<string, unknown>>[];
  requestId?: string;
}>;

export interface KlingTransport {
  createTask(path: string, body: Readonly<Record<string, unknown>>): Promise<KlingTask>;
  getTask(taskId: string): Promise<KlingTask>;
}

export function buildKlingScenePrompt(input: Readonly<{
  prompt: string;
  accuracyRequirements: readonly string[];
  hasReferenceImage: boolean;
}>): string {
  const accuracy = input.accuracyRequirements.map((item) => item.trim()).filter(Boolean);
  return [
    input.prompt.trim(),
    "Realistic vertical mobile-ad footage. Keep the product central, motion believable, and camera movement natural.",
    input.hasReferenceImage
      ? "Preserve the supplied product's exact visible design, shape, artwork, spelling, numbers, names, and personalization; do not replace or redraw product details."
      : "Do not invent product materials, dimensions, personalization options, discounts, guarantees, or shipping claims.",
    accuracy.length ? `Accuracy requirements: ${accuracy.join("; ")}` : ""
  ].filter(Boolean).join("\n").slice(0, 3_072);
}

function externalTaskId(operationKey: string): string {
  return `koolezt-${createHash("sha256").update(operationKey).digest("hex").slice(0, 32)}`;
}

function validModel(model: string): string {
  if (!/^kling-[a-z0-9][a-z0-9.-]*$/i.test(model)) {
    throw new DomainError("KLING_CONFIGURATION_MISSING", "KLING_VIDEO_MODEL must be a valid current Kling model slug.");
  }
  return model;
}

export class HttpKlingTransport implements KlingTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api-singapore.klingai.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000
  ) {
    if (!apiKey) throw new DomainError("KLING_CONFIGURATION_MISSING", "KLING_API_KEY is required when VIDEO_PROVIDER=kling.");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new DomainError("KLING_CONFIGURATION_MISSING", "KLING_API_BASE_URL must use HTTPS.");
  }

  async createTask(path: string, body: Readonly<Record<string, unknown>>): Promise<KlingTask> {
    return this.request(`${this.baseUrl.replace(/\/$/, "")}${path}`, { method: "POST", body: JSON.stringify(body) }, true);
  }

  async getTask(taskId: string): Promise<KlingTask> {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new DomainError("KLING_STATUS_INVALID", "Kling task ID is invalid.");
    const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/tasks?task_ids=${encodeURIComponent(taskId)}`, { method: "GET" }, false);
    return response;
  }

  private async request(url: string, init: RequestInit, submission: boolean): Promise<KlingTask> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new DomainError(submission ? "KLING_SUBMISSION_UNKNOWN" : "KLING_UNAVAILABLE", submission
        ? "Kling submission outcome is unknown; the paid request will not be resubmitted automatically."
        : "Kling task status could not be checked.");
    }
    const body = await response.json().catch(() => undefined) as { code?: unknown; message?: unknown; request_id?: unknown; data?: unknown } | undefined;
    if (!response.ok || (typeof body?.code === "number" && body.code !== 0)) {
      const message = String(body?.message ?? "").toLowerCase();
      if (response.status === 401 || response.status === 403) throw new DomainError("KLING_AUTHENTICATION_FAILED", "Kling rejected the configured API key.");
      if (response.status === 429) throw new DomainError(message.includes("concurr") ? "KLING_CONCURRENCY_LIMITED" : "KLING_RATE_LIMITED", "Kling account capacity is temporarily unavailable.");
      if (response.status === 402 || message.includes("quota") || message.includes("balance") || message.includes("credit")) throw new DomainError("KLING_QUOTA_EXCEEDED", "Kling account quota or balance is insufficient.");
      if (response.status >= 400 && response.status < 500) throw new DomainError("KLING_INVALID_REQUEST", "Kling rejected the video generation request.");
      throw new DomainError("KLING_UNAVAILABLE", "Kling returned a temporary provider error.");
    }
    const raw = Array.isArray(body?.data) ? body.data[0] : body?.data;
    if (!raw || typeof raw !== "object") throw new DomainError("KLING_STATUS_INVALID", "Kling returned malformed task data.");
    const value = raw as Record<string, unknown>;
    const id = value.id;
    const status = value.status;
    if (typeof id !== "string" || typeof status !== "string") throw new DomainError("KLING_STATUS_INVALID", "Kling returned malformed task identity or status.");
    return {
      id,
      status,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(Array.isArray(value.outputs) ? { outputs: value.outputs as NonNullable<KlingTask["outputs"]> } : {}),
      ...(Array.isArray(value.billing) ? { billing: value.billing as NonNullable<KlingTask["billing"]> } : {}),
      ...(typeof body?.request_id === "string" ? { requestId: body.request_id } : {})
    };
  }
}

export class KlingVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerKey = "kling";
  readonly defaultModel: string;
  readonly requiresExternalMedia = true;
  private readonly model: string;
  constructor(
    private readonly transport: KlingTransport,
    config: Readonly<{ model: string; resolution?: "720p" | "1080p"; aspectRatio?: "16:9" | "9:16" | "1:1" }> 
  ) {
    this.model = validModel(config.model);
    this.defaultModel = this.model;
    this.resolution = config.resolution ?? "720p";
    this.aspectRatio = config.aspectRatio ?? "9:16";
  }
  private readonly resolution: "720p" | "1080p";
  private readonly aspectRatio: "16:9" | "9:16" | "1:1";

  async submit(input: Parameters<VideoGenerationProvider["submit"]>[0], context: ProviderOperationContext): Promise<ProviderSubmission> {
    const model = validModel(input.model ?? this.model);
    const duration = Math.max(3, Math.min(15, Math.round(input.durationMs / 1_000)));
    const prompt = buildKlingScenePrompt({ prompt: input.prompt, accuracyRequirements: input.accuracyRequirements, hasReferenceImage: Boolean(input.referenceImage) });
    const options = { external_task_id: externalTaskId(context.operationKey), watermark_info: { enabled: false } };
    let path: string;
    let body: Readonly<Record<string, unknown>>;
    if (input.generationMode === "IMAGE_TO_VIDEO") {
      if (!input.referenceImage) throw new DomainError("KLING_INVALID_REQUEST", "Image-to-video requires one staged reference image.");
      path = `/image-to-video/${model}`;
      body = {
        contents: [{ type: "image", url: input.referenceImage.reference.url }, { type: "text", text: prompt }],
        settings: { resolution: this.resolution, duration },
        options
      };
    } else {
      path = `/text-to-video/${model}`;
      body = { prompt, settings: { resolution: this.resolution, aspect_ratio: this.aspectRatio, duration }, options };
    }
    const task = await this.transport.createTask(path, body);
    return {
      providerTaskId: task.id,
      requestId: task.requestId ?? task.id,
      provider: "kling",
      model,
      metadata: { providerStatus: task.status, generationMode: input.generationMode, promptVersion: KLING_SCENE_PROMPT_VERSION, durationSeconds: duration, resolution: this.resolution, aspectRatio: this.aspectRatio, externalTaskId: options.external_task_id }
    };
  }

  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<VideoGenerationOutput>> {
    const task = await this.transport.getTask(providerTaskId);
    if (task.status === "submitted" || task.status === "processing") return { state: "PROCESSING" };
    if (task.status === "failed") return { state: "FAILED", message: task.message ?? "Kling video generation failed.", retryable: false };
    if (task.status !== "succeeded") return { state: "FAILED", message: "Kling returned an unsupported task state.", retryable: false };
    const video = task.outputs?.find((output) => output.type === "video" && typeof output.url === "string");
    if (!video?.url) return { state: "FAILED", message: "Kling succeeded without a usable video output.", retryable: false };
    return { state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: "kling", outputId: video.id ?? task.id, url: video.url, metadata: { duration: video.duration, billing: task.billing, requestId: task.requestId } } };
  }
}

export class KlingOutputIngestor implements VideoOutputIngestor {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxBytes = 150 * 1024 * 1024,
    private readonly timeoutMs = 60_000,
    private readonly trustedHostSuffixes: readonly string[] = ["klingai.com"]
  ) {}
  async ingest(output: VideoGenerationOutput): Promise<MediaPayload> {
    if (output.kind === "INLINE") return output.payload;
    if (output.provider !== "kling") throw new DomainError("KLING_OUTPUT_INVALID", "Only output from the known Kling task may be ingested.");
    let url: URL;
    try { url = new URL(output.url); } catch { throw new DomainError("KLING_OUTPUT_INVALID", "Kling returned an invalid output URL."); }
    if (url.protocol !== "https:" || !this.trustedHostSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) {
      throw new DomainError("KLING_OUTPUT_INVALID", "Kling output URL is not from a trusted HTTPS delivery host.");
    }
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
        if (current.protocol !== "https:" || !this.trustedHostSuffixes.some((suffix) => current.hostname === suffix || current.hostname.endsWith(`.${suffix}`))) throw new Error("untrusted redirect");
      }
    } catch { throw new DomainError("KLING_OUTPUT_DOWNLOAD_FAILED", "Could not download the completed Kling video."); }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || (length > 0 && length > this.maxBytes) || !response.body) throw new DomainError("KLING_OUTPUT_DOWNLOAD_FAILED", "Kling output download was rejected or exceeds the configured limit.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > this.maxBytes) throw new DomainError("KLING_OUTPUT_DOWNLOAD_FAILED", "Kling output exceeds the configured limit."); chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    if (!total) throw new DomainError("KLING_OUTPUT_DOWNLOAD_FAILED", "Kling output is empty.");
    const bytes = new Uint8Array(total); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return { bytes, mimeType: "video/mp4", extension: "mp4", metadata: { provider: "kling", outputId: output.outputId, providerMetadata: output.metadata } };
  }
}
