import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "@koolezt/domain";
import type {
  CreativeProject, FactoryRepository, ProviderSubmission, StrategyBatch, StrategyBatchStatus,
  StrategyConcept, StrategyConceptRevision, StrategyHistoryEntry, StrategyProviderConceptDraft, StrategyProviderOperation,
  StrategyRepository
} from "@koolezt/domain";

const copy = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revisionDigest = (revision: StrategyConceptRevision) => {
  const { providerMetadata: _provider, validationFindings: _findings, ...snapshot } = revision;
  void _provider;
  void _findings;
  return digest(snapshot);
};

/** Deterministic repository used by tests and local fake-provider workflows. */
export class InMemoryCreativeStrategyStore implements StrategyRepository {
  private readonly batches = new Map<string, StrategyBatch>();
  private readonly concepts = new Map<string, StrategyConcept[]>();
  private readonly revisions = new Map<string, StrategyConceptRevision>();
  private readonly operations = new Map<string, StrategyProviderOperation>();
  private readonly operationIds = new Map<string, string>();
  private readonly handoffs = new Map<string, string[]>();

  constructor(private readonly projects: FactoryRepository, private readonly id: () => string = randomUUID) {}

  async createBatch(input: Parameters<StrategyRepository["createBatch"]>[0]): Promise<StrategyBatch> {
    const existing = [...this.batches.values()].find((item) => item.operationKey === input.operationKey);
    if (existing) return copy(existing);
    const batch: StrategyBatch = {
      id: input.id, sourceProjectId: input.sourceProjectId, productId: input.productId, revision: 1,
      requestedCount: input.inputSnapshot.requestedCount, operationKey: input.operationKey, inputSnapshot: copy(input.inputSnapshot),
      historySnapshot: copy(input.historySnapshot), historySha256: input.historySha256, status: "PENDING",
      providerRequestCount: 0, automaticRepairAttempted: false, validationSummary: {}, providerMetadata: [],
      createdBy: input.actor, createdAt: input.timestamp, updatedAt: input.timestamp
    };
    this.batches.set(batch.id, copy(batch));
    this.concepts.set(batch.id, []);
    return copy(batch);
  }

  async getBatch(id: string): Promise<StrategyBatch> {
    const batch = this.batches.get(id);
    if (!batch) throw new DomainError("STRATEGY_BATCH_NOT_FOUND", "Strategy batch was not found.");
    return copy(batch);
  }

  async setBatchState(id: string, status: StrategyBatchStatus, timestamp: string): Promise<void> {
    const batch = await this.getBatch(id);
    this.batches.set(id, { ...batch, status, updatedAt: timestamp });
  }

  async listBatches(projectId: string) {
    return [...this.batches.values()].filter((item) => item.sourceProjectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((batch) => ({ batch: copy(batch), concepts: copy(this.concepts.get(batch.id) ?? []) }));
  }

  async listConcepts(batchId: string): Promise<readonly StrategyConcept[]> { return copy(this.concepts.get(batchId) ?? []); }

  async getRevision(id: string): Promise<StrategyConceptRevision> {
    const revision = this.revisions.get(id);
    if (!revision) throw new DomainError("STRATEGY_REVISION_NOT_FOUND", "Strategy revision was not found.");
    return copy(revision);
  }

  async listProductHistory(productId: string, excludeBatchId?: string): Promise<readonly StrategyHistoryEntry[]> {
    const batches = [...this.batches.values()].filter((item) => item.productId === productId && item.id !== excludeBatchId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, 4);
    return batches.flatMap((batch) => (this.concepts.get(batch.id) ?? []).map(({ currentRevision: revision }) => ({
      conceptRevisionId: revision.id, conceptFamily: revision.conceptFamily, buyerPersona: revision.buyerPersona,
      customerDesireOrProblem: revision.customerDesireOrProblem, coreAngle: revision.coreAngle,
      emotionalTerritory: revision.emotionalTerritory, openingVisualPattern: revision.openingVisualPattern,
      creativeFormat: revision.creativeFormat, primaryProductionMethod: revision.primaryProductionMethod,
      supportingProductionMethods: revision.supportingProductionMethods, proofMechanism: revision.proofMechanism,
      offerFraming: revision.offerFraming, differentiationSummary: revision.differentiationSummary
    }))).slice(0, 48);
  }

  async getOrCreateOperation(input: Parameters<StrategyRepository["getOrCreateOperation"]>[0]): Promise<StrategyProviderOperation> {
    const existingId = this.operationIds.get(input.operationKey);
    if (existingId) return copy(this.operations.get(existingId)!);
    const operation: StrategyProviderOperation = { id: input.id, batchId: input.batchId, kind: input.kind, operationKey: input.operationKey, status: "PENDING", providerMetadata: {}, createdAt: input.timestamp, updatedAt: input.timestamp };
    this.operations.set(operation.id, operation);
    this.operationIds.set(operation.operationKey, operation.id);
    return copy(operation);
  }

  async beginOperation(id: string): Promise<Readonly<{ operation: StrategyProviderOperation; claimed: boolean }>> {
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    if (operation.status !== "PENDING") return { operation: copy(operation), claimed: false };
    const batch = this.batches.get(operation.batchId);
    if (!batch) throw new DomainError("STRATEGY_BATCH_NOT_FOUND", "Strategy batch was not found.");
    const updated = { ...operation, status: "SUBMITTING" as const, updatedAt: new Date().toISOString() };
    this.operations.set(id, updated);
    this.batches.set(batch.id, { ...batch, providerRequestCount: batch.providerRequestCount + 1, updatedAt: updated.updatedAt });
    return { operation: copy(updated), claimed: true };
  }

  async recordOperationSubmission(id: string, input: Parameters<StrategyRepository["recordOperationSubmission"]>[1]): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    this.operations.set(id, { ...operation, status: "POLLING", responseId: input.response.responseId, model: input.response.model, submittedAt: input.submittedAt, latestProviderStatus: input.response.status, latestPollAt: input.submittedAt, providerMetadata: { provider: input.response.provider, model: input.response.model, responseId: input.response.responseId, latestStatus: input.response.status, ...input.response.usage }, updatedAt: input.submittedAt });
  }

  async recordOperationPoll(id: string, input: Parameters<StrategyRepository["recordOperationPoll"]>[1]): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    this.operations.set(id, { ...operation, latestProviderStatus: input.response.status, latestPollAt: input.polledAt, providerMetadata: { ...operation.providerMetadata, latestStatus: input.response.status, ...input.response.usage }, updatedAt: input.polledAt });
  }

  async recordOperationPollFailure(id: string, input: Parameters<StrategyRepository["recordOperationPollFailure"]>[1]): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    this.operations.set(id, { ...operation, latestPollAt: input.polledAt, updatedAt: input.polledAt });
  }

  async completeOperation(id: string, result: Readonly<{ concepts: readonly StrategyProviderConceptDraft[]; submission: ProviderSubmission }>): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    const submission = result.submission;
    const metadata = { provider: submission.provider, model: submission.model, providerTaskId: submission.providerTaskId, requestId: submission.requestId, ...submission.metadata };
    const timestamp = new Date().toISOString();
    const resultSha256 = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    this.operations.set(id, { ...operation, status: "SUCCEEDED", latestProviderStatus: "completed", terminalAt: timestamp, resultSha256, providerMetadata: metadata, result: copy(result), updatedAt: timestamp });
    const batch = await this.getBatch(operation.batchId);
    this.batches.set(batch.id, { ...batch, providerMetadata: [...batch.providerMetadata, metadata], updatedAt: timestamp });
  }

  async failOperation(id: string, status: "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE", _message: string): Promise<void> {
    void _message;
    const operation = this.operations.get(id);
    if (!operation) throw new DomainError("STRATEGY_OPERATION_NOT_FOUND", "Strategy provider operation was not found.");
    const timestamp = new Date().toISOString();
    this.operations.set(id, { ...operation, status, terminalAt: timestamp, updatedAt: timestamp });
  }

  async saveGeneratedConcepts(input: Parameters<StrategyRepository["saveGeneratedConcepts"]>[0]): Promise<void> {
    const current = [...(this.concepts.get(input.batchId) ?? [])];
    for (const draft of input.concepts) {
      const index = current.findIndex((item) => item.ordinal === draft.ordinal);
      const previous = index >= 0 ? current[index] : undefined;
      const conceptId = previous?.id ?? this.id();
      const revision: StrategyConceptRevision = {
        ...copy(draft), id: this.id(), conceptId, batchId: input.batchId,
        revision: (previous?.currentRevision.revision ?? 0) + 1, source: input.source,
        diversityState: "DISTINCT", productionSafetyState: "PRODUCTION_SAFE", validationFindings: [],
        providerMetadata: copy(input.providerMetadata), createdBy: input.actor, createdAt: input.timestamp
      };
      const concept: StrategyConcept = { id: conceptId, batchId: input.batchId, ordinal: draft.ordinal, currentRevision: revision, status: "ACTIVE", createdAt: previous?.createdAt ?? input.timestamp, updatedAt: input.timestamp };
      if (index >= 0) current[index] = concept; else current.push(concept);
      this.revisions.set(revision.id, copy(revision));
    }
    current.sort((left, right) => left.ordinal - right.ordinal);
    this.concepts.set(input.batchId, copy(current));
  }

  async saveValidation(input: Parameters<StrategyRepository["saveValidation"]>[0]): Promise<void> {
    const results = new Map(input.results.map((item) => [item.revisionId, item]));
    const concepts = (this.concepts.get(input.batchId) ?? []).map((concept) => {
      const result = results.get(concept.currentRevision.id);
      if (!result) return concept;
      const revision = { ...concept.currentRevision, diversityState: result.diversityState, productionSafetyState: result.productionSafetyState, validationFindings: [...result.findings] };
      this.revisions.set(revision.id, copy(revision));
      return { ...concept, currentRevision: revision, updatedAt: input.timestamp };
    });
    this.concepts.set(input.batchId, copy(concepts));
    const batch = await this.getBatch(input.batchId);
    this.batches.set(batch.id, { ...batch, status: input.status, automaticRepairAttempted: input.automaticRepairAttempted, validationSummary: copy(input.summary), updatedAt: input.timestamp });
  }

  async createHandoff(input: Parameters<StrategyRepository["createHandoff"]>[0]): Promise<readonly CreativeProject[]> {
    const operationKey = `strategy-handoff:${input.batchId}:${input.requestId}`;
    const previousIds = this.handoffs.get(operationKey);
    if (previousIds) return Promise.all(previousIds.map((id) => this.projects.getProject(id)));
    const batch = await this.getBatch(input.batchId);
    const source = await this.projects.getProject(batch.sourceProjectId);
    const concepts = await this.listConcepts(batch.id);
    const revisions = input.revisionIds.map((id) => {
      const concept = concepts.find((item) => item.currentRevision.id === id);
      if (!concept || concept.currentRevision.diversityState !== "DISTINCT" || concept.currentRevision.productionSafetyState !== "PRODUCTION_SAFE") throw new DomainError("STRATEGY_SELECTION_NOT_READY", "Only current distinct and production-safe revisions can be handed off.");
      return concept.currentRevision;
    });
    const created: CreativeProject[] = [];
    for (const revision of revisions) {
      const strategyOrigin = { batchId: batch.id, conceptId: revision.conceptId, conceptRevisionId: revision.id, revisionSha256: revisionDigest(revision), sourceProjectId: source.id };
      const winnerDnaOrigin=input.winnerDna?{creativeReferenceId:input.winnerDna.creativeReferenceId,revisionId:input.winnerDna.id,revisionSha256:input.winnerDna.revisionSha256}:undefined;
      const creativeInputSnapshot=input.inputSnapshots?.find((item)=>item.revisionId===revision.id)?.snapshot;
      const shared = { strategyRequired: true as const, strategyOrigin, ...(winnerDnaOrigin?{winnerDnaOrigin,winnerDnaSnapshot:input.winnerDna}:{}), ...(creativeInputSnapshot?{creativeInputSnapshot}:{}), creativeBrief: { creativeTopic: `${revision.conceptName}: ${revision.coreAngle}`, productDetails: source.creativeBrief?.productDetails ?? batch.inputSnapshot.productDescription, targetDurationSeconds: Math.round(batch.inputSnapshot.targetDurationMs / 1000) }, additionalInstructions: `Authoritative strategy ${revision.id}: ${revision.differentiationSummary}` };
      const number = await this.projects.nextProjectNumber();
      const project: CreativeProject = { ...shared, id: this.id(), publicId: `CF-${String(number).padStart(6, "0")}`, productId: source.productId, selectedProductAssetIds: [...source.selectedProductAssetIds], preferredVoiceProfileId: source.preferredVoiceProfileId, state: "DRAFT", concepts: [], scenes: [], narrationRevisions: [], voiceGenerations: [], renders: [], approvals: [], usageCosts: [], auditEvents: [], version: 1, createdAt: input.timestamp, updatedAt: input.timestamp };
      await this.projects.saveProject(project);
      created.push(project);
    }
    this.handoffs.set(operationKey, created.map((item) => item.id));
    const handed = concepts.map((concept) => input.revisionIds.includes(concept.currentRevision.id) ? { ...concept, status: "HANDED_OFF" as const, updatedAt: input.timestamp } : concept);
    this.concepts.set(batch.id, copy(handed));
    this.batches.set(batch.id, { ...batch, status: "HANDED_OFF", updatedAt: input.timestamp });
    return copy(created);
  }
}
