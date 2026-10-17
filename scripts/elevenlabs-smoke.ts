import { ElevenLabsVoiceProvider } from "@koolezt/providers";
if (process.env.VOICE_PROVIDER !== "elevenlabs" || process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true") throw new Error("Refusing paid smoke test: set VOICE_PROVIDER=elevenlabs and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
const profiles = JSON.parse(process.env.ELEVENLABS_VOICE_PROFILES_JSON ?? "{}") as Record<string, { providerVoiceId: string; modelId?: string; settings?: Record<string, unknown> }>;
const profileId = Object.keys(profiles)[0];
if (!profileId) throw new Error("Configure at least one ElevenLabs voice profile.");
const provider = new ElevenLabsVoiceProvider({ apiKey: process.env.ELEVENLABS_API_KEY ?? "", modelId: process.env.ELEVENLABS_MODEL_ID ?? "", outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT ?? "", profiles });
const submitted = await provider.submit({ voiceProfileId: profileId, script: "This is a short Koolezt narration test." }, { operationKey: `smoke:${Date.now()}`, projectId: "smoke", targetId: "voice" });
console.log(JSON.stringify({ provider: submitted.provider, model: submitted.model, requestId: submitted.requestId }));
