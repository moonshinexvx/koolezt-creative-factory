import { ClaudeCreativeProvider } from "@koolezt/providers";

if (process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true" || process.env.CREATIVE_PROVIDER !== "claude") {
  throw new Error("Refusing paid smoke test: set CREATIVE_PROVIDER=claude and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
}
const provider = new ClaudeCreativeProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.CLAUDE_CREATIVE_MODEL ?? "claude-opus-5-5" });
const result = await provider.generateConcept({ productName: "Smoke-test product", description: "A temporary internal test product.", defaultCta: "Learn more", claims: [{ kind: "RESTRICTION", text: "Do not invent claims." }], selectedAssets: [], additionalInstructions: "Return a concise generic concept." }, { operationKey: `smoke:${Date.now()}`, projectId: "smoke", targetId: "concept" });
console.log(JSON.stringify({ provider: result.submission.provider, model: result.submission.model, requestId: result.submission.requestId, ...result.submission.metadata }));
