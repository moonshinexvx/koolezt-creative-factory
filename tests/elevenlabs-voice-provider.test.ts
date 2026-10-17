import { describe, expect, it } from "vitest";
import { ElevenLabsVoiceProvider, normalizeElevenLabsAlignment } from "@koolezt/providers";

describe("ElevenLabs voice provider", () => {
  it("uses timestamp TTS and normalizes character timing", async () => {
    let url = ""; let request: RequestInit | undefined;
    const provider = new ElevenLabsVoiceProvider({ apiKey: "test", modelId: "model", outputFormat: "mp3_44100_128", profiles: { warm: { providerVoiceId: "voice", settings: { stability: 0.5 } } }, fetch: async (value, init) => { url = String(value); request = init; return new Response(JSON.stringify({ audio_base64: Buffer.from("audio").toString("base64"), alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } }), { status: 200, headers: { "request-id": "req_1" } }); } });
    const submitted = await provider.submit({ voiceProfileId: "warm", script: "Hi" }, { operationKey: "voice:1", projectId: "project", targetId: "voice" });
    expect(url).toContain("/voice/with-timestamps"); expect(String(request?.body)).toContain("model");
    const completed = await provider.getStatus(submitted.providerTaskId);
    expect(completed.state).toBe("SUCCEEDED");
    if (completed.state === "SUCCEEDED") expect(completed.result.metadata.captionTimings).toEqual([{ text: "Hi", startMs: 0, endMs: 200 }]);
  });
  it("rejects malformed timing and maps auth errors", async () => {
    expect(() => normalizeElevenLabsAlignment({ characters: ["a"], character_start_times_seconds: [], character_end_times_seconds: [] })).toThrow(/malformed/);
    const provider = new ElevenLabsVoiceProvider({ apiKey: "test", modelId: "model", outputFormat: "mp3_44100_128", profiles: { voice: { providerVoiceId: "voice" } }, fetch: async () => new Response("no", { status: 401 }) });
    await expect(provider.submit({ voiceProfileId: "voice", script: "Hi" }, { operationKey: "voice:1", projectId: "project", targetId: "voice" })).rejects.toThrow(/authentication/);
  });
});
