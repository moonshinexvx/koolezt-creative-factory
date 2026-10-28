import { describe, expect, it, vi } from "vitest";
import { OpenAISceneImageProvider } from "@koolezt/providers";

describe("OpenAI scene images", () => {
  it("sends the product photo as the reference with high fidelity and returns the image bytes", async () => {
    const edit = vi.fn(async () => ({ data: [{ b64_json: Buffer.from("jpeg-bytes").toString("base64") }] }));
    const provider = new OpenAISceneImageProvider({ apiKey: "test", model: "gpt-image-1.5", quality: "medium", size: "1024x1536" }, { images: { edit } });
    const image = await provider.generate({ prompt: "Use the attached product photo as the exact product.", referenceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }] });
    expect(Buffer.from(image.bytes).toString()).toBe("jpeg-bytes");
    expect(image).toMatchObject({ mimeType: "image/jpeg", extension: "jpg", model: "gpt-image-1.5" });
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-1.5", prompt: "Use the attached product photo as the exact product.", size: "1024x1536", quality: "medium", input_fidelity: "high", n: 1, image: [expect.anything()] }));
  });

  it("leaves out input fidelity for gpt-image-2", async () => {
    const edit = vi.fn(async () => ({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }));
    await new OpenAISceneImageProvider({ apiKey: "test", model: "gpt-image-2" }, { images: { edit } }).generate({ prompt: "p", referenceImages: [{ bytes: new Uint8Array([1]), mimeType: "image/jpeg" }] });
    expect((edit.mock.calls[0] as unknown[])[0]).not.toHaveProperty("input_fidelity");
  });

  it("leaves out input fidelity for the mini model and explains failures", async () => {
    const edit = vi.fn(async () => { throw Object.assign(new Error("Your organization must be verified"), { status: 403 }); });
    const provider = new OpenAISceneImageProvider({ apiKey: "test", model: "gpt-image-1-mini" }, { images: { edit } });
    await expect(provider.generate({ prompt: "p", referenceImages: [{ bytes: new Uint8Array([1]), mimeType: "image/jpeg" }] })).rejects.toMatchObject({ code: "SCENE_IMAGE_FAILED", message: expect.stringContaining("(403)") });
    expect((edit.mock.calls[0] as unknown[])[0]).not.toHaveProperty("input_fidelity");
  });
});
