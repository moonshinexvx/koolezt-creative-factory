import { OpenAICreativeProvider } from "@koolezt/providers";

if (process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true" || process.env.CREATIVE_PROVIDER !== "openai") {
  throw new Error("Refusing paid smoke test: set CREATIVE_PROVIDER=openai and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
}
const provider = new OpenAICreativeProvider({ apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_CREATIVE_MODEL ?? "" });
const result = await provider.generateConcept({ productName: "Smoke-test product", description: "A temporary internal test product.", defaultCta: "Learn more", claims: [{ kind: "RESTRICTION", text: "Do not invent claims." }], selectedAssets: [], additionalInstructions: "Return a concise generic concept." }, { operationKey: `smoke:${Date.now()}`, projectId: "smoke", targetId: "concept" });
console.log(JSON.stringify({ provider: result.submission.provider, model: result.submission.model, requestId: result.submission.requestId }));
