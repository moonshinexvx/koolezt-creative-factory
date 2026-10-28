import OpenAI, { toFile } from "openai";
import { DomainError } from "@koolezt/domain";
import type { SceneImageProvider } from "@koolezt/domain";

type OpenAIImageClient = Readonly<{
  images: Readonly<{ edit: (input: Parameters<OpenAI["images"]["edit"]>[0]) => Promise<Readonly<{ data?: readonly Readonly<{ b64_json?: string }>[] }>> }>;
}>;

type OpenAISceneImageConfig = Readonly<{ apiKey: string; model?: string; quality?: string; size?: string; timeoutMs?: number }>;

/**
 * Makes one vertical scene image from the product photo and a scene prompt with OpenAI's image edit endpoint.
 * The product photo is sent as the reference image; high input fidelity asks the model to keep the product's look.
 */
export class OpenAISceneImageProvider implements SceneImageProvider {
  private readonly client: OpenAIImageClient;
  readonly model: string;

  constructor(private readonly config: OpenAISceneImageConfig, client?: OpenAIImageClient) {
    if (!config.apiKey) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_API_KEY is required for AI scene images.");
    this.model = config.model || "gpt-image-2";
    this.client = client ?? (new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs ?? 240_000 }) as unknown as OpenAIImageClient);
  }

  async generate(input: Parameters<SceneImageProvider["generate"]>[0]): Promise<Awaited<ReturnType<SceneImageProvider["generate"]>>> {
    const references = await Promise.all(input.referenceImages.map((image, index) => toFile(image.bytes, `product-${index + 1}.${image.mimeType.split("/")[1] ?? "png"}`, { type: image.mimeType })));
    let response: Awaited<ReturnType<OpenAIImageClient["images"]["edit"]>>;
    try {
      response = await this.client.images.edit({
        model: this.model,
        image: references,
        prompt: input.prompt,
        size: (this.config.size || "1024x1536") as "1024x1536",
        quality: (this.config.quality || "medium") as "medium",
        output_format: "jpeg",
        output_compression: 92,
        n: 1,
        // Only gpt-image-1 and gpt-image-1.5 accept input fidelity (gpt-image-2 and the mini model reject it with a 400).
        ...(/^gpt-image-1(\.5)?(-\d{4}-\d{2}-\d{2})?$/.test(this.model) ? { input_fidelity: "high" as const } : {})
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : "unknown error";
      throw new DomainError("SCENE_IMAGE_FAILED", `OpenAI could not make the scene image${status ? ` (${status})` : ""}: ${message.slice(0, 300)}`);
    }
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new DomainError("SCENE_IMAGE_FAILED", "OpenAI returned no image.");
    return { bytes: new Uint8Array(Buffer.from(encoded, "base64")), mimeType: "image/jpeg", extension: "jpg", model: this.model };
  }
}

/** Returns a fixed image without any network call; used by tests and local runs without an OpenAI key. */
export class FakeSceneImageProvider implements SceneImageProvider {
  readonly model = "fake-scene-image";
  readonly prompts: string[] = [];
  constructor(private readonly image: Readonly<{ bytes: Uint8Array; mimeType: string; extension: string }>) {}
  async generate(input: Parameters<SceneImageProvider["generate"]>[0]) {
    this.prompts.push(input.prompt);
    return { ...this.image, model: this.model };
  }
}
