import { DomainError } from "@koolezt/domain";
import type {
  CaptionTiming,
  CompositionMediaInput,
  CompositionOutput,
  CompositionOutputIngestor,
  CompositionProvider,
  MediaPayload,
  ProviderJobStatus,
  ProviderOperationContext,
  ProviderSubmission,
  RenderInputSnapshot
} from "@koolezt/domain";

export const KOOLEZT_UGC_FAST_TEMPLATE_VERSION = "koolezt-ugc-fast/v1";

type JsonObject = Record<string, unknown>;
export type CreatomateRender = Readonly<{
  id: string;
  status: string;
  url?: string;
  error_message?: string;
  output_format?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
}>;

export interface CreatomateTransport {
  createRender(script: JsonObject, operationKey: string): Promise<CreatomateRender>;
  getRender(renderId: string): Promise<CreatomateRender>;
}

function seconds(milliseconds: number): number { return Number((milliseconds / 1_000).toFixed(3)); }
function captions(timings: readonly CaptionTiming[]): JsonObject[] {
  return timings.map((timing) => ({ time: seconds(timing.startMs), duration: seconds(Math.max(0, timing.endMs - timing.startMs)), value: timing.text }));
}

/** Repository-owned RenderScript for the first controlled vertical-ad style. */
export function buildKooleztUgcFastRenderScript(input: Readonly<{
  snapshot: RenderInputSnapshot;
  scenes: readonly CompositionMediaInput[];
  narration: CompositionMediaInput;
  music?: CompositionMediaInput;
  logo?: CompositionMediaInput;
}>): JsonObject {
  if (input.scenes.length !== input.snapshot.sceneInputs.length) {
    throw new DomainError("CREATOMATE_RENDER_INVALID", "The render snapshot and staged scenes do not match.");
  }
  let offsetMs = 0;
  const sceneElements = input.scenes.map((scene, index) => {
    const durationMs = input.snapshot.sceneInputs[index]?.intendedDurationMs
      ?? Math.floor(input.snapshot.target.durationMs / input.scenes.length);
    const element: JsonObject = {
      name: `Scene-${index + 1}`,
      type: scene.mimeType.startsWith("image/") ? "image" : "video",
      source: scene.reference.url,
      track: 1,
      time: seconds(offsetMs),
      duration: seconds(Math.max(1, durationMs)),
      width: "100%",
      height: "100%",
      fit: "cover"
    };
    offsetMs += durationMs;
    return element;
  });
  const overlayElements = input.snapshot.marketingOverlays.slice(0, input.scenes.length).map((text, index) => ({
    name: `Marketing-Overlay-${index + 1}`,
    type: "text",
    text,
    track: 3,
    time: seconds(Math.floor(index * input.snapshot.target.durationMs / input.scenes.length)),
    duration: seconds(Math.ceil(input.snapshot.target.durationMs / input.scenes.length)),
    x: "50%", y: "16%", width: "86%", height: "14%",
    x_alignment: "50%", y_alignment: "50%",
    fill_color: "#ffffff", stroke_color: "#000000", stroke_width: "0.8 vmin",
    font_family: "Montserrat", font_weight: "700", font_size: "7 vmin"
  }));
  const elements: JsonObject[] = [
    ...sceneElements,
    { name: "Narration", type: "audio", source: input.narration.reference.url, track: 2, time: 0, duration: seconds(input.snapshot.target.durationMs), volume: "100%" },
    ...(input.music ? [{ name: "Music", type: "audio", source: input.music.reference.url, track: 2, time: 0, duration: seconds(input.snapshot.target.durationMs), volume: "16%" }] : []),
    ...overlayElements,
    {
      name: "Narration-Captions", type: "text", track: 4, y: "72%", width: "84%", height: "18%",
      x_alignment: "50%", y_alignment: "50%", fill_color: "#ffffff", stroke_color: "#000000", stroke_width: "1.2 vmin",
      font_family: "Montserrat", font_weight: "700", font_size: "6.2 vmin", transcript_effect: "highlight",
      transcript_maximum_length: 14, transcript_source: captions(input.snapshot.narration.captionTimings)
    },
    {
      name: "CTA", type: "text", track: 5, text: input.snapshot.cta,
      time: seconds(Math.max(0, input.snapshot.target.durationMs - 4_000)), duration: 4,
      y: "89%", width: "84%", height: "8%", x_alignment: "50%", y_alignment: "50%",
      fill_color: "#ffffff", background_color: "#e95b28", background_x_padding: "10%", background_y_padding: "18%",
      background_border_radius: "12%", font_family: "Montserrat", font_weight: "700", font_size: "5.5 vmin"
    },
    ...(input.logo ? [{ name: "Logo", type: "image", source: input.logo.reference.url, track: 5, time: 0, duration: seconds(input.snapshot.target.durationMs), x: "88%", y: "7%", width: "14%", height: "8%", fit: "contain" }] : [])
  ];
  return { output_format: "mp4", width: input.snapshot.target.width, height: input.snapshot.target.height, frame_rate: 30, duration: seconds(input.snapshot.target.durationMs), elements };
}

export class HttpCreatomateTransport implements CreatomateTransport {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {
    if (!apiKey) throw new DomainError("CREATOMATE_CONFIGURATION_MISSING", "CREATOMATE_API_KEY is required when COMPOSITION_PROVIDER=creatomate.");
  }
  async createRender(script: JsonObject, operationKey: string): Promise<CreatomateRender> {
    return this.request("https://api.creatomate.com/v2/renders", { method: "POST", body: JSON.stringify({ ...script, metadata: operationKey }) });
  }
  async getRender(renderId: string): Promise<CreatomateRender> {
    if (!/^[a-zA-Z0-9-]+$/.test(renderId)) throw new DomainError("CREATOMATE_STATUS_INVALID", "Creatomate render ID is invalid.");
    return this.request(`https://api.creatomate.com/v2/renders/${encodeURIComponent(renderId)}`, { method: "GET" });
  }
  private async request(url: string, init: RequestInit): Promise<CreatomateRender> {
    let response: Response;
    try { response = await this.fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new DomainError("CREATOMATE_UNAVAILABLE", "Creatomate could not be reached."); }
    const body = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new DomainError("CREATOMATE_AUTHENTICATION_FAILED", "Creatomate rejected the configured API key.");
      if (response.status === 429) throw new DomainError("CREATOMATE_RATE_LIMITED", "Creatomate rate limit reached.");
      if (response.status >= 400 && response.status < 500) throw new DomainError("CREATOMATE_RENDER_INVALID", "Creatomate rejected the render request.");
      throw new DomainError("CREATOMATE_UNAVAILABLE", "Creatomate returned a server error.");
    }
    const render = Array.isArray(body) ? body[0] : body;
    if (!render || typeof render !== "object" || typeof (render as { id?: unknown }).id !== "string" || typeof (render as { status?: unknown }).status !== "string") throw new DomainError("CREATOMATE_STATUS_INVALID", "Creatomate returned an invalid render response.");
    return render as CreatomateRender;
  }
}

export class CreatomateCompositionProvider implements CompositionProvider {
  constructor(private readonly transport: CreatomateTransport) {}
  async submit(input: Parameters<CompositionProvider["submit"]>[0], context: ProviderOperationContext): Promise<ProviderSubmission> {
    if (input.snapshot.templateVersion !== KOOLEZT_UGC_FAST_TEMPLATE_VERSION) throw new DomainError("CREATOMATE_RENDER_INVALID", `Unsupported composition style: ${input.snapshot.templateVersion}.`);
    const render = await this.transport.createRender(buildKooleztUgcFastRenderScript({ snapshot: input.snapshot, scenes: input.sceneAssets, narration: input.narration, ...(input.music ? { music: input.music } : {}), ...(input.logo ? { logo: input.logo } : {}) }), context.operationKey);
    return { providerTaskId: render.id, requestId: render.id, provider: "creatomate", model: KOOLEZT_UGC_FAST_TEMPLATE_VERSION, metadata: { renderStatus: render.status, templateVersion: KOOLEZT_UGC_FAST_TEMPLATE_VERSION } };
  }
  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<CompositionOutput>> {
    const render = await this.transport.getRender(providerTaskId);
    if (["planned", "waiting", "transcribing", "rendering"].includes(render.status)) return { state: "PROCESSING" };
    if (render.status === "failed") return { state: "FAILED", message: render.error_message ?? "Creatomate render failed.", retryable: false };
    if (render.status !== "succeeded" || !render.url) return { state: "FAILED", message: "Creatomate returned an invalid terminal render state.", retryable: false };
    return { state: "SUCCEEDED", result: { kind: "TRUSTED_REMOTE", provider: "creatomate", outputId: render.id, url: render.url, metadata: { outputFormat: render.output_format, width: render.width, height: render.height, duration: render.duration, fileSize: render.file_size } } };
  }
}

export class CreatomateOutputIngestor implements CompositionOutputIngestor {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly maxBytes = 250 * 1024 * 1024, private readonly timeoutMs = 60_000) {}
  async ingest(output: CompositionOutput): Promise<MediaPayload> {
    if (output.kind !== "TRUSTED_REMOTE" || output.provider !== "creatomate") throw new DomainError("CREATOMATE_OUTPUT_INVALID", "Only a Creatomate result for the known render may be ingested.");
    let url: URL;
    try { url = new URL(output.url); }
    catch { throw new DomainError("CREATOMATE_OUTPUT_INVALID", "Creatomate returned an invalid output URL."); }
    if (url.protocol !== "https:" || !/(^|\.)creatomate\.com$/i.test(url.hostname)) throw new DomainError("CREATOMATE_OUTPUT_INVALID", "Creatomate output URL is not a trusted HTTPS delivery URL.");
    let response: Response;
    try { response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" }); }
    catch { throw new DomainError("CREATOMATE_OUTPUT_DOWNLOAD_FAILED", "Could not download the completed Creatomate render."); }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || (length && length > this.maxBytes)) throw new DomainError("CREATOMATE_OUTPUT_DOWNLOAD_FAILED", "Creatomate output download was rejected or exceeds the configured limit.");
    const reader = response.body?.getReader();
    if (!reader) throw new DomainError("CREATOMATE_OUTPUT_DOWNLOAD_FAILED", "Creatomate output has no readable body.");
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.maxBytes) throw new DomainError("CREATOMATE_OUTPUT_DOWNLOAD_FAILED", "Creatomate output exceeds the configured limit.");
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (!total) throw new DomainError("CREATOMATE_OUTPUT_DOWNLOAD_FAILED", "Creatomate output is empty.");
    const bytes = new Uint8Array(total); let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return { bytes, mimeType: "video/mp4", extension: "mp4", metadata: { provider: "creatomate", outputId: output.outputId, providerMetadata: output.metadata } };
  }
}
