import { createHash, randomUUID } from "node:crypto";
import { DomainError, isReusableAsPristineStrategySource, STRATEGY_PRODUCTION_METHODS } from "@koolezt/domain";
import type {
  CreativeHandoffInputSnapshot, CreativeInputSnapshot, CreativeProject, CreativeProvider, FactoryRepository, StrategyAssetCapability,
  StrategyBatch, StrategyConcept, StrategyConceptDraft, StrategyConceptRevision,
  StrategyDiversityState, StrategyEvidenceConstraint, StrategyGenerationInput,
  StrategyHistoryEntry, StrategyProductionMethod, StrategyProductionSafetyState,
  StrategyProviderConceptDraft, StrategyProviderResponse, StrategyRepository, StrategyRequestedCount, WorkflowJob, CreativeDnaRepository,
  SelectedWinnerDnaSnapshot
} from "@koolezt/domain";

export const STRATEGY_LIMITS = Object.freeze({
  conceptsPerBatch: 12,
  conceptName: 120,
  conceptFamily: 80,
  buyerPersona: 160,
  desireOrProblem: 500,
  awarenessLevel: 80,
  coreAngle: 600,
  emotionalTerritory: 160,
  primaryPromise: 500,
  hook: 200,
  openingVisualPattern: 500,
  creativeFormat: 120,
  proofMechanism: 500,
  offerFraming: 400,
  ctaStrategy: 300,
  differentiationSummary: 700,
  creativeVisualExecutionNotes: 700,
  constraintText: 500,
  constraints: 20,
  visualFidelityRequirements: 20,
  supportingProductionMethods: 3,
  historyEntries: 48,
  historyFamilies: 24,
  historyBatches: 4,
  historySerializedBytes: 24_000,
  selectedAssets: 20,
  productDescription: 5_000,
  additionalInstructions: 2_000
});

export const STRATEGY_REQUESTED_COUNTS = [3, 6, 12] as const;
export const DEFAULT_STRATEGY_REQUESTED_COUNT: StrategyRequestedCount = 6;

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonicalJson(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonicalJson);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([,item])=>item!==undefined).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,canonicalJson(item)]));
  return value;
}
export const creativeInputSnapshotSha256=(value:CreativeInputSnapshot)=>createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
const sensitiveMetadataKey = /authorization|api[-_]?key|token|secret|password|credential|cookie/i;
function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadataValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !sensitiveMetadataKey.test(key))
        .map(([key, nested]) => [key, sanitizeMetadataValue(nested)])
    );
  }
  return value;
}
const sanitizeMetadata = (value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  sanitizeMetadataValue(value) as Readonly<Record<string, unknown>>;
const submissionMetadata = (submission: { provider: string; model: string; providerTaskId: string; requestId: string; metadata: Readonly<Record<string, unknown>> }) => ({
  provider: submission.provider, model: submission.model, providerTaskId: submission.providerTaskId,
  requestId: submission.requestId, ...sanitizeMetadata(submission.metadata)
});

const STRATEGY_POLL_INTERVAL_MS = 5_000;
class StrategyPollPending extends Error {
  readonly nextAttemptAt: string;
  constructor(message: string, now: string) {
    super(message);
    this.nextAttemptAt = new Date(Date.parse(now) + STRATEGY_POLL_INTERVAL_MS).toISOString();
  }
}

export function boundStrategyHistory(entries: readonly StrategyHistoryEntry[]): readonly StrategyHistoryEntry[] {
  const output: StrategyHistoryEntry[] = [];
  const families = new Set<string>();
  for (const entry of entries) {
    if (output.length >= STRATEGY_LIMITS.historyEntries) break;
    const family = normalize(entry.conceptFamily);
    if (!families.has(family) && families.size >= STRATEGY_LIMITS.historyFamilies) continue;
    const candidate = [...output, entry];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > STRATEGY_LIMITS.historySerializedBytes) break;
    families.add(family);
    output.push(entry);
  }
  return output;
}

function required(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError("STRATEGY_CONCEPT_INVALID", `${name} is required and must be at most ${max} characters.`);
}

function validateConstraint(constraint: StrategyEvidenceConstraint, authoritative: readonly StrategyEvidenceConstraint[]): void {
  required(constraint.text, "Strategy constraint", STRATEGY_LIMITS.constraintText);
  if (constraint.sourceType === "REFERENCE_VISUAL" && constraint.authority !== "VISUAL_EVIDENCE") {
    throw new DomainError("STRATEGY_TRUTH_AUTHORITY_INVALID", "Reference images can establish visual evidence, not factual product claims.");
  }
  const accepted = authoritative.some((item) => item.sourceType === constraint.sourceType && item.authority === constraint.authority && item.sourceId === constraint.sourceId && normalize(item.text) === normalize(constraint.text));
  if (!accepted) throw new DomainError("STRATEGY_TRUTH_UNSUPPORTED", "Strategy constraints must come from verified claims, authoritative operator data, or selected visual evidence.");
}

export function validateStrategyDraft(draft: StrategyConceptDraft, input: StrategyGenerationInput): void {
  if (!Number.isInteger(draft.ordinal) || draft.ordinal < 1 || draft.ordinal > input.requestedCount) throw new DomainError("STRATEGY_ORDINAL_INVALID", `Strategy ordinal must be between 1 and ${input.requestedCount}.`);
  required(draft.conceptName, "Concept name", STRATEGY_LIMITS.conceptName);
  required(draft.conceptFamily, "Concept family", STRATEGY_LIMITS.conceptFamily);
  required(draft.buyerPersona, "Buyer purchase context", STRATEGY_LIMITS.buyerPersona);
  required(draft.customerDesireOrProblem, "Customer desire/problem", STRATEGY_LIMITS.desireOrProblem);
  required(draft.awarenessLevel, "Awareness level", STRATEGY_LIMITS.awarenessLevel);
  required(draft.coreAngle, "Core angle", STRATEGY_LIMITS.coreAngle);
  required(draft.emotionalTerritory, "Emotional territory", STRATEGY_LIMITS.emotionalTerritory);
  required(draft.primaryPromise, "Primary promise", STRATEGY_LIMITS.primaryPromise);
  required(draft.hook, "Hook", STRATEGY_LIMITS.hook);
  required(draft.openingVisualPattern, "Opening visual pattern", STRATEGY_LIMITS.openingVisualPattern);
  required(draft.creativeFormat, "Creative format", STRATEGY_LIMITS.creativeFormat);
  required(draft.proofMechanism, "Proof mechanism", STRATEGY_LIMITS.proofMechanism);
  required(draft.offerFraming, "Offer framing", STRATEGY_LIMITS.offerFraming);
  required(draft.ctaStrategy, "CTA strategy", STRATEGY_LIMITS.ctaStrategy);
  required(draft.differentiationSummary, "Differentiation summary", STRATEGY_LIMITS.differentiationSummary);
  if (draft.creativeVisualExecutionNotes) required(draft.creativeVisualExecutionNotes, "Creative visual execution notes", STRATEGY_LIMITS.creativeVisualExecutionNotes);
  if (!STRATEGY_PRODUCTION_METHODS.includes(draft.primaryProductionMethod)) throw new DomainError("STRATEGY_PRODUCTION_METHOD_INVALID", "Unknown primary production method.");
  if (!["NOT_APPLICABLE", "AI_STYLE_NON_CUSTOMER", "REAL_SUPPLIED_TESTIMONIAL"].includes(draft.ugcRepresentation)) throw new DomainError("STRATEGY_UGC_REPRESENTATION_INVALID", "Unknown AI UGC representation.");
  if (draft.supportingProductionMethods.length > STRATEGY_LIMITS.supportingProductionMethods || new Set(draft.supportingProductionMethods).size !== draft.supportingProductionMethods.length || draft.supportingProductionMethods.includes(draft.primaryProductionMethod)) throw new DomainError("STRATEGY_SUPPORTING_METHODS_INVALID", "Supporting production methods must be unique, exclude the primary method, and contain at most three entries.");
  if (draft.supportingProductionMethods.some((item) => !STRATEGY_PRODUCTION_METHODS.includes(item))) throw new DomainError("STRATEGY_PRODUCTION_METHOD_INVALID", "Unknown supporting production method.");
  if (draft.productTruthConstraints.length > STRATEGY_LIMITS.constraints || draft.visualFidelityRequirements.length > STRATEGY_LIMITS.visualFidelityRequirements) throw new DomainError("STRATEGY_CONSTRAINT_LIMIT", "Strategy constraint arrays exceed their bounded limits.");
  draft.productTruthConstraints.forEach((item) => {
    if (item.authority !== "FACTUAL_CLAIM" || item.sourceType === "REFERENCE_VISUAL") throw new DomainError("STRATEGY_TRUTH_AUTHORITY_INVALID", "Product-truth constraints require verified factual authority; reference images are visual evidence only.");
    validateConstraint(item, input.authoritativeConstraints);
  });
  draft.visualFidelityRequirements.forEach((item) => {
    if (item.authority !== "VISUAL_EVIDENCE") throw new DomainError("STRATEGY_VISUAL_AUTHORITY_INVALID", "Visual-fidelity requirements must cite visual evidence.");
    validateConstraint(item, input.authoritativeConstraints);
  });
}

const providerFields = (draft: StrategyConceptDraft): StrategyProviderConceptDraft => ({
  ordinal: draft.ordinal,
  conceptName: draft.conceptName,
  conceptFamily: draft.conceptFamily,
  buyerPersona: draft.buyerPersona,
  customerDesireOrProblem: draft.customerDesireOrProblem,
  awarenessLevel: draft.awarenessLevel,
  coreAngle: draft.coreAngle,
  emotionalTerritory: draft.emotionalTerritory,
  primaryPromise: draft.primaryPromise,
  hook: draft.hook,
  openingVisualPattern: draft.openingVisualPattern,
  creativeFormat: draft.creativeFormat,
  primaryProductionMethod: draft.primaryProductionMethod,
  supportingProductionMethods: draft.supportingProductionMethods,
  proofMechanism: draft.proofMechanism,
  offerFraming: draft.offerFraming,
  ctaStrategy: draft.ctaStrategy,
  differentiationSummary: draft.differentiationSummary,
  creativeVisualExecutionNotes: draft.creativeVisualExecutionNotes,
  ugcRepresentation: draft.ugcRepresentation
});

function productionMethod(value: unknown, label: string): StrategyProductionMethod {
  if (typeof value !== "string" || !STRATEGY_PRODUCTION_METHODS.includes(value as StrategyProductionMethod)) {
    throw new DomainError("STRATEGY_PRODUCTION_METHOD_INVALID", `Unknown ${label} production method.`);
  }
  return value as StrategyProductionMethod;
}

/**
 * Converts untrusted provider creativity into the canonical application-owned
 * strategy shape. Any provider-supplied truth/capability arrays are ignored.
 */
export function canonicalizeStrategyDraft(raw: StrategyProviderConceptDraft, input: StrategyGenerationInput): StrategyConceptDraft {
  required(raw.creativeVisualExecutionNotes, "Creative visual execution notes", STRATEGY_LIMITS.creativeVisualExecutionNotes);
  const primary = productionMethod(raw.primaryProductionMethod, "primary");
  if (!Array.isArray(raw.supportingProductionMethods)) throw new DomainError("STRATEGY_SUPPORTING_METHODS_INVALID", "Supporting production methods must be an array.");
  const supporting: StrategyProductionMethod[] = [];
  for (const candidate of raw.supportingProductionMethods) {
    const method = productionMethod(candidate, "supporting");
    if (method !== primary && !supporting.includes(method)) supporting.push(method);
  }
  if (supporting.length > STRATEGY_LIMITS.supportingProductionMethods) throw new DomainError("STRATEGY_SUPPORTING_METHODS_INVALID", "Supporting production methods must contain at most three normalized entries.");
  const methods = [primary, ...supporting];
  const requiresProductImage = methods.some((method) => ["PRODUCT_IMAGE_MOTION", "PERSONALIZATION_DEMO", "AI_BEFORE_AFTER"].includes(method));
  const requiredRealAssetCapabilities: StrategyAssetCapability[] = requiresProductImage ? ["PRODUCT_IMAGE"] : [];
  const canonical: StrategyConceptDraft = {
    ordinal: raw.ordinal,
    conceptName: raw.conceptName,
    conceptFamily: raw.conceptFamily,
    buyerPersona: raw.buyerPersona,
    customerDesireOrProblem: raw.customerDesireOrProblem,
    awarenessLevel: raw.awarenessLevel,
    coreAngle: raw.coreAngle,
    emotionalTerritory: raw.emotionalTerritory,
    primaryPromise: raw.primaryPromise,
    hook: raw.hook,
    openingVisualPattern: raw.openingVisualPattern,
    creativeFormat: raw.creativeFormat,
    primaryProductionMethod: primary,
    supportingProductionMethods: supporting,
    proofMechanism: raw.proofMechanism,
    offerFraming: raw.offerFraming,
    ctaStrategy: raw.ctaStrategy,
    differentiationSummary: raw.differentiationSummary,
    creativeVisualExecutionNotes: raw.creativeVisualExecutionNotes,
    ugcRepresentation: raw.ugcRepresentation,
    productTruthConstraints: input.authoritativeConstraints
      .filter((constraint) => constraint.authority === "FACTUAL_CLAIM" && constraint.sourceType !== "REFERENCE_VISUAL")
      .slice(0, STRATEGY_LIMITS.constraints),
    visualFidelityRequirements: input.authoritativeConstraints
      .filter((constraint) => constraint.authority === "VISUAL_EVIDENCE")
      .slice(0, STRATEGY_LIMITS.visualFidelityRequirements),
    requiredRealAssetCapabilities
  };
  validateStrategyDraft(canonical, input);
  return canonical;
}

const factualRiskTerms = /\b(material|steel|aluminum|wood|gauge|thick|durab|weather|waterproof|manufactur|factory|shipping|delivery|discount|packag|review|testimonial)\w*/gi;
const firstPersonTestimony = /\b(?:i|we)\s+(?:bought|ordered|received|got|use|used|love|recommend)\b/i;
const demographicTargeting = /\b(?:male|female|men|women|income|salary|years? old|aged?\s+\d|age\s+\d)\b/i;
const realAssetSignals: readonly Readonly<{ pattern: RegExp; capability: StrategyAssetCapability; label: string }>[] = [
  { pattern: /\b(?:real\s+)?factory\s+(?:footage|tour|documentary)|behind[- ]the[- ]scenes\s+manufactur/i, capability: "REAL_FACTORY_VIDEO", label: "real factory footage" },
  { pattern: /\b(?:real\s+)?(?:customer\s+)?unboxing\b/i, capability: "REAL_UNBOXING_VIDEO", label: "real unboxing footage" },
  { pattern: /\breal\s+(?:customer\s+)?testimonial|customer\s+says?\b/i, capability: "REAL_CUSTOMER_TESTIMONIAL", label: "real customer testimony" },
  { pattern: /\breal\s+(?:creator|person)\s+(?:holding|using|wearing)|creator\s+holds?\s+the\s+product\b/i, capability: "REAL_CREATOR_PRODUCT_VIDEO", label: "real creator-product footage" }
];

function safetyFor(draft: StrategyConceptDraft, input: StrategyGenerationInput): { state: StrategyProductionSafetyState; findings: string[] } {
  const findings: string[] = [];
  const available = new Set(input.availableAssetCapabilities);
  for (const capability of draft.requiredRealAssetCapabilities) if (!available.has(capability)) findings.push(`Missing required real asset capability: ${capability}.`);
  const allCreativeText = [draft.conceptName, draft.buyerPersona, draft.customerDesireOrProblem, draft.coreAngle, draft.primaryPromise, draft.hook, draft.openingVisualPattern, draft.creativeFormat, draft.proofMechanism, draft.offerFraming, draft.differentiationSummary, draft.creativeVisualExecutionNotes].join(" ");
  for (const signal of realAssetSignals) if (signal.pattern.test(allCreativeText) && !available.has(signal.capability)) findings.push(`Missing required real asset capability for ${signal.label}: ${signal.capability}.`);
  if (demographicTargeting.test(draft.buyerPersona)) findings.push("Buyer persona must describe purchase context or motivation, not inferred demographics.");
  if (draft.primaryProductionMethod === "AI_UGC_STYLE") {
    if (draft.ugcRepresentation === "REAL_SUPPLIED_TESTIMONIAL" && !available.has("REAL_CUSTOMER_TESTIMONIAL")) findings.push("Real customer testimony was not supplied.");
    if (draft.ugcRepresentation !== "REAL_SUPPLIED_TESTIMONIAL" && firstPersonTestimony.test(allCreativeText)) findings.push("AI UGC cannot fabricate first-person customer testimony.");
  }
  const factText = [draft.coreAngle, draft.primaryPromise, draft.proofMechanism, draft.offerFraming, draft.creativeVisualExecutionNotes].join(" ");
  const supportedFacts = input.authoritativeConstraints.filter((item) => item.authority === "FACTUAL_CLAIM" && item.sourceType !== "REFERENCE_VISUAL").map((item) => normalize(item.text)).join(" ");
  for (const match of factText.match(factualRiskTerms) ?? []) if (!supportedFacts.includes(normalize(match))) findings.push(`Potential unsupported factual claim: ${match}.`);
  if (findings.some((item) => item.startsWith("Missing") || item.includes("not supplied"))) return { state: "MISSING_REQUIRED_REAL_ASSET", findings };
  if (findings.some((item) => item.includes("testimony"))) return { state: "UNSAFE_AI_TESTIMONIAL", findings };
  if (findings.some((item) => item.includes("unsupported"))) return { state: "UNSUPPORTED_PRODUCT_CLAIM", findings };
  if (findings.some((item) => item.includes("Buyer persona"))) return { state: "NEEDS_OPERATOR_REVIEW", findings };
  return { state: "PRODUCTION_SAFE", findings };
}

function similarityDimensions(left: StrategyConceptDraft, right: StrategyConceptDraft): number {
  const pairs: Array<[string, string]> = [
    [left.buyerPersona, right.buyerPersona], [left.customerDesireOrProblem, right.customerDesireOrProblem],
    [left.coreAngle, right.coreAngle], [left.emotionalTerritory, right.emotionalTerritory],
    [left.awarenessLevel, right.awarenessLevel],
    [left.openingVisualPattern, right.openingVisualPattern], [left.creativeFormat, right.creativeFormat],
    [left.primaryProductionMethod, right.primaryProductionMethod],
    [left.supportingProductionMethods.join("|"), right.supportingProductionMethods.join("|")],
    [left.proofMechanism, right.proofMechanism], [left.offerFraming, right.offerFraming],
    [left.differentiationSummary, right.differentiationSummary]
  ];
  return pairs.filter(([a, b]) => normalize(a) === normalize(b)).length;
}

export function validateStrategySet(concepts: readonly StrategyConcept[], input: StrategyGenerationInput): readonly { conceptId: string; revisionId: string; diversityState: StrategyDiversityState; productionSafetyState: StrategyProductionSafetyState; findings: readonly string[] }[] {
  return concepts.map((concept, index) => {
    validateStrategyDraft(concept.currentRevision, input);
    const findings: string[] = [];
    let diversityState: StrategyDiversityState = "DISTINCT";
    for (const [otherIndex, other] of concepts.entries()) {
      // Preserve the first valid direction deterministically. Only a later
      // concept is marked for repair when it duplicates an earlier slot.
      if (otherIndex >= index) continue;
      const sameFamily = normalize(concept.currentRevision.conceptFamily) === normalize(other.currentRevision.conceptFamily);
      const sameAngle = normalize(concept.currentRevision.coreAngle) === normalize(other.currentRevision.coreAngle);
      const matches = similarityDimensions(concept.currentRevision, other.currentRevision);
      if (sameAngle || (sameFamily && matches >= 3)) {
        diversityState = "DUPLICATE_REPLACEMENT_REQUIRED";
        findings.push(`Strategically duplicates slot ${other.ordinal}.`);
        break;
      }
      if (sameFamily && matches >= 2) {
        diversityState = "NEEDS_DIFFERENTIATION";
        findings.push(`Too close to slot ${other.ordinal} across structured strategy dimensions.`);
      }
    }
    const safety = safetyFor(concept.currentRevision, input);
    return { conceptId: concept.id, revisionId: concept.currentRevision.id, diversityState, productionSafetyState: safety.state, findings: [...findings, ...safety.findings] };
  });
}

function validateDraftSet(drafts: readonly StrategyConceptDraft[], input: StrategyGenerationInput) {
  const concepts: StrategyConcept[] = drafts.map((draft) => ({
    id: `draft:${draft.ordinal}`,
    batchId: "draft",
    ordinal: draft.ordinal,
    currentRevision: {
      ...draft,
      id: `draft-revision:${draft.ordinal}`,
      conceptId: `draft:${draft.ordinal}`,
      batchId: "draft",
      revision: 1,
      source: "OPENAI",
      diversityState: "DISTINCT",
      productionSafetyState: "PRODUCTION_SAFE",
      validationFindings: [],
      providerMetadata: {},
      createdBy: "validator",
      createdAt: "1970-01-01T00:00:00.000Z"
    },
    status: "ACTIVE",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z"
  }));
  return validateStrategySet(concepts, input).map((result, index) => ({ ...result, ordinal: drafts[index]!.ordinal }));
}

export class CreativeStrategyService {
  constructor(private readonly dependencies: Readonly<{ repository: FactoryRepository; strategies: StrategyRepository; creativeProvider: CreativeProvider; creativeDna?: CreativeDnaRepository; now?: () => Date; id?: () => string }>) {}
  private now() { return (this.dependencies.now ?? (() => new Date()))().toISOString(); }
  private id() { return (this.dependencies.id ?? randomUUID)(); }

  async createBatch(projectId: string, requestId: string, actor: string, requestedCount: StrategyRequestedCount = DEFAULT_STRATEGY_REQUESTED_COUNT): Promise<StrategyBatch> {
    if (!STRATEGY_REQUESTED_COUNTS.includes(requestedCount)) throw new DomainError("STRATEGY_COUNT_INVALID", "Strategy count must be 3, 6, or 12.");
    const project = await this.dependencies.repository.getProject(projectId);
    const operationKey = `strategy:${project.id}:${requestId}`;
    const existingBatches = await this.dependencies.strategies.listBatches(projectId);
    const idempotent = existingBatches.find(({ batch }) => batch.operationKey === operationKey);
    if (idempotent) return idempotent.batch;
    if (existingBatches.some(({ batch }) => ["PENDING", "GENERATING", "VALIDATING"].includes(batch.status))) {
      throw new DomainError("STRATEGY_GENERATION_ACTIVE", "A Strategy generation operation is already active for this project. Refresh its status instead of generating again.");
    }
    const product = await this.dependencies.repository.getProduct(project.productId);
    const history = boundStrategyHistory(await this.dependencies.strategies.listProductHistory(product.id));
    const assetsById = new Map(product.assets.map((asset) => [asset.id, asset]));
    const selectedAssets = project.selectedProductAssetIds.flatMap((assetId) => {
      const asset = assetsById.get(assetId);
      return asset ? [asset] : [];
    }).slice(0, STRATEGY_LIMITS.selectedAssets);
    const factual: StrategyEvidenceConstraint[] = product.claims.slice(0, STRATEGY_LIMITS.constraints).map((claim, index) => ({ text: claim.text.slice(0, STRATEGY_LIMITS.constraintText), sourceType: "VERIFIED_PRODUCT_CLAIM", authority: "FACTUAL_CLAIM", sourceId: `${claim.kind}:${index}` }));
    const visual: StrategyEvidenceConstraint[] = selectedAssets.filter((asset) => asset.kind === "IMAGE").slice(0, STRATEGY_LIMITS.visualFidelityRequirements).map((asset) => ({ text: `Preserve the product silhouette, layout, visible text, proportions, positions, colors, and visible details shown in ${asset.label}.`.slice(0, STRATEGY_LIMITS.constraintText), sourceType: "REFERENCE_VISUAL", authority: "VISUAL_EVIDENCE", sourceId: asset.id }));
    const capabilities: StrategyAssetCapability[] = [...new Set(selectedAssets.flatMap((asset) => asset.kind === "VIDEO" ? ["REAL_PRODUCT_VIDEO" as const] : ["PRODUCT_IMAGE" as const, "PRODUCT_MOCKUP" as const, "CUSTOMER_REFERENCE_IMAGE" as const]))];
    const input: StrategyGenerationInput = { productName: product.name, productDescription: product.description.slice(0, STRATEGY_LIMITS.productDescription), verifiedClaims: product.claims.slice(0, STRATEGY_LIMITS.constraints), selectedAssets: selectedAssets.map(({ id, kind, label, mimeType }) => ({ id, kind, label, mimeType })), additionalInstructions: project.additionalInstructions.slice(0, STRATEGY_LIMITS.additionalInstructions), targetDurationMs: (project.creativeBrief?.targetDurationSeconds ?? 15) * 1000, availableAssetCapabilities: capabilities, authoritativeConstraints: [...factual, ...visual], creativeHistory: history, requestedCount };
    const timestamp = this.now();
    const batch = await this.dependencies.strategies.createBatch({ id: this.id(), sourceProjectId: project.id, productId: product.id, operationKey, inputSnapshot: input, historySnapshot: history, historySha256: sha256(history), actor, timestamp });
    const job: WorkflowJob = { id: this.id(), dedupeKey: batch.operationKey, type: "GENERATE_STRATEGY", projectId: project.id, targetId: batch.id, status: "PENDING", attempts: 0, createdAt: timestamp, updatedAt: timestamp };
    await this.dependencies.repository.enqueueJob(job);
    return batch;
  }

  async requestReplacement(batchId: string, requestId: string, actor: string): Promise<StrategyBatch> {
    void actor;
    const batch = await this.dependencies.strategies.getBatch(batchId);
    const timestamp = this.now();
    await this.dependencies.repository.enqueueJob({ id: this.id(), dedupeKey: `strategy-replace:${batch.id}:${requestId}`, type: "REPLACE_STRATEGY", projectId: batch.sourceProjectId, targetId: batch.id, status: "PENDING", attempts: 0, createdAt: timestamp, updatedAt: timestamp });
    await this.dependencies.strategies.setBatchState(batch.id, "GENERATING", timestamp);
    return this.dependencies.strategies.getBatch(batch.id);
  }

  async processJob(jobId: string): Promise<WorkflowJob> {
    let job = await this.dependencies.repository.getJob(jobId);
    if (!['GENERATE_STRATEGY','REPLACE_STRATEGY'].includes(job.type)) throw new DomainError("INVALID_STRATEGY_JOB", "The job is not a strategy operation.");
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    const started = this.now();
    const { nextAttemptAt: _nextAttemptAt, ...jobWithoutSchedule } = job;
    void _nextAttemptAt;
    job = { ...jobWithoutSchedule, status: "RUNNING", attempts: job.attempts + 1, updatedAt: started };
    await this.dependencies.repository.saveJob(job);
    try {
      if (job.type === "GENERATE_STRATEGY") await this.generate(job.targetId);
      else await this.replaceFlagged(job.targetId, `explicit:${job.dedupeKey}`);
      job = { ...job, status: "COMPLETED", updatedAt: this.now() };
    } catch (error) {
      // Domain/provider validation failures require operator intervention. An
      // infrastructure failure remains pending so BullMQ can redeliver; a
      // durable SUCCEEDED provider result is then reused without another call.
      const retryableInfrastructureFailure = !(error instanceof DomainError);
      job = { ...job, status: retryableInfrastructureFailure ? "PENDING" : "FAILED", ...(error instanceof StrategyPollPending ? { nextAttemptAt: error.nextAttemptAt } : {}), lastError: error instanceof Error ? error.message : "Strategy operation failed.", updatedAt: this.now() };
      if (!retryableInfrastructureFailure) {
        const batch = await this.dependencies.strategies.getBatch(job.targetId);
        if (!["SUBMISSION_UNKNOWN", "RESULT_UNAVAILABLE", "FAILED", "REVIEW", "REVIEW_WITH_ISSUES", "HANDED_OFF"].includes(batch.status)) {
          await this.dependencies.strategies.setBatchState(batch.id, "FAILED", this.now());
        }
      }
    }
    await this.dependencies.repository.saveJob(job);
    return job;
  }

  private async providerCall(batch: StrategyBatch, kind: "INITIAL" | "AUTO_REPAIR" | "EXPLICIT_REPLACEMENT", input: StrategyGenerationInput, operationKey: string) {
    const provider = this.dependencies.creativeProvider;
    if (!provider.submitStrategyConcepts || !provider.retrieveStrategyConcepts) throw new DomainError("STRATEGY_PROVIDER_UNAVAILABLE", "The configured creative provider does not support durable background Strategy generation.");
    let operation = await this.dependencies.strategies.getOrCreateOperation({ id: this.id(), batchId: batch.id, kind, operationKey, timestamp: this.now() });
    if (operation.status === "SUCCEEDED") {
      if (!operation.result) throw new DomainError("STRATEGY_RESULT_UNAVAILABLE", "The completed strategy operation has no durable result; it will not be submitted again automatically.");
      return operation.result;
    }
    if (operation.status === "FAILED") throw new DomainError("STRATEGY_PROVIDER_FAILED", "The strategy provider request failed and requires an explicit operator action; it will not be repeated automatically.");
    if (operation.status === "SUBMISSION_UNKNOWN") throw new DomainError("STRATEGY_SUBMISSION_UNKNOWN", "Strategy provider outcome is unknown; it will not be repeated automatically.");
    if (operation.status === "RESULT_UNAVAILABLE") throw new DomainError("STRATEGY_RESULT_UNAVAILABLE", "The known Strategy response is no longer retrievable; it will not be submitted again automatically.");
    if (operation.status === "SUBMITTING") {
      const ageMs = Date.now() - Date.parse(operation.updatedAt);
      if (Number.isFinite(ageMs) && ageMs < 120_000) throw new Error("The strategy provider operation is already in progress.");
      await this.dependencies.strategies.failOperation(operation.id, "SUBMISSION_UNKNOWN", "The paid strategy request was interrupted after submission began; it will not be retried automatically.");
      await this.dependencies.strategies.setBatchState(batch.id, "SUBMISSION_UNKNOWN", this.now());
      throw new DomainError("STRATEGY_SUBMISSION_UNKNOWN", "Strategy provider outcome is unknown; explicit operator review is required.");
    }
    if (operation.status === "POLLING") {
      if (!operation.responseId) {
        await this.dependencies.strategies.failOperation(operation.id, "RESULT_UNAVAILABLE", "The Strategy operation is known to have been submitted but its provider response ID is unavailable.");
        await this.dependencies.strategies.setBatchState(batch.id, "RESULT_UNAVAILABLE", this.now());
        throw new DomainError("STRATEGY_RESULT_UNAVAILABLE", "The known Strategy submission cannot be recovered without its response ID.");
      }
      let response: StrategyProviderResponse;
      const polledAt = this.now();
      try {
        response = await provider.retrieveStrategyConcepts(operation.responseId);
      } catch (error) {
        if (error instanceof DomainError && error.code === "OPENAI_STRATEGY_RESULT_UNAVAILABLE") {
          await this.dependencies.strategies.failOperation(operation.id, "RESULT_UNAVAILABLE", error.message);
          await this.dependencies.strategies.setBatchState(batch.id, "RESULT_UNAVAILABLE", polledAt);
          throw new DomainError("STRATEGY_RESULT_UNAVAILABLE", "The known Strategy response is no longer retrievable; automatic resubmission is disabled.");
        }
        if (error instanceof DomainError) {
          await this.dependencies.strategies.failOperation(operation.id, "FAILED", error.message);
          await this.dependencies.strategies.setBatchState(batch.id, "FAILED", polledAt);
          throw error;
        }
        await this.dependencies.strategies.recordOperationPollFailure(operation.id, { polledAt, message: error instanceof Error ? error.message : "Strategy response retrieval failed." });
        throw new StrategyPollPending("Strategy response retrieval will resume without creating another response.", polledAt);
      }
      await this.dependencies.strategies.recordOperationPoll(operation.id, { response, polledAt });
      return this.finishProviderResponse(batch, operation.id, input, operationKey, response);
    }
    const begun = await this.dependencies.strategies.beginOperation(operation.id);
    if (!begun.claimed) {
      if (begun.operation.status === "SUCCEEDED" && begun.operation.result) return begun.operation.result;
      if (begun.operation.status === "SUBMITTING") {
        const ageMs = Date.now() - Date.parse(begun.operation.updatedAt);
        if (Number.isFinite(ageMs) && ageMs < 120_000) throw new Error("The strategy provider operation is already in progress.");
        await this.dependencies.strategies.failOperation(operation.id, "SUBMISSION_UNKNOWN", "The paid strategy request remained in submitting state after its recovery window; it will not be repeated automatically.");
        await this.dependencies.strategies.setBatchState(batch.id, "SUBMISSION_UNKNOWN", this.now());
        throw new DomainError("STRATEGY_SUBMISSION_UNKNOWN", "Strategy provider outcome is unknown; explicit operator review is required.");
      }
      throw new DomainError("STRATEGY_PROVIDER_NOT_CLAIMED", "The strategy provider operation cannot be submitted automatically in its current state.");
    }
    try {
      const submittedAt = this.now();
      const response = await provider.submitStrategyConcepts(input, { operationKey, projectId: batch.sourceProjectId, targetId: batch.id });
      await this.dependencies.strategies.recordOperationSubmission(operation.id, { response, submittedAt });
      operation = { ...operation, status: "POLLING", responseId: response.responseId, model: response.model, submittedAt, latestProviderStatus: response.status };
      return await this.finishProviderResponse(batch, operation.id, input, operationKey, response);
    } catch (error) {
      if (error instanceof StrategyPollPending) throw error;
      const unknown = error instanceof DomainError && error.code.endsWith("SUBMISSION_UNKNOWN");
      await this.dependencies.strategies.failOperation(operation.id, unknown ? "SUBMISSION_UNKNOWN" : "FAILED", error instanceof Error ? error.message : "Strategy provider failed.");
      await this.dependencies.strategies.setBatchState(batch.id, unknown ? "SUBMISSION_UNKNOWN" : "FAILED", this.now());
      throw error;
    }
  }

  private async finishProviderResponse(batch: StrategyBatch, operationId: string, input: StrategyGenerationInput, operationKey: string, response: StrategyProviderResponse) {
    if (response.status === "queued" || response.status === "in_progress") {
      throw new StrategyPollPending(`Strategy response is ${response.status}; polling will resume from the persisted response ID.`, this.now());
    }
    if (response.status !== "completed") {
      const message = response.safeError?.message ?? `OpenAI Strategy response ended with status ${response.status}.`;
      await this.dependencies.strategies.failOperation(operationId, "FAILED", message);
      await this.dependencies.strategies.setBatchState(batch.id, "FAILED", this.now());
      throw new DomainError("STRATEGY_PROVIDER_TERMINAL_FAILURE", message);
    }
    if (!response.outputText) {
      await this.dependencies.strategies.failOperation(operationId, "FAILED", "The completed Strategy response contained no structured output.");
      await this.dependencies.strategies.setBatchState(batch.id, "FAILED", this.now());
      throw new DomainError("OPENAI_STRATEGY_INVALID", "The completed Strategy response contained no structured output.");
    }
    let concepts: readonly StrategyProviderConceptDraft[];
    try {
      const parsed = JSON.parse(response.outputText) as { concepts?: readonly StrategyProviderConceptDraft[] };
      concepts = parsed.concepts ?? [];
    } catch {
      await this.dependencies.strategies.failOperation(operationId, "FAILED", "The completed Strategy response contained malformed structured output.");
      await this.dependencies.strategies.setBatchState(batch.id, "FAILED", this.now());
      throw new DomainError("OPENAI_STRATEGY_INVALID", "OpenAI returned malformed structured Strategy data.");
    }
    const expectedCount = input.replacementOrdinals?.length ?? input.requestedCount;
    if (concepts.length !== expectedCount) {
      await this.dependencies.strategies.failOperation(operationId, "FAILED", "The completed Strategy response returned the wrong number of concepts.");
      await this.dependencies.strategies.setBatchState(batch.id, "FAILED", this.now());
      throw new DomainError("OPENAI_STRATEGY_INVALID", "OpenAI returned the wrong number of Strategy concepts.");
    }
    const result = { concepts, submission: { provider: response.provider, model: response.model, providerTaskId: response.responseId, requestId: response.responseId, metadata: sanitizeMetadata({ promptVersion: "creative-strategy/v1", operationKey, ...response.usage }) } };
    await this.dependencies.strategies.completeOperation(operationId, result);
    return result;
  }

  private async generate(batchId: string): Promise<void> {
    let batch = await this.dependencies.strategies.getBatch(batchId);
    let concepts = await this.dependencies.strategies.listConcepts(batch.id);
    if (concepts.length === 0) {
      await this.dependencies.strategies.setBatchState(batch.id, "GENERATING", this.now());
      const result = await this.providerCall(batch, "INITIAL", batch.inputSnapshot, `${batch.operationKey}:initial`);
      if (!result) throw new DomainError("STRATEGY_OPERATION_ALREADY_COMPLETED", "Strategy initial operation was already completed without persisted concepts.");
      if (result.concepts.length !== batch.requestedCount || new Set(result.concepts.map((item) => item.ordinal)).size !== batch.requestedCount) throw new DomainError("STRATEGY_PROVIDER_INVALID", `Strategy provider must return exactly ${batch.requestedCount} unique slots.`);
      let drafts = result.concepts.map((item) => canonicalizeStrategyDraft(item, batch.inputSnapshot));
      let draftValidation = validateDraftSet(drafts, batch.inputSnapshot);
      const flagged = draftValidation.filter((item) => item.diversityState !== "DISTINCT" || item.productionSafetyState !== "PRODUCTION_SAFE");
      let automaticRepairAttempted = false;
      let providerMetadata: Readonly<Record<string, unknown>> = {
        initial: submissionMetadata(result.submission)
      };
      if (flagged.length > 0 && !batch.automaticRepairAttempted) {
        await this.dependencies.strategies.setBatchState(batch.id, "VALIDATING", this.now());
        const ordinals = flagged.map((item) => item.ordinal);
        const flaggedOrdinals = new Set(ordinals);
        const preserved = drafts.filter((draft) => !flaggedOrdinals.has(draft.ordinal)).map(providerFields);
        const repairInput: StrategyGenerationInput = { ...batch.inputSnapshot, preservedConcepts: preserved, replacementOrdinals: ordinals, replacementFindings: flagged.map((item) => ({ ordinal: item.ordinal, findings: item.findings })) };
        const repair = await this.providerCall(batch, "AUTO_REPAIR", repairInput, `${batch.operationKey}:auto-repair`);
        if (repair.concepts.length !== ordinals.length || repair.concepts.some((item) => !flaggedOrdinals.has(item.ordinal))) throw new DomainError("STRATEGY_REPAIR_INVALID", "Automatic repair must return exactly the flagged slots.");
        const replacements = new Map(repair.concepts.map((item) => [item.ordinal, canonicalizeStrategyDraft(item, batch.inputSnapshot)]));
        drafts = drafts.map((draft) => replacements.get(draft.ordinal) ?? draft);
        draftValidation = validateDraftSet(drafts, batch.inputSnapshot);
        automaticRepairAttempted = true;
        providerMetadata = {
          ...providerMetadata,
          repair: submissionMetadata(repair.submission)
        };
      }
      await this.dependencies.strategies.saveGeneratedConcepts({ batchId: batch.id, concepts: drafts, source: "OPENAI", actor: batch.createdBy, providerMetadata, timestamp: this.now() });
      concepts = await this.dependencies.strategies.listConcepts(batch.id);
      batch = await this.dependencies.strategies.getBatch(batch.id);
      const validation = validateStrategySet(concepts, batch.inputSnapshot);
      const valid = validation.filter((item) => item.diversityState === "DISTINCT" && item.productionSafetyState === "PRODUCTION_SAFE").length;
      await this.dependencies.strategies.saveValidation({ batchId: batch.id, results: validation, status: valid === batch.requestedCount ? "REVIEW" : "REVIEW_WITH_ISSUES", automaticRepairAttempted, summary: { valid, total: batch.requestedCount, automaticProviderRequestLimit: 2 }, timestamp: this.now() });
      return;
    }
    const validation = validateStrategySet(concepts, batch.inputSnapshot);
    const valid = validation.filter((item) => item.diversityState === "DISTINCT" && item.productionSafetyState === "PRODUCTION_SAFE").length;
    await this.dependencies.strategies.saveValidation({ batchId: batch.id, results: validation, status: valid === batch.requestedCount ? "REVIEW" : "REVIEW_WITH_ISSUES", automaticRepairAttempted: batch.automaticRepairAttempted, summary: { valid, total: batch.requestedCount, automaticProviderRequestLimit: 2 }, timestamp: this.now() });
  }

  private async replaceFlagged(batchId: string, operationKey: string): Promise<void> {
    const batch = await this.dependencies.strategies.getBatch(batchId);
    await this.dependencies.strategies.setBatchState(batch.id, "GENERATING", this.now());
    const concepts = await this.dependencies.strategies.listConcepts(batch.id);
    const validation = validateStrategySet(concepts, batch.inputSnapshot);
    const flaggedIds = new Set(validation.filter((item) => item.diversityState !== "DISTINCT" || item.productionSafetyState !== "PRODUCTION_SAFE").map((item) => item.revisionId));
    const ordinals = concepts.filter((item) => flaggedIds.has(item.currentRevision.id)).map((item) => item.ordinal);
    if (ordinals.length === 0) throw new DomainError("STRATEGY_REPLACEMENT_NOT_REQUIRED", "No strategy slots require replacement.");
    const preserved = concepts.filter((item) => !flaggedIds.has(item.currentRevision.id)).map((item) => providerFields(item.currentRevision));
    const result = await this.providerCall(batch, "EXPLICIT_REPLACEMENT", { ...batch.inputSnapshot, preservedConcepts: preserved, replacementOrdinals: ordinals, replacementFindings: validation.filter((item) => flaggedIds.has(item.revisionId)).map((item) => ({ ordinal: concepts.find((concept) => concept.currentRevision.id === item.revisionId)!.ordinal, findings: item.findings })) }, operationKey);
    if (!result) return;
    if (result.concepts.length !== ordinals.length || result.concepts.some((item) => !ordinals.includes(item.ordinal))) throw new DomainError("STRATEGY_REPAIR_INVALID", "Replacement must return exactly the flagged slots.");
    const replacements = result.concepts.map((item) => canonicalizeStrategyDraft(item, batch.inputSnapshot));
    await this.dependencies.strategies.saveGeneratedConcepts({ batchId: batch.id, concepts: replacements, replaceOrdinals: ordinals, source: "OPERATOR_REPLACEMENT", actor: batch.createdBy, providerMetadata: submissionMetadata(result.submission), timestamp: this.now() });
    const updated = await this.dependencies.strategies.listConcepts(batch.id);
    const next = validateStrategySet(updated, batch.inputSnapshot);
    const valid = next.filter((item) => item.diversityState === "DISTINCT" && item.productionSafetyState === "PRODUCTION_SAFE").length;
    await this.dependencies.strategies.saveValidation({ batchId: batch.id, results: next, status: valid === batch.requestedCount ? "REVIEW" : "REVIEW_WITH_ISSUES", automaticRepairAttempted: true, summary: { valid, total: batch.requestedCount, explicitReplacement: true }, timestamp: this.now() });
  }

  async handoff(batchId: string, revisionIds: readonly string[], requestId: string, actor: string, winnerDnaRevisionId?: string): Promise<readonly CreativeProject[]> {
    if (revisionIds.length < 1 || revisionIds.length > 3 || new Set(revisionIds).size !== revisionIds.length) throw new DomainError("STRATEGY_SELECTION_INVALID", "Select between one and three unique strategy concepts.");
    const batch = await this.dependencies.strategies.getBatch(batchId);
    const concepts = await this.dependencies.strategies.listConcepts(batch.id);
    const validation = validateStrategySet(concepts, batch.inputSnapshot);
    for (const revisionId of revisionIds) {
      const result = validation.find((item) => item.revisionId === revisionId);
      if (!result || result.diversityState !== "DISTINCT" || result.productionSafetyState !== "PRODUCTION_SAFE") throw new DomainError("STRATEGY_SELECTION_NOT_READY", "Only current distinct and production-safe strategy revisions can be sent to Video Maker.");
    }
    let winnerDna:SelectedWinnerDnaSnapshot|undefined;
    if(winnerDnaRevisionId){if(!this.dependencies.creativeDna)throw new DomainError("CREATIVE_DNA_UNAVAILABLE","Winner DNA is not configured.");const revision=await this.dependencies.creativeDna.getRevision(winnerDnaRevisionId);if(revision.status!=="APPROVED")throw new DomainError("CREATIVE_DNA_REVISION_NOT_APPROVED","Only an approved Winner DNA revision can be selected.");const reference=await this.dependencies.creativeDna.getReference(revision.creativeReferenceId);if(reference.productId&&reference.productId!==batch.productId)throw new DomainError("CREATIVE_DNA_PRODUCT_MISMATCH","Winner DNA belongs to another Product.");const{providerMetadata:_p,...body}=revision;void _p;winnerDna={...body,referenceDisplayName:reference.displayName,revisionSha256:sha256(body)};}
    const product=await this.dependencies.repository.getProduct(batch.productId);
    const timestamp=this.now();
    const inputSnapshots=revisionIds.map((revisionId)=>{
      const revision=concepts.find((item)=>item.currentRevision.id===revisionId)!.currentRevision;
      const selectedStrategy=selectedStrategySnapshot(revision);
      const snapshotInput:CreativeInputSnapshot={
        productName:batch.inputSnapshot.productName,
        description:batch.inputSnapshot.productDescription,
        claims:[...product.claims],
        defaultCta:product.defaultCta,
        ...(product.creativeNotes?{creativeNotes:product.creativeNotes}:{}),
        selectedAssets:[...batch.inputSnapshot.selectedAssets],
        additionalInstructions:`Authoritative strategy ${revision.id}: ${revision.differentiationSummary}`,
        creativeTopic:`${revision.conceptName}: ${revision.coreAngle}`,
        ...(product.personalizationVisualAuthority?{personalizationVisualAuthority:product.personalizationVisualAuthority}:{}),
        targetDurationMs:batch.inputSnapshot.targetDurationMs,
        productionCapabilities:[...batch.inputSnapshot.availableAssetCapabilities],
        selectedStrategy,
        ...(winnerDna?{selectedWinnerDna:winnerDna}:{})
      };
      const snapshot:CreativeHandoffInputSnapshot={id:this.id(),input:snapshotInput,sha256:creativeInputSnapshotSha256(snapshotInput),createdAt:timestamp};
      return{revisionId,snapshot};
    });
    return this.dependencies.strategies.createHandoff({ batchId, revisionIds, requestId, actor, timestamp, inputSnapshots, ...(winnerDna?{winnerDna}:{}) });
  }

  async list(projectId: string) { return this.dependencies.strategies.listBatches(projectId); }
  isPristineSource(project: CreativeProject) { return isReusableAsPristineStrategySource(project); }
}

export function selectedStrategySnapshot(revision: StrategyConceptRevision) {
  const { providerMetadata: _providerMetadata, validationFindings: _validationFindings, ...snapshot } = revision;
  void _providerMetadata;
  void _validationFindings;
  return { ...snapshot, revisionSha256: sha256(snapshot) };
}
