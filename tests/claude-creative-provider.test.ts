import { describe, expect, it, vi } from "vitest";
import { ClaudeCreativeProvider, schemaViolation, toClaudeSchema } from "@koolezt/providers";
import type { CreativeDnaAnalysisInput, StrategyGenerationInput } from "@koolezt/domain";

const input = { productName: "Example", description: "Description", defaultCta: "Create yours", creativeNotes: "Keep it accurate", claims: [{ kind: "FEATURE" as const, text: "Feature" }, { kind: "RESTRICTION" as const, text: "Do not invent options" }], selectedAssets: [{ id: "asset-1", kind: "IMAGE" as const, label: "Mockup", mimeType: "image/png" }], additionalInstructions: "Warm UGC" };
const concept = { angle: "Angle", hook: "Hook", targetDurationMs: 15_000, voiceScript: "Script", cta: "CTA", editingStyleKey: "UGC_FAST/v1", musicCategory: "UGC upbeat", scenes: [1, 2, 3].map((sceneNumber) => ({ sceneNumber, intendedDurationMs: 5_000, purpose: `Scene ${sceneNumber}`, sourceType: "PRODUCT_IMAGE" as const, generationPrompt: "Show the exact mockup", overlayText: "LOOK", referenceAssetIds: ["asset-1"], accuracyRequirements: ["Do not invent options"] })) };
const context = { operationKey: "concept:project:revision:1:generate", projectId: "project", targetId: "concept-1" };
const strategyConcept = (ordinal: number) => ({ ordinal, conceptName: `Concept ${ordinal}`, conceptFamily: "Demo", buyerPersona: "Homeowner", customerDesireOrProblem: "Desire", awarenessLevel: "Product-aware", coreAngle: "Angle", emotionalTerritory: "Pride", primaryPromise: "Promise", hook: "Hook", openingVisualPattern: "Product first", creativeFormat: "Demo", primaryProductionMethod: "AI_LIFESTYLE", supportingProductionMethods: [], proofMechanism: "Visual", offerFraming: "Make it yours", ctaStrategy: "Invite", differentiationSummary: "Different", creativeVisualExecutionNotes: "Notes", ugcRepresentation: "NOT_APPLICABLE" });

function message(output: unknown, overrides: Record<string, unknown> = {}) {
  return { id: "msg_1", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, content: [{ type: "thinking", thinking: "" }, { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }], usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...overrides };
}
function clientReturning(result: unknown | (() => Promise<unknown>)) {
  const requests: Record<string, unknown>[] = [];
  const stream = vi.fn((request: Record<string, unknown>) => { requests.push(request); return { finalMessage: typeof result === "function" ? result as () => Promise<unknown> : async () => result }; });
  return { client: { beta: { messages: { stream } } } as never, requests, stream };
}

describe("Claude creative provider", () => {
  it("generates a concept with a Claude-compatible schema, reference images, and server-side fallback", async () => {
    const { client, requests } = clientReturning(message(concept));
    const resolveReferenceUrl = vi.fn(async (assetId: string) => `https://private.example/${assetId}?signed=redacted`);
    const provider = new ClaudeCreativeProvider({ apiKey: "test-secret-not-logged", model: "claude-opus-5-5", resolveReferenceUrl }, client);
    const result = await provider.generateConcept(input, context);
    expect(result.concept).toEqual(concept);
    expect(result.submission).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", providerTaskId: "msg_1", metadata: { inputTokens: 12, outputTokens: 34 } });
    const request = requests[0]!;
    expect(request).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "low", format: { type: "json_schema" } } });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('"minItems"');
    expect(serialized).not.toContain('"maxLength"');
    expect(serialized).toContain("minItems 3");
    expect(serialized).toContain("private.example/asset-1");
    expect(serialized).toContain("Do not invent options");
    expect(serialized).not.toContain("test-secret-not-logged");
  });

  it("rejects output that violates constraints Claude's schema cannot enforce", async () => {
    const { client } = clientReturning(message({ ...concept, scenes: concept.scenes.slice(0, 2) }));
    const provider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, client);
    await expect(provider.generateConcept(input, context)).rejects.toMatchObject({ code: "PROVIDER_CONCEPT_INVALID" });
  });

  it("runs Strategy generation directly and serves the same result on retrieval without a second request", async () => {
    const { client, requests, stream } = clientReturning(message({ concepts: [1, 2, 3].map(strategyConcept) }, { id: "msg_strategy" }));
    const provider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, client);
    const strategyInput = { ...input, requestedCount: 3 } as unknown as StrategyGenerationInput;
    const submitted = await provider.submitStrategyConcepts(strategyInput, context);
    expect(submitted).toMatchObject({ responseId: "msg_strategy", status: "completed", provider: "anthropic", usage: { totalTokens: 46 } });
    expect(await provider.retrieveStrategyConcepts("msg_strategy")).toEqual(submitted);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({ output_config: { effort: "medium" } });
    expect(String(requests[0]!.system)).toContain("Generate exactly 3 requested Creative Strategy slots for a Quick");
    await expect(provider.retrieveStrategyConcepts("msg_unknown")).rejects.toMatchObject({ code: "PROVIDER_STRATEGY_RESULT_UNAVAILABLE" });
  });

  it("reports a refusal as a terminal failed response rather than an unknown submission", async () => {
    const { client } = clientReturning(message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    const provider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, client);
    const response = await provider.submitStrategyConcepts({ ...input, requestedCount: 3 } as unknown as StrategyGenerationInput, context);
    expect(response).toMatchObject({ status: "failed", safeError: { code: "CLAUDE_REFUSED" } });
  });

  it("classifies transport failures without retrying paid requests", async () => {
    const strategyInput = { ...input, requestedCount: 3 } as unknown as StrategyGenerationInput;
    const rateLimited = new ClaudeCreativeProvider({ apiKey: "test", model: "m" }, clientReturning(async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); }).client);
    await expect(rateLimited.submitStrategyConcepts(strategyInput, context)).rejects.toMatchObject({ code: "CLAUDE_RATE_LIMITED" });
    const dropped = new ClaudeCreativeProvider({ apiKey: "test", model: "m" }, clientReturning(async () => { throw new Error("socket hang up"); }).client);
    await expect(dropped.submitStrategyConcepts(strategyInput, context)).rejects.toMatchObject({ code: "CLAUDE_STRATEGY_SUBMISSION_UNKNOWN" });
    await expect(dropped.rewriteNarration({ script: "x" } as never, context)).rejects.toMatchObject({ code: "CLAUDE_NARRATION_REWRITE_SUBMISSION_UNKNOWN" });
  });

  it("sends Creative DNA frames as base64 images and keeps frame bytes out of the text payload", async () => {
    const dna = { openingPattern: "o", openingProductVisible: true, approximateProductRevealMs: null, visualHookMechanism: "v", productProminence: "p", personalizationVisibility: "p", repeatedExamplePattern: "r", approximateExampleCount: 2, pacingPattern: "p", beatStructure: "b", overlayTextPattern: "o", offerVisibilityPattern: "o", ctaPattern: "c", proofPattern: "p", visualFormat: "v", lifestyleVsProductBalance: "l", soundOffComprehension: "s", directResponsePattern: "d", closingPattern: "c", preserveTraits: [], safeToVaryTraits: [], avoidTraits: [], sourceEvidence: [{ kind: "VISUAL_FRAME", observation: "o", timestampMs: 0, endTimestampMs: null, frameSha256: "abc" }], winnerReport: { verdict: { summary: "s", reasons: [{ title: "t", explanation: "e", confidence: "HIGH", evidence: [{ source: "FRAME", detail: "d", timestampMs: 0, endTimestampMs: null }] }] }, hook: { visualHook: "v", textHook: "", spokenHook: "", hookType: "PRODUCT_REVEAL", productFirstVisibleMs: 0, whyItStops: "w", strength: "STRONG" }, angle: { coreAngle: "a", buyerMotivation: "b", desireOrProblem: "d", emotionalTriggers: [], awarenessLevel: "PRODUCT_AWARE", promise: "p", proof: "p", offer: "", objectionsHandled: [], cta: "c", ctaTimestampMs: null }, timeline: [{ startMs: 0, endMs: 1000, beat: "HOOK", visual: "v", voiceLine: "", onScreenText: "", purpose: "p" }], voice: { deliveryStyle: "d", scriptStructure: "s", keyPhrases: [] }, editing: { format: "f", captionStyle: "c", productProminence: "p", soundOffComprehension: "s", pacingAssessment: "p" }, claimsCheck: [], performanceRead: "None supplied.", nextCreativeBrief: { keep: [], test: [{ idea: "i", hypothesis: "h", type: "HOOK" }], avoid: [] } } };
    const { client, requests } = clientReturning(message(dna, { id: "msg_dna" }));
    const provider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, client);
    const dnaInput = { frames: [{ timestampMs: 0, mimeType: "image/jpeg", sha256: "abc", bytesBase64: "QkFTRTY0RlJBTUU=" }] } as unknown as CreativeDnaAnalysisInput;
    expect(await provider.submitCreativeDnaAnalysis(dnaInput, context)).toMatchObject({ status: "completed", responseId: "msg_dna" });
    const content = (requests[0]!.messages as { content: { type: string; text?: string; source?: unknown }[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QkFTRTY0RlJBTUU=" } });
    expect(content.at(-1)!.text).not.toContain("QkFTRTY0RlJBTUU=");
  });

  it("generates four variant packages and a narration rewrite", async () => {
    const packages = ["A", "B", "C", "D"].map((slot) => ({ slot, angleName: `Angle ${slot}`, hook: "Short hook", narrationText: "Spoken copy", cta: "Shop now", secondaryOverlay: slot === "A" ? " Extra " : "" }));
    const variantProvider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, clientReturning(message({ packages })).client);
    const result = await variantProvider.generateVariantPackages({} as never, context);
    expect(result.packages.map((item) => item.slot)).toEqual(["A", "B", "C", "D"]);
    expect(result.packages[0]).toMatchObject({ secondaryOverlay: "Extra" });
    expect(result.packages[1]).not.toHaveProperty("secondaryOverlay");
    const rewriteProvider = new ClaudeCreativeProvider({ apiKey: "test", model: "claude-opus-5-5" }, clientReturning(message({ script: "  Tighter script.  " })).client);
    expect((await rewriteProvider.rewriteNarration({ script: "Long script" } as never, context)).script).toBe("Tighter script.");
  });

  it("requires an API key and model", () => {
    expect(() => new ClaudeCreativeProvider({ apiKey: "", model: "claude-opus-5-5" })).toThrow("ANTHROPIC_API_KEY");
  });
});

describe("Claude schema translation", () => {
  it("strips unsupported keywords into descriptions and converts nullable types to anyOf", () => {
    const translated = toClaudeSchema({ type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "string", maxLength: 10 }, b: { type: ["integer", "null"], minimum: 0 } } });
    expect(translated).toEqual({ type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "string", description: "maxLength 10" }, b: { anyOf: [{ type: "integer" }, { type: "null" }], description: "minimum 0" } } });
  });

  it("validates the original constraints locally", () => {
    const schema = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, items: { type: "string", maxLength: 3 } } } };
    expect(schemaViolation({ items: ["ok"] }, schema)).toBeUndefined();
    expect(schemaViolation({ items: [] }, schema)).toContain("fewer than 1");
    expect(schemaViolation({ items: ["toolong"] }, schema)).toContain("longer than 3");
    expect(schemaViolation({ items: ["ok"], extra: 1 }, schema)).toContain("not allowed");
  });
});
