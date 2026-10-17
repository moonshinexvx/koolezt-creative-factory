import { describe, expect, it } from "vitest";
import { OpenAIVoiceProvider } from "@koolezt/providers";

function client(response: Response, requestId = "req_tts_1") {
  let request: object | undefined;
  return {
    client: { audio: { speech: { create: (input: unknown) => { request = input as object; return { withResponse: async () => ({ data: response, request_id: requestId }) }; } } } },
    request: () => request
  };
}

describe("OpenAI voice provider", () => {
  const context = { operationKey: "voice:1", projectId: "project", targetId: "voice" };

  it("maps configurable TTS model, voice, style, and audio without invented word timing", async () => {
    const fake = client(new Response(new Uint8Array([1, 2, 3])));
    const provider = new OpenAIVoiceProvider({ apiKey: "test", model: "gpt-4o-mini-tts", voice: "marin", outputFormat: "mp3", instructions: "Friendly." }, fake.client);
    const submission = await provider.submit({ voiceProfileId: "female-ugc", script: "Hello there." }, context);
    expect(fake.request()).toMatchObject({ model: "gpt-4o-mini-tts", voice: "marin", input: "Hello there.", response_format: "mp3", instructions: "Friendly." });
    expect(submission).toMatchObject({ provider: "openai", model: "gpt-4o-mini-tts", requestId: "req_tts_1" });
    const result = await provider.getStatus(submission.providerTaskId);
    expect(result.state).toBe("SUCCEEDED");
    if (result.state === "SUCCEEDED") {
      expect(result.result).toMatchObject({ mimeType: "audio/mpeg", extension: "mp3" });
      expect(result.result.metadata.captionTimings).toEqual([]);
      expect(result.result.metadata.nativeWordTimings).toBe(false);
    }
  });

  it("uses an explicitly selected supported voice for a variant package", async () => {
    const fake = client(new Response(new Uint8Array([1, 2, 3])));
    const provider = new OpenAIVoiceProvider({ apiKey: "test", model: "gpt-4o-mini-tts", voice: "marin" }, fake.client);
    const submission = await provider.submit({ voiceProfileId: "cedar", script: "A distinct package narration." }, context);
    expect(fake.request()).toMatchObject({ voice: "cedar", input: "A distinct package narration." });
    const result = await provider.getStatus(submission.providerTaskId);
    if (result.state === "SUCCEEDED") expect(result.result.metadata).toMatchObject({ voiceProfileId: "cedar", voice: "cedar" });
  });
  it("does not retry a transport failure whose paid submission outcome is unknown", async () => {
    let calls = 0;
    const provider = new OpenAIVoiceProvider({ apiKey: "test", model: "gpt-4o-mini-tts", voice: "marin" }, { audio: { speech: { create: () => { calls += 1; return { withResponse: async () => { throw new Error("network lost"); } }; } } } });
    await expect(provider.submit({ voiceProfileId: "voice", script: "Hello." }, context)).rejects.toMatchObject({ code: "OPENAI_TTS_SUBMISSION_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("maps authentication and requires explicit configuration", async () => {
    expect(() => new OpenAIVoiceProvider({ apiKey: "", model: "gpt-4o-mini-tts", voice: "marin" })).toThrow(/OPENAI_API_KEY/);
    const provider = new OpenAIVoiceProvider(
      { apiKey: "test", model: "gpt-4o-mini-tts", voice: "marin" },
      { audio: { speech: { create: () => ({ withResponse: async () => { throw Object.assign(new Error("denied"), { status: 401 }); } }) } } }
    );
    await expect(provider.submit({ voiceProfileId: "voice", script: "Hello." }, context)).rejects.toMatchObject({ code: "OPENAI_AUTHENTICATION_FAILED" });
  });
});
