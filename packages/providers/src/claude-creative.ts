import Anthropic from "@anthropic-ai/sdk";
import { DomainError } from "@koolezt/domain";
import type { ConceptProviderResponse, CreativeConceptProviderDraft, CreativeDnaAnalysisInput, CreativeInputSnapshot, CreativeProvider, ExecutionFeasibilityPlan, NarrationRewriteInput, ProviderOperationContext, ProviderSubmission, StrategyGenerationInput, StrategyProviderResponse, VariantCreativePackageDraft, VariantPackageGenerationInput, VideoPlanInput } from "@koolezt/domain";
import { OPENAI_CREATIVE_INSTRUCTIONS as CREATIVE_INSTRUCTIONS, OPENAI_CREATIVE_PROMPT_VERSION as CREATIVE_PROMPT_VERSION, OPENAI_NARRATION_REWRITE_INSTRUCTIONS as NARRATION_REWRITE_INSTRUCTIONS } from "./openai-creative-prompt.js";
import { backgroundConceptInstructions, conceptInstructions, DNA_ANALYSIS_INSTRUCTIONS, dnaSchema, VIDEO_PLAN_INSTRUCTIONS, videoPlansSchema, WINNER_REPORT_SYSTEM, legacyConceptSchema, narrationRewriteSchema, referenceCatalog, strategyExecutionSchemaFor, strategyInstructions, strategyProviderInput, strategySchemaFor, VARIANT_PACKAGE_INSTRUCTIONS, variantPackageSchema } from "./creative-contract.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
type JsonSchema = Readonly<Record<string, unknown>>;
type ImageBlock = Anthropic.Beta.BetaImageBlockParam;
type ClaudeCallResult = Readonly<{ id: string; model: string; outputText: string; usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }> }>;

// Structured outputs reject numeric, string-length, and array-size keywords. They are removed from
// the schema sent to Claude, restated in the field description, and enforced locally after parsing.
const LOCAL_ONLY_KEYWORDS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;

export function toClaudeSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if ((LOCAL_ONLY_KEYWORDS as readonly string[]).includes(key)) { hints.push(`${key} ${String(value)}`); continue; }
    if (key === "properties" && value && typeof value === "object") out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toClaudeSchema(child as JsonSchema)]));
    else if (key === "items" && value && typeof value === "object") out.items = toClaudeSchema(value as JsonSchema);
    else out[key] = value;
  }
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    const { description, ...rest } = out;
    return { anyOf: types.map((type) => (type === "null" ? { type } : { ...rest, type })), ...(description || hints.length ? { description: [description, ...hints].filter(Boolean).join("; ") } : {}) };
  }
  if (hints.length) out.description = [out.description, ...hints].filter(Boolean).join("; ");
  return out;
}

/** Returns the first violation of the full (unstripped) schema, or undefined when the value conforms. */
export function schemaViolation(value: unknown, schema: JsonSchema, path = "$"): string | undefined {
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
  if (types) {
    const matches = types.some((type) => type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" : type === "array" ? Array.isArray(value) : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value) : typeof value === type);
    if (!matches) return `${path} must be ${types.join(" or ")}`;
  }
  if (value === null) return undefined;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} is not an allowed value`;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is shorter than ${schema.minLength}`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has fewer than ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
    if (schema.items) for (const [index, item] of value.entries()) { const violation = schemaViolation(item, schema.items as JsonSchema, `${path}[${index}]`); if (violation) return violation; }
  }
  if (typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    const record = value as Record<string, unknown>;
    for (const name of (schema.required as string[] | undefined) ?? []) if (!(name in record)) return `${path}.${name} is required`;
    for (const [name, child] of Object.entries(record)) {
      const childSchema = properties[name];
      if (!childSchema) { if (schema.additionalProperties === false) return `${path}.${name} is not allowed`; continue; }
      const violation = schemaViolation(child, childSchema, `${path}.${name}`);
      if (violation) return violation;
    }
  }
  return undefined;
}

/** Reads a JSON object from model text, tolerating code fences or stray prose around it. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { /* fall through to the outermost object */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function providerMessage(error: unknown): string {
  const message = typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "";
  return message ? ` ${message.slice(0, 300)}` : "";
}

function httpStatus(error: unknown): number {
  return typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) || 0 : 0;
}

export class ClaudeCreativeProvider implements CreativeProvider {
  private readonly client: Anthropic;
  // Claude has no server-side response store. A completed background result is kept here so a
  // retrieval after submission returns the same output instead of issuing a second paid request.
  private readonly completed = new Map<string, StrategyProviderResponse>();

  constructor(private readonly config: Readonly<{ apiKey: string; model: string; resolveReferenceUrl?: (assetId: string) => Promise<string>; backgroundEffort?: ClaudeEffort; interactiveEffort?: ClaudeEffort; backgroundTimeoutMs?: number; interactiveTimeoutMs?: number }>, client?: Anthropic) {
    if (!config.apiKey) throw new DomainError("CLAUDE_CONFIGURATION_MISSING", "ANTHROPIC_API_KEY is required when CREATIVE_PROVIDER=claude.");
    if (!config.model) throw new DomainError("CLAUDE_CONFIGURATION_MISSING", "CLAUDE_CREATIVE_MODEL is required when CREATIVE_PROVIDER=claude.");
    this.client = client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
  }

  private async referenceImages(input: CreativeInputSnapshot | StrategyGenerationInput): Promise<ImageBlock[]> {
    if (!this.config.resolveReferenceUrl) return [];
    return Promise.all(input.selectedAssets.filter((asset) => asset.kind === "IMAGE").map(async (asset) => ({ type: "image" as const, source: { type: "url" as const, url: await this.config.resolveReferenceUrl!(asset.id) } })));
  }

  /**
   * One streamed Messages call with a structured-output schema. Throws DomainError for refusals,
   * truncation, and schema violations; transport errors propagate for the caller to classify.
   */
  private async call(request: Readonly<{ system: string; payload: unknown; images?: readonly ImageBlock[]; schema?: JsonSchema; effort: ClaudeEffort; timeoutMs: number; invalidCode: string }>): Promise<ClaudeCallResult> {
    const stream = this.client.beta.messages.stream({
      model: this.config.model,
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: request.system,
      messages: [{ role: "user", content: [...(request.images ?? []), { type: "text", text: JSON.stringify(request.payload) }] }],
      output_config: { effort: request.effort, ...(request.schema ? { format: { type: "json_schema" as const, schema: toClaudeSchema(request.schema) } } : {}) }
    }, { timeout: request.timeoutMs });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new DomainError("CLAUDE_REFUSED", `Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}; it will not be retried automatically.`);
    if (message.stop_reason === "max_tokens") throw new DomainError(request.invalidCode, "Claude reached its output limit before completing the structured response.");
    const outputText = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let parsed: unknown;
    try { parsed = request.schema ? JSON.parse(outputText) : parseLooseJson(outputText); } catch { throw new DomainError(request.invalidCode, "Claude returned malformed structured data."); }
    const violation = request.schema ? schemaViolation(parsed, request.schema) : undefined;
    if (violation) throw new DomainError(request.invalidCode, `Claude returned structured data outside the allowed bounds: ${violation}.`);
    const usage = { inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens };
    return { id: message.id, model: message.model, outputText: request.schema ? outputText : JSON.stringify(parsed), usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } };
  }

  private submission(result: ClaudeCallResult, context: ProviderOperationContext, promptVersion: string): ProviderSubmission {
    return { provider: "anthropic", model: result.model, providerTaskId: result.id, requestId: result.id, metadata: { promptVersion, operationKey: context.operationKey, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } };
  }

  private interactiveFailure(error: unknown, invalidCode: string, unknownCode: string, label: string): never {
    if (error instanceof DomainError) throw error;
    const status = httpStatus(error);
    if (status === 400) throw new DomainError(invalidCode, `Claude rejected the ${label} request.${providerMessage(error)}`);
    if (status === 401 || status === 403) throw new DomainError("CLAUDE_AUTHENTICATION_FAILED", "Claude authentication was rejected.");
    if (status === 429) throw new DomainError("CLAUDE_RATE_LIMITED", "Claude rate limit reached; retry later.");
    if (status >= 500) throw new DomainError("CLAUDE_UNAVAILABLE", "Claude is temporarily unavailable.");
    // These explicit actions are billable; an ambiguous transport result is never retried here.
    throw new DomainError(unknownCode, `Claude ${label} outcome is unknown; do not retry automatically.`);
  }

  /**
   * Background operations run as one direct call inside the worker job and return a terminal
   * response. Only an ambiguous transport outcome is reported as SUBMISSION_UNKNOWN.
   */
  private async background(request: Parameters<ClaudeCreativeProvider["call"]>[0], unknownCode: string, label: string): Promise<StrategyProviderResponse> {
    try {
      const result = await this.call(request);
      const response: StrategyProviderResponse = { responseId: result.id, status: "completed", provider: "anthropic", model: result.model, outputText: result.outputText, usage: result.usage };
      this.completed.set(result.id, response);
      return response;
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === "CLAUDE_REFUSED") return { responseId: `refused:${Date.now()}`, status: "failed", provider: "anthropic", model: this.config.model, safeError: { code: error.code, message: error.message } };
        throw error;
      }
      const status = httpStatus(error);
      if (status === 400) throw new DomainError(request.invalidCode, `Claude rejected the bounded ${label} request.${providerMessage(error)}`);
      if (status === 401 || status === 403) throw new DomainError("CLAUDE_AUTHENTICATION_FAILED", "Claude authentication was rejected.");
      if (status === 429) throw new DomainError("CLAUDE_RATE_LIMITED", "Claude rate limit reached; retry only by explicit operator action.");
      throw new DomainError(unknownCode, `Claude ${label} outcome is unknown; do not retry automatically.`);
    }
  }

  private retrieve(responseId: string, unavailableCode: string, label: string): StrategyProviderResponse {
    const response = this.completed.get(responseId);
    if (!response) throw new DomainError(unavailableCode, `The known Claude ${label} result is no longer available in this worker; it will not be resubmitted.`);
    return response;
  }

  private get backgroundEffort(): ClaudeEffort { return this.config.backgroundEffort ?? "medium"; }
  private get interactiveEffort(): ClaudeEffort { return this.config.interactiveEffort ?? "low"; }
  private get backgroundTimeoutMs(): number { return this.config.backgroundTimeoutMs ?? 600_000; }
  private get interactiveTimeoutMs(): number { return this.config.interactiveTimeoutMs ?? 90_000; }

  async generateConcept(input: CreativeInputSnapshot, context: ProviderOperationContext): Promise<Readonly<{ concept: CreativeConceptProviderDraft; submission: ProviderSubmission }>> {
    try {
      const references = referenceCatalog(input);
      const result = await this.call({
        system: conceptInstructions(CREATIVE_INSTRUCTIONS, input),
        payload: { promptVersion: CREATIVE_PROMPT_VERSION, operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, product: input.selectedStrategy ? strategyProviderInput(input) : input },
        images: await this.referenceImages(input),
        schema: input.selectedStrategy ? strategyExecutionSchemaFor(references.map((item) => item.role)) : legacyConceptSchema,
        effort: this.interactiveEffort, timeoutMs: this.interactiveTimeoutMs, invalidCode: "PROVIDER_CONCEPT_INVALID"
      });
      return { concept: JSON.parse(result.outputText) as CreativeConceptProviderDraft, submission: this.submission(result, context, CREATIVE_PROMPT_VERSION) };
    } catch (error) {
      this.interactiveFailure(error, "PROVIDER_CONCEPT_INVALID", "CLAUDE_CONCEPT_SUBMISSION_UNKNOWN", "concept generation");
    }
  }

  async submitConceptExecution(input: CreativeInputSnapshot, _context: ProviderOperationContext, feasibilityPlan?: ExecutionFeasibilityPlan): Promise<ConceptProviderResponse> {
    if (!input.selectedStrategy) throw new DomainError("BACKGROUND_CONCEPT_REQUIRES_STRATEGY", "Background Creative Concept execution is limited to Strategy-linked projects.");
    const references = referenceCatalog(input);
    return this.background({
      system: backgroundConceptInstructions(CREATIVE_INSTRUCTIONS, input),
      payload: { promptVersion: CREATIVE_PROMPT_VERSION, product: strategyProviderInput(input), executionFeasibilityPlan: feasibilityPlan },
      images: await this.referenceImages(input),
      schema: strategyExecutionSchemaFor(references.map((item) => item.role)),
      effort: this.backgroundEffort, timeoutMs: this.backgroundTimeoutMs, invalidCode: "PROVIDER_CONCEPT_INVALID"
    }, "PROVIDER_CONCEPT_SUBMISSION_UNKNOWN", "Creative Concept");
  }

  async retrieveConceptExecution(responseId: string): Promise<ConceptProviderResponse> {
    return this.retrieve(responseId, "PROVIDER_CONCEPT_RESULT_UNAVAILABLE", "Creative Concept");
  }

  async submitStrategyConcepts(input: StrategyGenerationInput, context: ProviderOperationContext): Promise<StrategyProviderResponse> {
    const expectedCount = input.replacementOrdinals?.length ?? input.requestedCount;
    return this.background({
      system: strategyInstructions(expectedCount, input.requestedCount),
      payload: { operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, strategy: input },
      images: await this.referenceImages(input),
      schema: strategySchemaFor(expectedCount),
      effort: this.backgroundEffort, timeoutMs: this.backgroundTimeoutMs, invalidCode: "PROVIDER_STRATEGY_INVALID"
    }, "CLAUDE_STRATEGY_SUBMISSION_UNKNOWN", "Strategy generation");
  }

  async retrieveStrategyConcepts(responseId: string): Promise<StrategyProviderResponse> {
    return this.retrieve(responseId, "PROVIDER_STRATEGY_RESULT_UNAVAILABLE", "Strategy");
  }

  async submitCreativeDnaAnalysis(input: CreativeDnaAnalysisInput, context: ProviderOperationContext): Promise<StrategyProviderResponse> {
    const safeInput = {
      ...input,
      frames: input.frames.map((frame) => ({ timestampMs: frame.timestampMs, mimeType: frame.mimeType, sha256: frame.sha256 })),
      ...(input.performance ? { performance: { ...input.performance, historicalContextOnly: true } } : {}),
      ...(input.currentProduct ? { currentProduct: { ...input.currentProduct, authority: "CURRENT_PRODUCT_TRUTH_READ_ONLY" } } : {})
    };
    const images = input.frames.map((frame): ImageBlock => ({ type: "image", source: { type: "base64", media_type: frame.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: frame.bytesBase64 } }));
    const payload = { operationKey: context.operationKey, reference: safeInput };
    // The report runs alongside the DNA call; its failure is reported on the report, never on the DNA.
    const report = this.call({ system: WINNER_REPORT_SYSTEM(), payload, images, effort: this.backgroundEffort, timeoutMs: this.backgroundTimeoutMs, invalidCode: "CLAUDE_WINNER_REPORT_INVALID" })
      .then((result) => ({ winnerReport: JSON.parse(result.outputText) as unknown, usage: result.usage }))
      .catch((error: unknown) => ({ winnerReportError: `The Winner Analysis report could not be produced:${providerMessage(error) || " unknown error"}`.slice(0, 500) }));
    const dna = await this.background({
      system: DNA_ANALYSIS_INSTRUCTIONS, payload, images, schema: dnaSchema,
      effort: this.backgroundEffort, timeoutMs: this.backgroundTimeoutMs, invalidCode: "CLAUDE_DNA_INVALID"
    }, "CLAUDE_DNA_SUBMISSION_UNKNOWN", "Creative DNA analysis");
    const extra = await report;
    if (dna.status !== "completed" || !dna.outputText) return dna;
    const merged: StrategyProviderResponse = { ...dna, outputText: JSON.stringify({ ...(JSON.parse(dna.outputText) as Record<string, unknown>), ...("winnerReport" in extra ? { winnerReport: extra.winnerReport } : { winnerReportError: extra.winnerReportError }) }), ...("usage" in extra && dna.usage ? { usage: { inputTokens: (dna.usage.inputTokens ?? 0) + extra.usage.inputTokens, outputTokens: (dna.usage.outputTokens ?? 0) + extra.usage.outputTokens, totalTokens: (dna.usage.totalTokens ?? 0) + extra.usage.totalTokens } } : {}) };
    this.completed.set(merged.responseId, merged);
    return merged;
  }

  async planWinnerVideos(input: VideoPlanInput, context: ProviderOperationContext): Promise<Readonly<{ plans: readonly unknown[]; submission: ProviderSubmission }>> {
    const { photos, ...rest } = input;
    const images = photos.map((photo): ImageBlock => ({ type: "image", source: { type: "base64", media_type: photo.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: photo.bytesBase64 } }));
    try {
      const result = await this.call({
        system: VIDEO_PLAN_INSTRUCTIONS(input.requestedCount, Math.round(input.targetDurationMs / 1000), input.style),
        payload: { operationKey: context.operationKey, ...rest, photos: photos.map((photo) => ({ number: photo.index, label: photo.label })) },
        images, schema: videoPlansSchema, effort: this.backgroundEffort, timeoutMs: this.backgroundTimeoutMs, invalidCode: "CLAUDE_VIDEO_PLANS_INVALID"
      });
      return { plans: (JSON.parse(result.outputText) as { plans: unknown[] }).plans, submission: this.submission(result, context, "winner-video-plans/v1") };
    } catch (error) {
      this.interactiveFailure(error, "CLAUDE_VIDEO_PLANS_INVALID", "CLAUDE_VIDEO_PLANS_SUBMISSION_UNKNOWN", "video plan");
    }
  }

  async retrieveCreativeDnaAnalysis(responseId: string): Promise<StrategyProviderResponse> {
    return this.retrieve(responseId, "PROVIDER_DNA_RESULT_UNAVAILABLE", "Creative DNA");
  }

  async generateVariantPackages(input: VariantPackageGenerationInput, context: ProviderOperationContext): Promise<Readonly<{ packages: readonly VariantCreativePackageDraft[]; submission: ProviderSubmission }>> {
    try {
      const result = await this.call({
        system: VARIANT_PACKAGE_INSTRUCTIONS,
        payload: { operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, context: input },
        schema: variantPackageSchema, effort: this.interactiveEffort, timeoutMs: this.interactiveTimeoutMs, invalidCode: "CLAUDE_VARIANT_COPY_INVALID"
      });
      const parsed = JSON.parse(result.outputText) as { packages: VariantCreativePackageDraft[] };
      const packages = parsed.packages.map(({ secondaryOverlay, ...item }) => ({ ...item, ...(secondaryOverlay?.trim() ? { secondaryOverlay: secondaryOverlay.trim() } : {}) }));
      const slots = packages.map((item) => item.slot).sort().join("");
      if (slots !== "ABCD" || packages.some((item) => !item.angleName.trim() || !item.hook.trim() || !item.narrationText.trim() || !item.cta.trim())) throw new DomainError("CLAUDE_VARIANT_COPY_INVALID", "Claude returned incomplete creative packages.");
      return { packages, submission: this.submission(result, context, "variant-copy/v2") };
    } catch (error) {
      this.interactiveFailure(error, "CLAUDE_VARIANT_COPY_REQUEST_INVALID", "CLAUDE_VARIANT_COPY_SUBMISSION_UNKNOWN", "creative-package generation");
    }
  }

  async rewriteNarration(input: NarrationRewriteInput, context: ProviderOperationContext): Promise<Readonly<{ script: string; submission: ProviderSubmission }>> {
    try {
      const result = await this.call({
        system: NARRATION_REWRITE_INSTRUCTIONS,
        payload: { operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, narration: input },
        schema: narrationRewriteSchema, effort: this.interactiveEffort, timeoutMs: this.interactiveTimeoutMs, invalidCode: "PROVIDER_NARRATION_REWRITE_INVALID"
      });
      const script = (JSON.parse(result.outputText) as { script: string }).script.trim();
      if (!script) throw new DomainError("PROVIDER_NARRATION_REWRITE_INVALID", "Claude returned an empty narration rewrite.");
      return { script, submission: this.submission(result, context, "narration-rewrite/v1") };
    } catch (error) {
      this.interactiveFailure(error, "PROVIDER_NARRATION_REWRITE_INVALID", "CLAUDE_NARRATION_REWRITE_SUBMISSION_UNKNOWN", "narration rewrite");
    }
  }
}
