import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CreativeFactoryService, CreativeStrategyService, STRATEGY_LIMITS, boundStrategyHistory, canonicalizeStrategyDraft, conceptProviderResultSha256, validateStrategyDraft, validateStrategySet } from "@koolezt/application";
import { InMemoryCreativeStrategyStore, InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";
import { DomainError } from "@koolezt/domain";
import type { CreativeProvider, GeneratedAsset, StrategyConcept, StrategyConceptDraft, StrategyGenerationInput, StrategyHistoryEntry, StrategyProviderConceptDraft, StrategyProviderResponse, StrategyRequestedCount } from "@koolezt/domain";

async function harness(provider: CreativeProvider = new FakeCreativeProvider(), storeFactory?: (repository: InMemoryFactoryRepository) => InMemoryCreativeStrategyStore, repositoryOverride?: InMemoryFactoryRepository) {
  const root = await mkdtemp(join(tmpdir(), "creative-strategy-"));
  const repository = repositoryOverride ?? new InMemoryFactoryRepository();
  const strategies = storeFactory?.(repository) ?? new InMemoryCreativeStrategyStore(repository);
  const storage = new LocalStorageProvider(join(root, "media"));
  const videoProvider = new FakeVideoGenerationProvider();
  const voiceProvider = new FakeVoiceProvider();
  const compositionProvider = new FakeCompositionProvider();
  const service = new CreativeFactoryService({
    repository, strategyRepository: strategies, creativeProvider: provider,
    videoProvider, voiceProvider, compositionProvider, externalMediaDelivery: new FakeExternalMediaDeliveryProvider(),
    compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage,
    mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  const strategyService = new CreativeStrategyService({ repository, strategies, creativeProvider: provider });
  return { repository, strategies, service, strategyService, videoProvider, voiceProvider, compositionProvider, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function createStrategyBatch(setup: Awaited<ReturnType<typeof harness>>, requestId = crypto.randomUUID()) {
  const project = await setup.service.createProjectFromBrief({ requestId, name: "Personalized Pet Sign", creativeTopic: "Find differentiated Meta ad directions", productDetails: "A sign personalized with the supplied pet image and address numbers.", verifiedClaims: ["Personalized with the supplied pet image", "Displays operator-supplied address numbers"], targetDurationSeconds: 15, actor: "editor" });
  const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 12);
  const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
  await setup.strategyService.processJob(job.id);
  return { project, batch: await setup.strategies.getBatch(batch.id), concepts: await setup.strategies.listConcepts(batch.id) };
}

const duplicateDraft = (ordinal: number, input: StrategyGenerationInput): StrategyConceptDraft => ({
  ordinal, conceptName: `Duplicate ${ordinal}`, conceptFamily: "Same gift idea", buyerPersona: "gift buyer",
  customerDesireOrProblem: "needs a personal gift", awarenessLevel: "solution aware", coreAngle: "A personal gift",
  emotionalTerritory: "warmth", primaryPromise: "A personal outcome", hook: "A personal gift",
  openingVisualPattern: "Product reveal", creativeFormat: "Product montage", primaryProductionMethod: "PRODUCT_IMAGE_MOTION",
  supportingProductionMethods: [], proofMechanism: "Show personalization", offerFraming: "Gift framing",
  ctaStrategy: "Create yours", differentiationSummary: `Duplicate candidate ${ordinal}`,
  creativeVisualExecutionNotes: `Show the supplied product reference for direction ${ordinal}.`,
  productTruthConstraints: input.authoritativeConstraints.filter((item) => item.authority === "FACTUAL_CLAIM"),
  visualFidelityRequirements: input.authoritativeConstraints.filter((item) => item.authority === "VISUAL_EVIDENCE"),
  requiredRealAssetCapabilities: [], ugcRepresentation: "NOT_APPLICABLE"
});

describe("Creative Strategy generation and validation", () => {
  it("uses the Campaign primary reference for future batches without mutating an earlier batch snapshot", async () => {
    const setup = await harness();
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Reference ordering", creativeTopic: "Distinct directions", productDetails: "Personalized sign", targetDurationSeconds: 15, actor: "editor" });
      const reference = (id: string, order: number): GeneratedAsset => ({ id, projectId: project.id, purpose: "PRODUCT_REFERENCE", kind: "IMAGE", storageKey: `private/${id}.png`, mimeType: "image/png", byteSize: 100, sha256: String(order).padStart(64, "0"), lifecycleStatus: "AVAILABLE", metadata: { referenceOrder: order }, createdAt: "2026-09-30T00:00:00.000Z" });
      const firstId = "11111111-1111-4111-8111-111111111111";
      const secondId = "22222222-2222-4222-8222-222222222222";
      await setup.service.attachProductReference({ projectId: project.id, asset: reference(firstId, 0), label: "First", order: 0, actor: "editor" });
      await setup.service.attachProductReference({ projectId: project.id, asset: reference(secondId, 1), label: "Second", order: 1, actor: "editor" });
      const firstBatch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 3);
      const firstJob = (await setup.repository.listJobs(project.id)).find((item) => item.targetId === firstBatch.id)!;
      await setup.strategyService.processJob(firstJob.id);
      const earlierSnapshot = structuredClone((await setup.strategies.getBatch(firstBatch.id)).inputSnapshot);
      const updated = await setup.service.setPrimaryProductReference(project.id, secondId, "editor");
      expect(updated.selectedProductAssetIds).toEqual([secondId, firstId]);
      const secondBatch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 3);
      expect(secondBatch.inputSnapshot.selectedAssets.map((asset) => asset.id)).toEqual([secondId, firstId]);
      expect((await setup.strategies.getBatch(firstBatch.id)).inputSnapshot).toEqual(earlierSnapshot);
      expect(earlierSnapshot.selectedAssets.map((asset) => asset.id)).toEqual([firstId, secondId]);
    } finally { await setup.dispose(); }
  });

  it("persists twelve structured, distinct concepts with one fake provider request and no media provider work", async () => {
    const creative = new FakeCreativeProvider();
    const setup = await harness(creative);
    try {
      const result = await createStrategyBatch(setup);
      expect(result.concepts).toHaveLength(12);
      expect(result.batch).toMatchObject({ status: "REVIEW", providerRequestCount: 1, automaticRepairAttempted: false });
      expect(result.concepts.every((item) => item.currentRevision.diversityState === "DISTINCT" && item.currentRevision.productionSafetyState === "PRODUCTION_SAFE")).toBe(true);
      expect(creative.calls).toHaveLength(1);
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    } finally { await setup.dispose(); }
  });

  it("uses at most one automatic repair and never introduces a hidden third provider call", async () => {
    const base = new FakeCreativeProvider();
    const submitStrategyConcepts = vi.fn(async (input: StrategyGenerationInput, context: Parameters<NonNullable<CreativeProvider["submitStrategyConcepts"]>>[1]) => ({
      responseId: `response-${context.operationKey}`, status: "completed" as const, provider: "fake-openai", model: "fake-strategy",
      outputText: JSON.stringify({ concepts: (input.replacementOrdinals ?? Array.from({ length: input.requestedCount }, (_, index) => index + 1)).map((ordinal) => duplicateDraft(ordinal, input)) })
    }));
    const provider: CreativeProvider = { generateConcept: base.generateConcept.bind(base), submitStrategyConcepts, retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base) };
    const setup = await harness(provider);
    try {
      const result = await createStrategyBatch(setup);
      expect(submitStrategyConcepts).toHaveBeenCalledTimes(2);
      expect(result.batch).toMatchObject({ status: "REVIEW_WITH_ISSUES", providerRequestCount: 2, automaticRepairAttempted: true });
      expect(result.concepts.some((item) => item.currentRevision.diversityState !== "DISTINCT")).toBe(true);
    } finally { await setup.dispose(); }
  });

  it("repairs only an in-range flagged ordinal and carries the immutable requested count into repair", async () => {
    const base = new FakeCreativeProvider();
    const requests: StrategyGenerationInput[] = [];
    const submitStrategyConcepts = vi.fn(async (strategyInput: StrategyGenerationInput, context: Parameters<NonNullable<CreativeProvider["submitStrategyConcepts"]>>[1]) => {
      requests.push(structuredClone(strategyInput));
      const response = await base.submitStrategyConcepts(strategyInput, context);
      if (strategyInput.replacementOrdinals) return response;
      const parsed = JSON.parse(response.outputText!) as { concepts: StrategyProviderConceptDraft[] };
      parsed.concepts[2] = { ...structuredClone(parsed.concepts[0]!), ordinal: 3 };
      return { ...response, outputText: JSON.stringify(parsed) };
    });
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts,
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base)
    };
    const setup = await harness(provider);
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Three-way repair", creativeTopic: "Distinct directions", productDetails: "Personalized product", targetDurationSeconds: 15, actor: "editor" });
      const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 3);
      const job = (await setup.repository.listJobs(project.id))[0]!;
      expect((await setup.strategyService.processJob(job.id)).status).toBe("COMPLETED");
      expect(submitStrategyConcepts).toHaveBeenCalledTimes(2);
      expect(requests[0]).toMatchObject({ requestedCount: 3 });
      expect(requests[1]).toMatchObject({ requestedCount: 3, replacementOrdinals: [3] });
      expect(requests[1]!.replacementOrdinals!.every((ordinal) => ordinal <= requests[1]!.requestedCount)).toBe(true);
      expect((await setup.strategies.listConcepts(batch.id))).toHaveLength(3);
    } finally { await setup.dispose(); }
  });

  it("keeps reference images as visual evidence and rejects using them as factual authority", () => {
    const input: StrategyGenerationInput = { productName: "Sign", productDescription: "Visible sign", verifiedClaims: [], selectedAssets: [{ id: "image-1", kind: "IMAGE", label: "Reference", mimeType: "image/png" }], additionalInstructions: "", targetDurationMs: 15_000, availableAssetCapabilities: ["PRODUCT_IMAGE"], authoritativeConstraints: [{ text: "Preserve visible numbers", sourceType: "REFERENCE_VISUAL", authority: "VISUAL_EVIDENCE", sourceId: "image-1" }], creativeHistory: [], requestedCount: 12 };
    expect(() => validateStrategyDraft({ ...duplicateDraft(1, input), productTruthConstraints: [{ text: "Made from weatherproof steel", sourceType: "REFERENCE_VISUAL", authority: "FACTUAL_CLAIM", sourceId: "image-1" }] }, input)).toThrow("reference images are visual evidence only");
  });

  it("rejects unavailable real filming and fabricated AI-UGC customer testimony using local validation", () => {
    const input: StrategyGenerationInput = { productName: "Sign", productDescription: "Visible sign", verifiedClaims: [], selectedAssets: [], additionalInstructions: "", targetDurationMs: 15_000, availableAssetCapabilities: [], authoritativeConstraints: [], creativeHistory: [], requestedCount: 12 };
    const realUnboxing = { ...duplicateDraft(1, input), conceptFamily: "unboxing", coreAngle: "A real customer unboxing", openingVisualPattern: "Real customer unboxing at home" };
    const fakeTestimony = { ...duplicateDraft(2, input), conceptFamily: "ugc", primaryProductionMethod: "AI_UGC_STYLE" as const, ugcRepresentation: "AI_STYLE_NON_CUSTOMER" as const, hook: "I bought this and love it" };
    const concepts = [realUnboxing, fakeTestimony].map((draft, index) => ({ id: `c-${index}`, batchId: "batch", ordinal: draft.ordinal, status: "ACTIVE" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", currentRevision: { ...draft, id: `r-${index}`, conceptId: `c-${index}`, batchId: "batch", revision: 1, source: "OPENAI" as const, diversityState: "DISTINCT" as const, productionSafetyState: "PRODUCTION_SAFE" as const, validationFindings: [], providerMetadata: {}, createdBy: "test", createdAt: "2026-01-01T00:00:00.000Z" } }));
    const results = validateStrategySet(concepts, input);
    expect(results[0]).toMatchObject({ productionSafetyState: "MISSING_REQUIRED_REAL_ASSET" });
    expect(results[1]).toMatchObject({ productionSafetyState: "UNSAFE_AI_TESTIMONIAL" });
  });

  it("bounds creative history deterministically by entries, families, batches upstream, and serialized bytes", () => {
    const entries: StrategyHistoryEntry[] = Array.from({ length: 100 }, (_, index) => ({ conceptRevisionId: `r-${String(index).padStart(3, "0")}`, conceptFamily: `family-${index}`, buyerPersona: `purchase-context-${index}`, customerDesireOrProblem: "x".repeat(200), coreAngle: `angle-${index}`, emotionalTerritory: `emotion-${index}`, openingVisualPattern: `opening-${index}`, creativeFormat: `format-${index}`, primaryProductionMethod: "MOTION_GRAPHICS", supportingProductionMethods: [], proofMechanism: `proof-${index}`, offerFraming: `offer-${index}`, differentiationSummary: "d".repeat(300) }));
    const first = boundStrategyHistory(entries);
    const second = boundStrategyHistory(entries);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(STRATEGY_LIMITS.historyEntries);
    expect(new Set(first.map((item) => item.conceptFamily)).size).toBeLessThanOrEqual(STRATEGY_LIMITS.historyFamilies);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(STRATEGY_LIMITS.historySerializedBytes);
  });

  it("replays a durable provider result after a transient persistence failure without another provider call", async () => {
    class FlakyStore extends InMemoryCreativeStrategyStore {
      private failOnce = true;
      override async saveGeneratedConcepts(input: Parameters<InMemoryCreativeStrategyStore["saveGeneratedConcepts"]>[0]) {
        if (this.failOnce) { this.failOnce = false; throw new Error("temporary database outage"); }
        return super.saveGeneratedConcepts(input);
      }
    }
    const creative = new FakeCreativeProvider();
    const setup = await harness(creative, (repository) => new FlakyStore(repository));
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Pet sign", creativeTopic: "Diverse strategy", productDetails: "Personalized sign", targetDurationSeconds: 15, actor: "editor" });
      await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor");
      const job = (await setup.repository.listJobs(project.id))[0]!;
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.strategyService.processJob(job.id)).status).toBe("COMPLETED");
      expect(creative.calls).toHaveLength(1);
    } finally { await setup.dispose(); }
  });

  it("grants only one paid-provider submission claim for a strategy operation", async () => {
    const setup = await harness();
    try {
      const timestamp = new Date().toISOString();
      const project = await setup.service.createProjectFromBrief({
        requestId: crypto.randomUUID(),
        name: "Pet sign",
        creativeTopic: "Diverse strategy",
        productDetails: "Personalized sign",
        targetDurationSeconds: 15,
        actor: "editor"
      });
      const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor");
      const operation = await setup.strategies.getOrCreateOperation({
        id: crypto.randomUUID(),
        batchId: batch.id,
        kind: "INITIAL",
        operationKey: crypto.randomUUID(),
        timestamp
      });
      const [first, second] = await Promise.all([
        setup.strategies.beginOperation(operation.id),
        setup.strategies.beginOperation(operation.id)
      ]);
      expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
      expect(first.operation.status).toBe("SUBMITTING");
      expect(second.operation.status).toBe("SUBMITTING");
    } finally { await setup.dispose(); }
  });
});

describe("recoverable background Creative Concept lifecycle", () => {
  class FailFirstConceptPersistenceRepository extends InMemoryFactoryRepository {
    private failed=false;
    override async saveProject(project:Parameters<InMemoryFactoryRepository["saveProject"]>[0]):Promise<void>{
      if(project.state==="CONCEPT_REVIEW"&&!this.failed){this.failed=true;throw new Error("simulated local persistence interruption");}
      return super.saveProject(project);
    }
  }
  async function strategyHandoff(setup: Awaited<ReturnType<typeof harness>>) {
    const result = await createStrategyBatch(setup);
    const handed = await setup.strategyService.handoff(result.batch.id, [result.concepts[0]!.currentRevision.id], crypto.randomUUID(), "owner");
    return handed[0]!;
  }

  it("persists one Response ID and requeues queued/in_progress retrieval until one completed concept", async () => {
    const base = new FakeCreativeProvider();
    const submitConceptExecution = vi.fn(async (input: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[0], context: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[1]) => {
      const generated = await base.generateConcept(input, context);
      return { responseId: "resp_concept_background", status: "queued" as const, provider: "fake-openai", model: "fake-background", usage: {} , outputText: JSON.stringify(generated.concept) };
    });
    let retrieval = 0;
    const retrieveConceptExecution = vi.fn(async (): Promise<StrategyProviderResponse> => {
      retrieval += 1;
      const generated = await base.generateConcept((await setup.repository.getProject(project.id)).creativeInputSnapshot!.input, { operationKey: "fixture", projectId: project.id, targetId: "fixture" });
      return retrieval === 1
        ? { responseId: "resp_concept_background", status: "in_progress", provider: "fake-openai", model: "fake-background" }
        : { responseId: "resp_concept_background", status: "completed", provider: "fake-openai", model: "fake-background", outputText: JSON.stringify(generated.concept), usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } };
    });
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base),
      submitConceptExecution,
      retrieveConceptExecution
    };
    const setup = await harness(provider);
    let project!: Awaited<ReturnType<typeof strategyHandoff>>;
    try {
      project = await strategyHandoff(setup);
      await setup.service.generateConcept(project.id, "editor");
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      let operation = await setup.repository.getConceptProviderOperation(job.dedupeKey);
      expect(operation).toMatchObject({ state: "POLLING", providerTaskId: "resp_concept_background", latestProviderStatus: "queued" });
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      operation = await setup.repository.getConceptProviderOperation(job.dedupeKey);
      expect(operation).toMatchObject({ state: "SUCCEEDED", providerTaskId: "resp_concept_background", usage: { totalTokens: 33 } });
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
      expect(retrieveConceptExecution).toHaveBeenCalledTimes(2);
      expect(retrieveConceptExecution).toHaveBeenNthCalledWith(1, "resp_concept_background");
      expect((await setup.repository.getProject(project.id)).concepts).toHaveLength(1);
      expect((await setup.repository.getJob(job.id)).lastError).toBeUndefined();
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    } finally { await setup.dispose(); }
  });

  it("marks a pre-ID ambiguity terminal and never automatically submits again", async () => {
    const base = new FakeCreativeProvider();
    const submitConceptExecution = vi.fn(async () => { throw new DomainError("OPENAI_CONCEPT_SUBMISSION_UNKNOWN", "Submission outcome is unknown."); });
    const provider: CreativeProvider = { generateConcept: base.generateConcept.bind(base), submitStrategyConcepts: base.submitStrategyConcepts.bind(base), retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base), submitConceptExecution, retrieveConceptExecution: vi.fn() };
    const setup = await harness(provider);
    try {
      const project = await strategyHandoff(setup);
      await setup.service.generateConcept(project.id, "editor");
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      await expect(setup.service.processJob(job.id)).rejects.toMatchObject({ code: "OPENAI_CONCEPT_SUBMISSION_UNKNOWN" });
      expect(await setup.repository.getConceptProviderOperation(job.dedupeKey)).toMatchObject({ state: "SUBMISSION_UNKNOWN" });
      expect((await setup.repository.getProject(project.id)).state).toBe("DRAFT");
      expect((await setup.service.processJob(job.id)).status).toBe("FAILED");
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
    } finally { await setup.dispose(); }
  });

  it("marks a known unavailable result distinctly and retrieves without another create", async () => {
    const base = new FakeCreativeProvider();
    const submitConceptExecution = vi.fn(async () => ({ responseId: "resp_expired", status: "queued" as const, provider: "fake-openai", model: "fake-background" }));
    const retrieveConceptExecution = vi.fn(async () => { throw new DomainError("OPENAI_CONCEPT_RESULT_UNAVAILABLE", "Known result is no longer retrievable."); });
    const provider: CreativeProvider = { generateConcept: base.generateConcept.bind(base), submitStrategyConcepts: base.submitStrategyConcepts.bind(base), retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base), submitConceptExecution, retrieveConceptExecution };
    const setup = await harness(provider);
    try {
      const project = await strategyHandoff(setup);
      await setup.service.generateConcept(project.id, "editor");
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      await expect(setup.service.processJob(job.id)).rejects.toMatchObject({ code: "OPENAI_CONCEPT_RESULT_UNAVAILABLE" });
      expect(await setup.repository.getConceptProviderOperation(job.dedupeKey)).toMatchObject({ state: "RESULT_UNAVAILABLE", providerTaskId: "resp_expired" });
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
      expect(retrieveConceptExecution).toHaveBeenCalledTimes(1);
    } finally { await setup.dispose(); }
  });

  it("retains bounded usage and findings for semantic rejection without accepting a concept", async () => {
    const base = new FakeCreativeProvider();
    const submitConceptExecution = vi.fn(async (input: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[0], context: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[1]) => {
      const generated = await base.generateConcept(input, context);
      const rejected = { ...generated.concept, strategyExecutionSummary: "Moving into a new home? Send the perfect housewarming gift.", voiceScript: "Send the perfect moving gift." };
      return { responseId: "resp_rejected", status: "completed" as const, provider: "fake-openai", model: "fake-background", outputText: JSON.stringify(rejected), usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } };
    });
    const provider: CreativeProvider = { generateConcept: base.generateConcept.bind(base), submitStrategyConcepts: base.submitStrategyConcepts.bind(base), retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base), submitConceptExecution, retrieveConceptExecution: vi.fn() };
    const setup = await harness(provider);
    try {
      const project = await strategyHandoff(setup);
      await setup.service.generateConcept(project.id, "editor");
      const job = (await setup.repository.listJobs(project.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      await expect(setup.service.processJob(job.id)).rejects.toMatchObject({ code: "CONCEPT_STRATEGY_MISMATCH" });
      const operation = await setup.repository.getConceptProviderOperation(job.dedupeKey);
      expect(operation).toMatchObject({ state: "REJECTED", usage: { totalTokens: 16 }, rejectionCode: "CONCEPT_STRATEGY_MISMATCH" });
      expect(operation!.validationFindings.length).toBeGreaterThan(0);
      expect(operation!.safeResult).toBeDefined();
      expect((await setup.repository.getProject(project.id)).concepts).toHaveLength(0);
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
    } finally { await setup.dispose(); }
  });

  it("suppresses duplicate Generate actions while an operation is active", async () => {
    const base = new FakeCreativeProvider();
    const setup = await harness(base);
    try {
      const project = await strategyHandoff(setup);
      await setup.service.generateConcept(project.id, "editor");
      await setup.service.generateConcept(project.id, "editor");
      expect((await setup.repository.listJobs(project.id)).filter((item) => item.type === "GENERATE_CONCEPT")).toHaveLength(1);
    } finally { await setup.dispose(); }
  });

  it("replays a durable completed result after local persistence interruption without create or retrieve", async()=>{
    const base=new FakeCreativeProvider();
    const submitConceptExecution=vi.fn(base.submitConceptExecution!.bind(base));
    const retrieveConceptExecution=vi.fn(base.retrieveConceptExecution!.bind(base));
    const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution};
    const setup=await harness(provider,undefined,new FailFirstConceptPersistenceRepository());
    try{
      const project=await strategyHandoff(setup);
      await setup.service.generateConcept(project.id,"editor");
      const job=(await setup.repository.listJobs(project.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      expect(await setup.repository.getConceptProviderOperation(job.dedupeKey)).toMatchObject({state:"POLLING",latestProviderStatus:"completed"});
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
      expect(retrieveConceptExecution).toHaveBeenCalledTimes(0);
      expect((await setup.repository.getProject(project.id)).concepts).toHaveLength(1);
    }finally{await setup.dispose();}
  });

  it("submits once after a worker loss that occurred before the provider claim",async()=>{
    const base=new FakeCreativeProvider();
    const submitConceptExecution=vi.fn(base.submitConceptExecution!.bind(base));
    const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution:base.retrieveConceptExecution!.bind(base)};
    const setup=await harness(provider);
    try{
      const project=await strategyHandoff(setup);
      await setup.service.generateConcept(project.id,"editor");
      const job=(await setup.repository.listJobs(project.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      await setup.repository.saveJob({...job,status:"RUNNING",attempts:1,updatedAt:new Date().toISOString()});
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
    }finally{await setup.dispose();}
  });

  it("retries a temporary retrieve failure against the same Response ID",async()=>{
    const base=new FakeCreativeProvider();
    const submitConceptExecution=vi.fn(async()=>({responseId:"resp_transient",status:"queued" as const,provider:"fake-openai",model:"fake-background"}));
    let retrieval=0;
    const retrieveConceptExecution=vi.fn(async():Promise<StrategyProviderResponse>=>{
      retrieval+=1;
      if(retrieval===1)throw new Error("temporary network failure");
      const current=await setup.repository.getProject(project.id);
      const generated=await base.generateConcept(current.creativeInputSnapshot!.input,{operationKey:"fixture",projectId:project.id,targetId:project.id});
      return {responseId:"resp_transient",status:"completed",provider:"fake-openai",model:"fake-background",outputText:JSON.stringify(generated.concept),usage:{totalTokens:12}};
    });
    const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution};
    const setup=await harness(provider);let project!:Awaited<ReturnType<typeof strategyHandoff>>;
    try{
      project=await strategyHandoff(setup);
      await setup.service.generateConcept(project.id,"editor");
      const job=(await setup.repository.listJobs(project.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
      expect(retrieveConceptExecution).toHaveBeenCalledTimes(2);
      expect(retrieveConceptExecution).toHaveBeenNthCalledWith(1,"resp_transient");
      expect(retrieveConceptExecution).toHaveBeenNthCalledWith(2,"resp_transient");
    }finally{await setup.dispose();}
  });

  for(const terminalStatus of ["failed","cancelled","incomplete"] as const){
    it(`maps terminal provider status ${terminalStatus} to a safe failed operation`,async()=>{
      const base=new FakeCreativeProvider();
      const submitConceptExecution=vi.fn(async()=>({responseId:`resp_${terminalStatus}`,status:terminalStatus,provider:"fake-openai",model:"fake-background",safeError:{message:`provider ${terminalStatus}`}}));
      const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution:base.retrieveConceptExecution!.bind(base)};
      const setup=await harness(provider);
      try{
        const project=await strategyHandoff(setup);
        await setup.service.generateConcept(project.id,"editor");
        const job=(await setup.repository.listJobs(project.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
        await expect(setup.service.processJob(job.id)).rejects.toMatchObject({code:"CONCEPT_PROVIDER_TERMINAL_FAILURE"});
        expect(await setup.repository.getConceptProviderOperation(job.dedupeKey)).toMatchObject({state:"FAILED",latestProviderStatus:terminalStatus,providerTaskId:`resp_${terminalStatus}`});
        expect(submitConceptExecution).toHaveBeenCalledTimes(1);
      }finally{await setup.dispose();}
    });
  }

  it("rejects malformed completed structured output without a second create",async()=>{
    const base=new FakeCreativeProvider();
    const submitConceptExecution=vi.fn(async()=>({responseId:"resp_malformed",status:"completed" as const,provider:"fake-openai",model:"fake-background",outputText:"{"}));
    const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution:base.retrieveConceptExecution!.bind(base)};
    const setup=await harness(provider);
    try{
      const project=await strategyHandoff(setup);
      await setup.service.generateConcept(project.id,"editor");
      const job=(await setup.repository.listJobs(project.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      await expect(setup.service.processJob(job.id)).rejects.toMatchObject({code:"OPENAI_CONCEPT_INVALID"});
      expect(await setup.repository.getConceptProviderOperation(job.dedupeKey)).toMatchObject({state:"FAILED",providerTaskId:"resp_malformed"});
      expect(submitConceptExecution).toHaveBeenCalledTimes(1);
    }finally{await setup.dispose();}
  });
});

describe("7C.13E canonical Strategy acceptance", () => {
  const input = (requestedCount: StrategyRequestedCount = 12, claims = false): StrategyGenerationInput => ({
    productName: "Personalized product",
    productDescription: "A personalized home product shown in the supplied reference.",
    verifiedClaims: claims ? [{ kind: "FEATURE", text: "Personalized with operator-supplied details" }] : [],
    selectedAssets: [{ id: "reference-1", kind: "IMAGE", label: "Reference", mimeType: "image/png" }],
    additionalInstructions: "",
    targetDurationMs: 15_000,
    availableAssetCapabilities: ["PRODUCT_IMAGE"],
    authoritativeConstraints: [
      ...(claims ? [{ text: "Personalized with operator-supplied details", sourceType: "VERIFIED_PRODUCT_CLAIM" as const, authority: "FACTUAL_CLAIM" as const, sourceId: "FEATURE:0" }] : []),
      { text: "Preserve the visible silhouette, layout, text, proportions, positions, colors, and details.", sourceType: "REFERENCE_VISUAL", authority: "VISUAL_EVIDENCE", sourceId: "reference-1" }
    ],
    creativeHistory: [],
    requestedCount
  });

  const conceptsFor = (drafts: readonly StrategyConceptDraft[]): StrategyConcept[] => drafts.map((draft) => ({
    id: `concept-${draft.ordinal}`, batchId: "batch", ordinal: draft.ordinal, status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    currentRevision: { ...draft, id: `revision-${draft.ordinal}`, conceptId: `concept-${draft.ordinal}`, batchId: "batch", revision: 1, source: "OPENAI", diversityState: "DISTINCT", productionSafetyState: "PRODUCTION_SAFE", validationFindings: [], providerMetadata: {}, createdBy: "test", createdAt: "2026-01-01T00:00:00.000Z" }
  }));

  it("normalizes production methods and replaces provider authority with canonical application evidence", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/strategy-production-acceptance.json", import.meta.url), "utf8")) as { legacyProviderAuthority: Record<string, unknown>; directions: StrategyProviderConceptDraft[] };
    const strategyInput = input();
    const canonical = fixture.directions.map((direction) => canonicalizeStrategyDraft({ ...direction, ...fixture.legacyProviderAuthority } as unknown as StrategyProviderConceptDraft, strategyInput));
    expect(canonical).toHaveLength(12);
    expect(canonical[0]).toMatchObject({ primaryProductionMethod: "AI_LIFESTYLE", supportingProductionMethods: ["MOTION_GRAPHICS"], productTruthConstraints: [], requiredRealAssetCapabilities: [] });
    expect(canonical[1]).toMatchObject({ primaryProductionMethod: "AI_CINEMATIC", supportingProductionMethods: ["MOTION_GRAPHICS"], productTruthConstraints: [] });
    expect(canonical[0]!.visualFidelityRequirements).toEqual(strategyInput.authoritativeConstraints);
    expect(canonical.every((draft) => draft.creativeVisualExecutionNotes.length > 0)).toBe(true);
    expect(validateStrategySet(conceptsFor(canonical), strategyInput).every((result) => result.diversityState === "DISTINCT" && result.productionSafetyState === "PRODUCTION_SAFE")).toBe(true);
  });

  it("keeps factual and visual authority one-way, including zero verified claims", () => {
    const zeroClaims = input(3, false);
    const raw = {
      ...duplicateDraft(1, zeroClaims),
      creativeVisualExecutionNotes: "Reveal the visible product layout.",
      productTruthConstraints: [{ text: "Weatherproof steel", sourceType: "REFERENCE_VISUAL", authority: "FACTUAL_CLAIM", sourceId: "reference-1" }],
      visualFidelityRequirements: [{ text: "Operator description", sourceType: "OPERATOR_AUTHORITY", authority: "FACTUAL_CLAIM", sourceId: "operator" }]
    } as unknown as StrategyProviderConceptDraft;
    const canonical = canonicalizeStrategyDraft(raw, zeroClaims);
    expect(canonical.productTruthConstraints).toEqual([]);
    expect(canonical.visualFidelityRequirements).toEqual(zeroClaims.authoritativeConstraints);

    const withClaims = input(3, true);
    const withCanonicalClaims = canonicalizeStrategyDraft(raw, withClaims);
    expect(withCanonicalClaims.productTruthConstraints).toEqual([withClaims.authoritativeConstraints[0]]);
    expect(withCanonicalClaims.visualFidelityRequirements).toEqual([withClaims.authoritativeConstraints[1]]);
  });

  it("still detects unsupported claims, fabricated AI testimony, unknown methods, and genuine diversity conflicts", () => {
    const strategyInput = input(3);
    const raw = { ...duplicateDraft(1, strategyInput), creativeVisualExecutionNotes: "Show the visible layout." } as unknown as StrategyProviderConceptDraft;
    expect(() => canonicalizeStrategyDraft({ ...raw, primaryProductionMethod: "UNKNOWN" as never }, strategyInput)).toThrow("Unknown primary production method");
    const unsupported = canonicalizeStrategyDraft({ ...raw, coreAngle: "Promote weatherproof steel durability" }, strategyInput);
    const testimony = canonicalizeStrategyDraft({ ...raw, ordinal: 2, conceptFamily: "Creator story", primaryProductionMethod: "AI_UGC_STYLE", ugcRepresentation: "AI_STYLE_NON_CUSTOMER", hook: "I bought this last week and love it" }, strategyInput);
    const results = validateStrategySet(conceptsFor([unsupported, testimony]), strategyInput);
    expect(results[0]!.productionSafetyState).toBe("UNSUPPORTED_PRODUCT_CLAIM");
    expect(results[1]!.productionSafetyState).toBe("UNSAFE_AI_TESTIMONIAL");
    const duplicate = canonicalizeStrategyDraft({ ...raw, ordinal: 2 }, strategyInput);
    expect(validateStrategySet(conceptsFor([canonicalizeStrategyDraft(raw, strategyInput), duplicate]), strategyInput)[1]!.diversityState).not.toBe("DISTINCT");
  });

  it.each([3, 6, 12] as const)("persists exactly %i requested concepts and keeps the selection count immutable", async (requestedCount) => {
    const setup = await harness();
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: `Count ${requestedCount}`, creativeTopic: "Distinct directions", productDetails: "Personalized product", targetDurationSeconds: 15, actor: "editor" });
      const requestId = crypto.randomUUID();
      const batch = await setup.strategyService.createBatch(project.id, requestId, "editor", requestedCount);
      const job = (await setup.repository.listJobs(project.id))[0]!;
      expect((await setup.strategyService.processJob(job.id)).status).toBe("COMPLETED");
      expect((await setup.strategies.getBatch(batch.id)).requestedCount).toBe(requestedCount);
      expect((await setup.strategies.listConcepts(batch.id))).toHaveLength(requestedCount);
      const idempotent = await setup.strategyService.createBatch(project.id, requestId, "editor", requestedCount === 3 ? 12 : 3);
      expect(idempotent.id).toBe(batch.id);
      expect(idempotent.requestedCount).toBe(requestedCount);
    } finally { await setup.dispose(); }
  });

  it("defaults to six concepts and rejects every unsupported requested count", async () => {
    const setup = await harness();
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Default count", creativeTopic: "Distinct directions", productDetails: "Personalized product", targetDurationSeconds: 15, actor: "editor" });
      const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor");
      expect(batch.requestedCount).toBe(6);
      for (const invalid of [1, 2, 4, 5, 7, 8, 20]) {
        await expect(setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", invalid as StrategyRequestedCount)).rejects.toMatchObject({ code: "STRATEGY_COUNT_INVALID" });
      }
    } finally { await setup.dispose(); }
  });

  it("maps unrecoverable local validation failure to FAILED instead of leaving the batch GENERATING", async () => {
    const base = new FakeCreativeProvider();
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: async (strategyInput, context) => {
        const response = await base.submitStrategyConcepts!(strategyInput, context);
        const parsed = JSON.parse(response.outputText!) as { concepts: StrategyProviderConceptDraft[] };
        parsed.concepts[0] = { ...parsed.concepts[0]!, primaryProductionMethod: "UNKNOWN" as never };
        return { ...response, outputText: JSON.stringify(parsed) };
      },
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base)
    };
    const setup = await harness(provider);
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Invalid method", creativeTopic: "Strategy", productDetails: "Personalized product", targetDurationSeconds: 15, actor: "editor" });
      const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 3);
      const job = (await setup.repository.listJobs(project.id))[0]!;
      expect((await setup.strategyService.processJob(job.id)).status).toBe("FAILED");
      expect((await setup.strategies.getBatch(batch.id)).status).toBe("FAILED");
    } finally { await setup.dispose(); }
  });
});

describe("durable background Strategy provider lifecycle", () => {
  async function queuedProvider(sequence: Array<StrategyProviderResponse | Error>) {
    const base = new FakeCreativeProvider();
    const submit = vi.fn(async (input: StrategyGenerationInput, context: Parameters<NonNullable<CreativeProvider["submitStrategyConcepts"]>>[1]) => {
      const completed = await base.submitStrategyConcepts(input, context);
      return { ...completed, status: "queued" as const, outputText: undefined } as unknown as StrategyProviderResponse;
    });
    const retrieve = vi.fn(async () => {
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("No scripted provider response remains.");
      return next;
    });
    return { base, provider: { generateConcept: base.generateConcept.bind(base), submitStrategyConcepts: submit, retrieveStrategyConcepts: retrieve } satisfies CreativeProvider, submit, retrieve };
  }

  async function pendingBatch(provider: CreativeProvider) {
    const setup = await harness(provider);
    const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Background sign", creativeTopic: "Diverse strategy", productDetails: "Personalized sign", targetDurationSeconds: 15, actor: "editor" });
    const batch = await setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor", 12);
    const job = (await setup.repository.listJobs(project.id))[0]!;
    return { setup, project, batch, job };
  }

  it("keeps duplicate request IDs idempotent and rejects a second active generation", async () => {
    const setup = await harness();
    try {
      const project = await setup.service.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Duplicate guard", creativeTopic: "Strategy", productDetails: "Personalized sign", targetDurationSeconds: 15, actor: "editor" });
      const requestId = crypto.randomUUID();
      const first = await setup.strategyService.createBatch(project.id, requestId, "editor");
      expect((await setup.strategyService.createBatch(project.id, requestId, "editor")).id).toBe(first.id);
      await expect(setup.strategyService.createBatch(project.id, crypto.randomUUID(), "editor")).rejects.toMatchObject({ code: "STRATEGY_GENERATION_ACTIVE" });
      expect((await setup.repository.listJobs(project.id)).filter((job) => job.type === "GENERATE_STRATEGY")).toHaveLength(1);
    } finally { await setup.dispose(); }
  });

  it("persists a response ID and advances queued to in_progress to completed without another create", async () => {
    const seed = new FakeCreativeProvider();
    const inputSetup = await pendingBatch(seed);
    const completed = await seed.submitStrategyConcepts(inputSetup.batch.inputSnapshot, { operationKey: "seed", projectId: inputSetup.project.id, targetId: inputSetup.batch.id });
    await inputSetup.setup.dispose();
    const scripted = await queuedProvider([{ ...completed, status: "in_progress", outputText: undefined } as unknown as StrategyProviderResponse, completed]);
    const { setup, batch, job } = await pendingBatch(scripted.provider);
    try {
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      let operation = await setup.strategies.getOrCreateOperation({ id: crypto.randomUUID(), batchId: batch.id, kind: "INITIAL", operationKey: `${batch.operationKey}:initial`, timestamp: new Date().toISOString() });
      expect(operation).toMatchObject({ status: "POLLING", responseId: expect.any(String), latestProviderStatus: "queued" });
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.strategyService.processJob(job.id)).status).toBe("COMPLETED");
      operation = await setup.strategies.getOrCreateOperation({ id: crypto.randomUUID(), batchId: batch.id, kind: "INITIAL", operationKey: `${batch.operationKey}:initial`, timestamp: new Date().toISOString() });
      expect(operation).toMatchObject({ status: "SUCCEEDED", latestProviderStatus: "completed", resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(scripted.submit).toHaveBeenCalledTimes(1);
      expect(scripted.retrieve).toHaveBeenCalledTimes(2);
      expect(await setup.strategies.listConcepts(batch.id)).toHaveLength(12);
    } finally { await setup.dispose(); }
  });

  it("resumes retrieval after a service restart and safely retries a temporary retrieve failure", async () => {
    const seed = new FakeCreativeProvider();
    const temp = await pendingBatch(seed);
    const completed = await seed.submitStrategyConcepts(temp.batch.inputSnapshot, { operationKey: "seed-restart", projectId: temp.project.id, targetId: temp.batch.id });
    await temp.setup.dispose();
    const scripted = await queuedProvider([new Error("temporary network failure"), completed]);
    const { setup, batch, job } = await pendingBatch(scripted.provider);
    try {
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      const restarted = new CreativeStrategyService({ repository: setup.repository, strategies: setup.strategies, creativeProvider: scripted.provider });
      expect((await restarted.processJob(job.id)).status).toBe("PENDING");
      expect((await restarted.processJob(job.id)).status).toBe("COMPLETED");
      expect(scripted.submit).toHaveBeenCalledTimes(1);
      expect(scripted.retrieve).toHaveBeenCalledTimes(2);
      expect((await setup.strategies.getBatch(batch.id)).status).toBe("REVIEW");
    } finally { await setup.dispose(); }
  });

  it("uses distinct safe states before and after a response ID is known", async () => {
    const base = new FakeCreativeProvider();
    const ambiguousSubmit = vi.fn(async () => { throw new DomainError("OPENAI_STRATEGY_SUBMISSION_UNKNOWN", "ambiguous submission"); });
    const before = await pendingBatch({ generateConcept: base.generateConcept.bind(base), submitStrategyConcepts: ambiguousSubmit, retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base) });
    try {
      expect((await before.setup.strategyService.processJob(before.job.id)).status).toBe("FAILED");
      expect((await before.setup.strategies.getBatch(before.batch.id)).status).toBe("SUBMISSION_UNKNOWN");
      expect((await before.setup.strategyService.processJob(before.job.id)).status).toBe("FAILED");
      expect(ambiguousSubmit).toHaveBeenCalledTimes(1);
    } finally { await before.setup.dispose(); }

    const seed = new FakeCreativeProvider();
    const temp = await pendingBatch(seed);
    const completed = await seed.submitStrategyConcepts(temp.batch.inputSnapshot, { operationKey: "seed-unavailable", projectId: temp.project.id, targetId: temp.batch.id });
    await temp.setup.dispose();
    const scripted = await queuedProvider([new DomainError("OPENAI_STRATEGY_RESULT_UNAVAILABLE", "expired")]);
    void completed;
    const after = await pendingBatch(scripted.provider);
    try {
      expect((await after.setup.strategyService.processJob(after.job.id)).status).toBe("PENDING");
      expect((await after.setup.strategyService.processJob(after.job.id)).status).toBe("FAILED");
      expect((await after.setup.strategies.getBatch(after.batch.id)).status).toBe("RESULT_UNAVAILABLE");
      expect(scripted.submit).toHaveBeenCalledTimes(1);
    } finally { await after.setup.dispose(); }
  });

  it.each(["failed", "cancelled", "incomplete"] as const)("handles terminal %s without resubmission", async (terminal) => {
    const scripted = await queuedProvider([{ responseId: "known-response", provider: "fake-openai", status: terminal, model: "fake-strategy", safeError: { message: `${terminal} safely` } }]);
    const { setup, batch, job } = await pendingBatch(scripted.provider);
    try {
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.strategyService.processJob(job.id)).status).toBe("FAILED");
      expect((await setup.strategies.getBatch(batch.id)).status).toBe("FAILED");
      expect(scripted.submit).toHaveBeenCalledTimes(1);
    } finally { await setup.dispose(); }
  });

  it("rejects malformed completed output without a second create", async () => {
    const scripted = await queuedProvider([{ responseId: "known-response", provider: "fake-openai", status: "completed", model: "fake-strategy", outputText: "{not-json" }]);
    const { setup, batch, job } = await pendingBatch(scripted.provider);
    try {
      expect((await setup.strategyService.processJob(job.id)).status).toBe("PENDING");
      expect((await setup.strategyService.processJob(job.id)).status).toBe("FAILED");
      expect((await setup.strategies.getBatch(batch.id)).status).toBe("FAILED");
      expect(scripted.submit).toHaveBeenCalledTimes(1);
    } finally { await setup.dispose(); }
  });
});

describe("authoritative strategy handoff", () => {
  it("keeps the Campaign source separate and preserves rejected child history across later handoffs", async () => {
    const base = new FakeCreativeProvider();
    const submitConceptExecution = vi.fn(async (input: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[0], context: Parameters<NonNullable<CreativeProvider["submitConceptExecution"]>>[1]) => {
      const generated = await base.generateConcept(input, context);
      return {
        responseId: "resp_historical_rejection",
        status: "completed" as const,
        provider: "fake-openai",
        model: "fake-background",
        outputText: JSON.stringify({ ...generated.concept, strategyExecutionSummary: "Send the perfect housewarming gift.", voiceScript: "A moving gift they will love." })
      };
    });
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitStrategyConcepts: base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base),
      submitConceptExecution,
      retrieveConceptExecution: vi.fn()
    };
    const setup = await harness(provider);
    try {
      const result = await createStrategyBatch(setup);
      const revisionId = result.concepts[0]!.currentRevision.id;
      const firstRequestId = crypto.randomUUID();
      const [historical] = await setup.strategyService.handoff(result.batch.id, [revisionId], firstRequestId, "owner");
      expect(historical!.id).not.toBe(result.project.id);
      expect(historical!.strategyOrigin?.sourceProjectId).toBe(result.project.id);
      await setup.service.generateConcept(historical!.id, "editor");
      const failedJob = (await setup.repository.listJobs(historical!.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      await expect(setup.service.processJob(failedJob.id)).rejects.toMatchObject({ code: "CONCEPT_STRATEGY_MISMATCH" });
      const original = structuredClone(await setup.repository.getProject(historical!.id));
      const originalOperation = structuredClone(await setup.repository.getConceptProviderOperation(failedJob.dedupeKey));
      expect(original).toMatchObject({ state: "DRAFT", concepts: [], creativeInputSnapshot: { id: historical!.creativeInputSnapshot!.id, sha256: historical!.creativeInputSnapshot!.sha256 } });
      expect(original.auditEvents.some((event) => event.type === "CONCEPT_REJECTED")).toBe(true);
      expect(setup.strategyService.isPristineSource(original)).toBe(false);

      const product = await setup.service.getProduct(original.productId);
      const changedAuthority = { status: "OPERATOR_CONFIRMED" as const, immutableStructure: ["Wall-sign silhouette", "Mounting configuration"], authorizedPersonalizationFields: ["Pet artwork", "House number", "Street text"] };
      await setup.service.updateProduct(product.id, { ...product, personalizationVisualAuthority: changedAuthority });
      const secondRequestId = crypto.randomUUID();
      const [sibling] = await setup.strategyService.handoff(result.batch.id, [revisionId], secondRequestId, "owner");

      expect(sibling!.id).not.toBe(original.id);
      expect(sibling!.creativeInputSnapshot!.id).not.toBe(original.creativeInputSnapshot!.id);
      expect(sibling!.creativeInputSnapshot!.input.personalizationVisualAuthority).toEqual(changedAuthority);
      expect(await setup.repository.getProject(original.id)).toEqual(original);
      expect(await setup.repository.getConceptProviderOperation(failedJob.dedupeKey)).toEqual(originalOperation);
      const [duplicate] = await setup.strategyService.handoff(result.batch.id, [revisionId], secondRequestId, "owner");
      expect(duplicate!.id).toBe(sibling!.id);
      expect(duplicate!.creativeInputSnapshot).toEqual(sibling!.creativeInputSnapshot);
      const [originalReplay] = await setup.strategyService.handoff(result.batch.id, [revisionId], firstRequestId, "owner");
      expect(originalReplay!.id).toBe(original.id);
      expect(originalReplay!.creativeInputSnapshot).toEqual(original.creativeInputSnapshot);
    } finally { await setup.dispose(); }
  });

  it("revalidates a retained rejected result without provider calls or historical-operation mutation",async()=>{
    const base=new FakeCreativeProvider();
    const submitConceptExecution=vi.fn(base.submitConceptExecution!.bind(base));
    const retrieveConceptExecution=vi.fn(base.retrieveConceptExecution!.bind(base));
    const provider:CreativeProvider={generateConcept:base.generateConcept.bind(base),submitStrategyConcepts:base.submitStrategyConcepts.bind(base),retrieveStrategyConcepts:base.retrieveStrategyConcepts.bind(base),submitConceptExecution,retrieveConceptExecution};
    const setup=await harness(provider);
    try{
      const result=await createStrategyBatch(setup);
      const handed=await setup.strategyService.handoff(result.batch.id,[result.concepts[0]!.currentRevision.id],crypto.randomUUID(),"owner");
      const project=handed[0]!;
      const snapshot=project.creativeInputSnapshot!;
      const generated=await base.generateConcept(snapshot.input,{operationKey:"fixture",projectId:project.id,targetId:project.id});
      const draft={...generated.concept,scenes:generated.concept.scenes.map((scene,index)=>index===0?{...scene,generationPrompt:"From frame one, show the finished sign visibly mounted beside a front door. No gift box or unboxing imagery.",accuracyRequirements:[...scene.accuracyRequirements,"Finished Product is installed and visible from frame one."]}:scene)};
      const operationKey=`concept:${project.id}:revision:1:generate:attempt:4`;
      await setup.repository.saveConceptProviderOperation({operationKey,projectId:project.id,state:"REJECTED",provider:"fake-openai",model:"fake-background",requestId:"resp_retained",providerTaskId:"resp_retained",snapshotId:snapshot.id,snapshotSha256:snapshot.sha256,submittedAt:"2026-01-01T00:00:00.000Z",completedAt:"2026-01-01T00:00:30.000Z",durationMs:30_000,usage:{inputTokens:10,outputTokens:20,totalTokens:30},resultSha256:conceptProviderResultSha256(draft),safeResult:draft,validationFindings:["WINNER_DNA_INSTALLATION_OPENING_IGNORED: historical validator finding."],rejectionCode:"CONCEPT_STRATEGY_MISMATCH",safeErrorMessage:"Historical rejection."});
      const historical=structuredClone(await setup.repository.getConceptProviderOperation(operationKey));
      const submitCount=submitConceptExecution.mock.calls.length;
      const retrieveCount=retrieveConceptExecution.mock.calls.length;
      const revalidated=await setup.service.revalidateStoredConceptResult(project.id,operationKey,"operator");
      expect(revalidated).toMatchObject({state:"CONCEPT_REVIEW"});
      expect(revalidated.concepts).toHaveLength(1);
      expect(revalidated.concepts[0]).toMatchObject({revision:1,status:"REVIEW",providerMetadata:{operationKey,revalidatedFromOperationKey:operationKey,historicalOperationState:"REJECTED",requestId:"resp_retained"}});
      expect(await setup.repository.getConceptProviderOperation(operationKey)).toEqual(historical);
      expect(submitConceptExecution).toHaveBeenCalledTimes(submitCount);
      expect(retrieveConceptExecution).toHaveBeenCalledTimes(retrieveCount);
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
      const replay=await setup.service.revalidateStoredConceptResult(project.id,operationKey,"operator");
      expect(replay.concepts).toHaveLength(1);
    }finally{await setup.dispose();}
  });

  it("preserves the Campaign source and snapshots each selected Strategy into isolated execution children", async () => {
    const base = new FakeCreativeProvider();
    const conceptInputs: Parameters<CreativeProvider["generateConcept"]>[0][] = [];
    const provider: CreativeProvider = {
      submitStrategyConcepts: base.submitStrategyConcepts.bind(base),
      retrieveStrategyConcepts: base.retrieveStrategyConcepts.bind(base),
      generateConcept: async (input, context) => { conceptInputs.push(input); return base.generateConcept(input, context); },
      submitConceptExecution: async (input, context) => { conceptInputs.push(input); return base.submitConceptExecution!(input, context); },
      retrieveConceptExecution: base.retrieveConceptExecution!.bind(base)
    };
    const setup = await harness(provider);
    try {
      const result = await createStrategyBatch(setup);
      const product=await setup.service.getProduct(result.project.productId);
      const personalizationVisualAuthority={status:"OPERATOR_CONFIRMED" as const,immutableStructure:["Wall-sign silhouette","Mounting configuration"],authorizedPersonalizationFields:["Pet artwork","House number"],authorizedProductConfigurations:["Garden-stake mounted"]};
      const currentClaims=[...product.claims,{kind:"FEATURE" as const,text:"Optional garden stake mounting configuration is available."}];
      await setup.service.updateProduct(product.id,{...product,claims:currentClaims,personalizationVisualAuthority});
      const selected = result.concepts.slice(0, 2).map((item) => item.currentRevision.id);
      const handed = await setup.strategyService.handoff(result.batch.id, selected, crypto.randomUUID(), "owner");
      expect(handed).toHaveLength(2);
      expect(handed[0]!.creativeInputSnapshot!.input.personalizationVisualAuthority).toEqual(personalizationVisualAuthority);
      expect(handed[0]!.creativeInputSnapshot!.input.claims).toEqual(currentClaims);
      expect(handed[0]!.creativeInputSnapshot!.input.claims).not.toEqual(result.batch.inputSnapshot.verifiedClaims);
      const originalSnapshot=structuredClone(handed[0]!.creativeInputSnapshot);
      expect(handed[0]!.id).not.toBe(result.project.id);
      expect(handed[1]!.id).not.toBe(result.project.id);
      expect(handed.every((project)=>project.strategyOrigin?.sourceProjectId===result.project.id)).toBe(true);
      expect((await setup.repository.getProject(result.project.id)).creativeInputSnapshot).toBeUndefined();
      await setup.service.generateConcept(handed[0]!.id, "editor");
      const conceptJob = (await setup.repository.listJobs(handed[0]!.id)).find((item) => item.type === "GENERATE_CONCEPT")!;
      await setup.service.processJob(conceptJob.id);
      const generated = await setup.repository.getProject(handed[0]!.id);
      const strategy = result.concepts[0]!.currentRevision;
      expect(conceptInputs[0]!.selectedStrategy).toMatchObject({ id: strategy.id, coreAngle: strategy.coreAngle, hook: strategy.hook, primaryProductionMethod: strategy.primaryProductionMethod });
      const concept = generated.concepts.find((item) => item.id === generated.currentConceptId)!;
      expect(concept.angle).toBe(strategy.coreAngle);
      expect(concept.hook).toBe(strategy.hook);
      expect(concept.cta).toBe(concept.inputSnapshot.defaultCta);
      expect(concept.inputSnapshot.selectedStrategy?.ctaStrategy).toBe(strategy.ctaStrategy);
      await setup.service.updateProduct(product.id,{...product,personalizationVisualAuthority:{...personalizationVisualAuthority,authorizedPersonalizationFields:["Street text"]}});
      expect((await setup.repository.getProject(handed[0]!.id)).creativeInputSnapshot).toEqual(originalSnapshot);
    } finally { await setup.dispose(); }
  });

  it("never mutates a source that already entered the direct Video Maker workflow", async () => {
    const setup = await harness();
    try {
      const product = await setup.service.createProduct({ name: "Legacy sign", slug: "legacy-sign", description: "Legacy direct project", claims: [], defaultCta: "Create yours", assets: [{ id: "reference", kind: "IMAGE", label: "Reference", storageKey: "private/reference.png", mimeType: "image/png" }] });
      const source = await setup.service.createProject({ productId: product.id, selectedProductAssetIds: ["reference"], preferredVoiceProfileId: "marin", actor: "editor" });
      const entered = await setup.service.generateConcept(source.id, "editor");
      const batch = await setup.strategyService.createBatch(entered.id, crypto.randomUUID(), "editor");
      const job = (await setup.repository.listJobs(entered.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      await setup.strategyService.processJob(job.id);
      const concepts = await setup.strategies.listConcepts(batch.id);
      const handed = await setup.strategyService.handoff(batch.id, concepts.slice(0, 2).map((item) => item.currentRevision.id), crypto.randomUUID(), "owner");
      expect(handed).toHaveLength(2);
      expect(handed.every((item) => item.id !== entered.id)).toBe(true);
      expect(await setup.repository.getProject(entered.id)).toEqual(entered);
    } finally { await setup.dispose(); }
  });

  it("rejects selecting more than three strategy concepts", async () => {
    const setup = await harness();
    try {
      const result = await createStrategyBatch(setup);
      await expect(setup.strategyService.handoff(result.batch.id, result.concepts.slice(0, 4).map((item) => item.currentRevision.id), crypto.randomUUID(), "owner")).rejects.toThrow("between one and three");
    } finally { await setup.dispose(); }
  });
});
