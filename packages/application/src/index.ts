import { createHash, randomUUID } from "node:crypto";
import { assessVoiceTiming, DEFAULT_SCENE_TRANSITION, DEFAULT_SCENE_TRANSITION_DURATION_MS, DomainError, estimateNarrationDurationMs } from "@koolezt/domain";
import { creativeInputSnapshotSha256, selectedStrategySnapshot } from "./strategy.js";
import { selectedWinnerDnaSnapshot } from "./creative-dna.js";
import { assembleCreativeConcept, boundedConceptProviderResult, conceptProviderResultSha256, validateConceptExecution } from "./concept-authority.js";
import { assertExecutionFeasible, buildExecutionFeasibilityPlan } from "./execution-feasibility.js";
import type {
  Approval,
  AuditEvent,
  CompositionProvider,
  CompositionOutputIngestor,
  CreativeConcept,
  CreativeConceptDraft,
  CreativeConceptProviderDraft,
  CreativeInputSnapshot,
  CreativeProject,
  CreativeProvider,
  CreativeScene,
  FactoryRepository,
  ExternalMediaDeliveryProvider,
  GeneratedAsset,
  RenderInputSnapshot,
  MediaInspector,
  Product,
  ProductAsset,
  ProductClaim,
  ProductPersonalizationVisualAuthority,
  ProviderSubmission,
  ReadyPublisher,
  RenderAttempt,
  SceneGenerationMethod,
  SceneAttempt,
  StorageProvider,
  UsageCost,
  VideoGenerationProvider,
  VideoOutputIngestor,
  NarrationRevision,
  VoiceGeneration,
  VoiceProvider,
  WorkflowJob,
  WorkflowJobType,
  StrategyRepository,
  CreativeDnaRepository
} from "@koolezt/domain";
export { CreativeStrategyService, STRATEGY_LIMITS, STRATEGY_REQUESTED_COUNTS, DEFAULT_STRATEGY_REQUESTED_COUNT, boundStrategyHistory, canonicalizeStrategyDraft, selectedStrategySnapshot, validateStrategyDraft, validateStrategySet } from "./strategy.js";
export { assembleCreativeConcept, bindCanonicalVisualReferences, boundedConceptProviderResult, conceptProviderResultSha256, validateConceptExecution } from "./concept-authority.js";
export { CreativeDnaService, canonicalizeCreativeDna, selectedWinnerDnaSnapshot } from "./creative-dna.js";
export { isMetaVideoUrl, MetaWinnerService, performanceFromMeta } from "./meta-winners.js";
export type { MetaImportResult } from "./meta-winners.js";
export { assertExecutionFeasible, buildExecutionFeasibilityPlan } from "./execution-feasibility.js";

type Clock = () => Date;
type IdGenerator = () => string;
class ConceptPollPending extends Error {
  constructor(public readonly nextAttemptAt:string,message="Creative Concept provider response is still running."){super(message);}
}

export type FactoryServiceDependencies = Readonly<{
  repository: FactoryRepository;
  creativeProvider: CreativeProvider;
  videoProvider: VideoGenerationProvider;
  /** Optional provider-neutral registry. Existing single-provider callers remain supported. */
  videoProviders?: VideoProviderRegistry;
  defaultVideoProviderKey?: string;
  videoOutputIngestor?: VideoOutputIngestor;
  voiceProvider: VoiceProvider;
  compositionProvider: CompositionProvider;
  /** Optional provider-neutral composition registry. Existing single-provider callers remain supported. */
  compositionProviders?: CompositionProviderRegistry;
  defaultCompositionProviderKey?: string;
  externalMediaDelivery: ExternalMediaDeliveryProvider;
  compositionOutputIngestor: CompositionOutputIngestor;
  compositionOutputIngestors?: Readonly<Record<string, CompositionOutputIngestor>>;
  storage: StorageProvider;
  mediaInspector: MediaInspector;
  readyPublisher: ReadyPublisher;
  strategyRepository?: StrategyRepository;
  creativeDnaRepository?: CreativeDnaRepository;
  now?: Clock;
  id?: IdGenerator;
}>;

export class VideoProviderRegistry {
  readonly defaultProviderKey: string;
  private readonly providers: ReadonlyMap<string, VideoGenerationProvider>;

  constructor(providers: Readonly<Record<string, VideoGenerationProvider>>, defaultProviderKey: string) {
    this.providers = new Map(Object.entries(providers).map(([key, provider]) => [key.toLowerCase(), provider]));
    this.defaultProviderKey = defaultProviderKey.toLowerCase();
    if (!this.providers.has(this.defaultProviderKey)) {
      throw new DomainError("VIDEO_PROVIDER_CONFIGURATION_MISSING", "The default video provider is not registered.");
    }
  }

  get(providerKey?: string): Readonly<{ key: string; provider: VideoGenerationProvider }> {
    const key = (providerKey ?? this.defaultProviderKey).toLowerCase();
    const provider = this.providers.get(key);
    if (!provider) throw new DomainError("VIDEO_PROVIDER_CONFIGURATION_MISSING", `Video provider ${key} is not registered.`);
    return { key, provider };
  }

  keys(): readonly string[] { return [...this.providers.keys()]; }
}

/** Selects an explicitly requested composition provider without coupling workflow code to a vendor. */
export class CompositionProviderRegistry {
  readonly defaultProviderKey: string;
  private readonly providers: ReadonlyMap<string, CompositionProvider>;

  constructor(providers: Readonly<Record<string, CompositionProvider>>, defaultProviderKey: string) {
    this.providers = new Map(Object.entries(providers).map(([key, provider]) => [key.toLowerCase(), provider]));
    this.defaultProviderKey = defaultProviderKey.toLowerCase();
    if (!this.providers.has(this.defaultProviderKey)) throw new DomainError("COMPOSITION_PROVIDER_CONFIGURATION_MISSING", "The default composition provider is not registered.");
  }

  get(providerKey?: string): Readonly<{ key: string; provider: CompositionProvider }> {
    const key = (providerKey ?? this.defaultProviderKey).toLowerCase();
    const provider = this.providers.get(key);
    if (!provider) throw new DomainError("COMPOSITION_PROVIDER_CONFIGURATION_MISSING", `Composition provider ${key} is not registered.`);
    return { key, provider };
  }

  keys(): readonly string[] { return [...this.providers.keys()]; }
}

function isAiVideoSource(sourceType: SceneAttempt["sourceType"]): boolean {
  return sourceType === "AI_VIDEO" || sourceType === "KLING_VIDEO";
}

/** Scene source types describe creative/reference requirements, not how the clip is obtained. */
function supportsManualExternalVideo(sourceType: SceneAttempt["sourceType"]): boolean {
  return isAiVideoSource(sourceType) || sourceType === "PRODUCT_IMAGE";
}

function legacyProviderKey(provider?: string, sourceType?: SceneAttempt["sourceType"]): string | undefined {
  if (provider === "fake-kling") return "fake";
  if (provider) return provider;
  return sourceType === "KLING_VIDEO" ? "kling" : undefined;
}

function attemptGenerationMethod(attempt: SceneAttempt): SceneGenerationMethod {
  // Historical attempts predate the manual workflow and retain their API behavior.
  return attempt.generationMethod ?? "API";
}

function assertState(project: CreativeProject, allowed: readonly string[], action: string): void {
  if (!allowed.includes(project.state)) {
    throw new DomainError(
      "INVALID_PROJECT_STATE",
      `${action} is not allowed while ${project.publicId} is ${project.state}.`
    );
  }
}

function currentConcept(project: CreativeProject): CreativeConcept {
  const concept = project.concepts.find((item) => item.id === project.currentConceptId);
  if (!concept) {
    throw new DomainError("CONCEPT_NOT_FOUND", "The project has no current concept.");
  }
  return concept;
}

function narrationRevisions(project: CreativeProject): readonly NarrationRevision[] {
  return project.narrationRevisions ?? [];
}

function currentNarrationRevision(project: CreativeProject): NarrationRevision | undefined {
  return narrationRevisions(project).find((item) => item.id === project.currentNarrationRevisionId);
}

function hasAcceptedCurrentVoice(project: CreativeProject): boolean {
  return Boolean(project.voiceGenerations.find((item) => item.id === project.currentVoiceGenerationId && item.status === "ACCEPTED" && item.outputAssetId));
}

function currentRender(project: CreativeProject): RenderAttempt {
  const render = project.renders.find((item) => item.id === project.currentRenderId);
  if (!render) {
    throw new DomainError("RENDER_NOT_FOUND", "The project has no current render.");
  }
  return render;
}

function validateConcept(draft: CreativeConceptDraft): void {
  if (!draft.angle.trim() || !draft.hook.trim() || !draft.voiceScript.trim() || !draft.cta.trim() ||
      !draft.editingStyleKey.trim() || !draft.musicCategory.trim() || draft.targetDurationMs <= 0) {
    throw new DomainError("INVALID_CONCEPT", "A complete concept angle, hook, duration, voice script, CTA, editing style, and music category are required.");
  }
  if (draft.scenes.length !== 3) {
    throw new DomainError("INVALID_CONCEPT_SCENES", "A Creative Factory concept must include exactly three scenes.");
  }
  const sceneNumbers = new Set<number>();
  for (const scene of draft.scenes) {
    if (sceneNumbers.has(scene.sceneNumber) || scene.intendedDurationMs <= 0 || !scene.purpose.trim() || !scene.generationPrompt.trim()) {
      throw new DomainError(
        "INVALID_CONCEPT_SCENES",
        "Scene numbers must be unique and every scene requires a positive duration, purpose, and generation prompt."
      );
    }
    sceneNumbers.add(scene.sceneNumber);
  }
}
function stableUuid(scope: string, requestId: string): string {
  const bytes = createHash("sha256").update(`koolezt:${scope}:${requestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function slugForProject(name: string, requestId: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 120) || "creative-project";
  return `${base}-${requestId.replace(/-/g, "").slice(0, 12)}`;
}


function updateProject(
  project: CreativeProject,
  patch: Partial<CreativeProject>,
  now: string
): CreativeProject {
  return {
    ...project,
    ...patch,
    version: project.version + 1,
    updatedAt: now
  };
}

function publicProjectId(number: number): string {
  return `CF-${String(number).padStart(6, "0")}`;
}

function appendAudit(
  project: CreativeProject,
  event: AuditEvent
): readonly AuditEvent[] {
  return [...project.auditEvents, event];
}

function selectedProductAssets(product: Product, selectedIds: readonly string[]): ProductAsset[] {
  const byId = new Map(product.assets.map((asset) => [asset.id, asset]));
  return selectedIds.flatMap((id) => {
    const asset = byId.get(id);
    return asset ? [asset] : [];
  });
}

export class CreativeFactoryService {
  private readonly repository: FactoryRepository;
  private readonly creativeProvider: CreativeProvider;
  private readonly videoProviders: VideoProviderRegistry;
  private readonly videoOutputIngestor: VideoOutputIngestor;
  private readonly voiceProvider: VoiceProvider;
  private readonly compositionProvider: CompositionProvider;
  private readonly compositionProviders: CompositionProviderRegistry;
  private readonly externalMediaDelivery: ExternalMediaDeliveryProvider;
  private readonly compositionOutputIngestor: CompositionOutputIngestor;
  private readonly compositionOutputIngestors: ReadonlyMap<string, CompositionOutputIngestor>;
  private readonly storage: StorageProvider;
  private readonly mediaInspector: MediaInspector;
  private readonly readyPublisher: ReadyPublisher;
  private readonly strategyRepository: StrategyRepository | undefined;
  private readonly creativeDnaRepository: CreativeDnaRepository | undefined;
  private readonly now: Clock;
  private readonly id: IdGenerator;

  constructor(dependencies: FactoryServiceDependencies) {
    this.repository = dependencies.repository;
    this.creativeProvider = dependencies.creativeProvider;
    const fallbackKey = dependencies.defaultVideoProviderKey ?? dependencies.videoProvider.providerKey ?? "fake";
    this.videoProviders = dependencies.videoProviders ?? new VideoProviderRegistry({ [fallbackKey]: dependencies.videoProvider }, fallbackKey);
    this.videoOutputIngestor = dependencies.videoOutputIngestor ?? dependencies.compositionOutputIngestor;
    this.voiceProvider = dependencies.voiceProvider;
    this.compositionProvider = dependencies.compositionProvider;
    const compositionFallbackKey = dependencies.defaultCompositionProviderKey ?? "fake";
    this.compositionProviders = dependencies.compositionProviders ?? new CompositionProviderRegistry({ [compositionFallbackKey]: dependencies.compositionProvider }, compositionFallbackKey);
    this.externalMediaDelivery = dependencies.externalMediaDelivery;
    this.compositionOutputIngestor = dependencies.compositionOutputIngestor;
    this.compositionOutputIngestors = new Map(Object.entries(dependencies.compositionOutputIngestors ?? { [compositionFallbackKey]: dependencies.compositionOutputIngestor }).map(([key, ingestor]) => [key.toLowerCase(), ingestor]));
    this.storage = dependencies.storage;
    this.mediaInspector = dependencies.mediaInspector;
    this.readyPublisher = dependencies.readyPublisher;
    this.strategyRepository = dependencies.strategyRepository;
    this.creativeDnaRepository = dependencies.creativeDnaRepository;
    this.now = dependencies.now ?? (() => new Date());
    this.id = dependencies.id ?? randomUUID;
  }

  async createProduct(input: Readonly<{
    name: string;
    slug: string;
    description: string;
    claims: readonly ProductClaim[];
    defaultCta: string;
    creativeNotes?: string;
    personalizationVisualAuthority?: ProductPersonalizationVisualAuthority;
    assets: readonly ProductAsset[];
  }>): Promise<Product> {
    if (!input.name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
      throw new DomainError(
        "INVALID_PRODUCT",
        "Product name is required and slug must be lowercase kebab-case."
      );
    }
    const assetIds = new Set(input.assets.map((asset) => asset.id));
    if (assetIds.size !== input.assets.length) {
      throw new DomainError("DUPLICATE_PRODUCT_ASSET", "Product asset IDs must be unique.");
    }
    const timestamp = this.now().toISOString();
    const product: Product = {
      id: this.id(),
      name: input.name.trim(),
      slug: input.slug,
      active: true,
      description: input.description.trim(),
      claims: [...input.claims],
      defaultCta: input.defaultCta.trim(),
      ...(input.creativeNotes ? { creativeNotes: input.creativeNotes.trim() } : {}),
      ...(input.personalizationVisualAuthority ? { personalizationVisualAuthority: input.personalizationVisualAuthority } : {}),
      assets: [...input.assets],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.repository.saveProduct(product);
    return product;
  }

  async createProject(input: Readonly<{
    productId: string;
    selectedProductAssetIds: readonly string[];
    additionalInstructions?: string;
    preferredVoiceProfileId: string;
    actor: string;
  }>): Promise<CreativeProject> {
    const product = await this.repository.getProduct(input.productId);
    if (!product.active) {
      throw new DomainError("PRODUCT_INACTIVE", "Inactive products cannot start new creatives.");
    }
    const validAssets = new Set(product.assets.map((asset) => asset.id));
    if (
      input.selectedProductAssetIds.length === 0 ||
      input.selectedProductAssetIds.some((assetId) => !validAssets.has(assetId))
    ) {
      throw new DomainError(
        "INVALID_PROJECT_ASSETS",
        "Select at least one asset belonging to the product."
      );
    }
    const timestamp = this.now().toISOString();
    const number = await this.repository.nextProjectNumber();
    const projectId = this.id();
    const project: CreativeProject = {
      id: projectId,
      publicId: publicProjectId(number),
      productId: product.id,
      selectedProductAssetIds: [...new Set(input.selectedProductAssetIds)],
      additionalInstructions: input.additionalInstructions?.trim() ?? "",
      preferredVoiceProfileId: input.preferredVoiceProfileId,
      state: "DRAFT",
      concepts: [],
      scenes: [],
      narrationRevisions: [],
      voiceGenerations: [],
      renders: [],
      approvals: [],
      usageCosts: [],
      auditEvents: [
        this.audit("PROJECT_CREATED", "creative_project", projectId, input.actor, {}, timestamp)
      ],
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.repository.saveProject(project);
    return project;
  }

  async createProjectFromBrief(input: Readonly<{
    requestId: string;
    name: string;
    creativeTopic: string;
    productDetails: string;
    targetDurationSeconds: number;
    verifiedClaims?: readonly string[];
    actor: string;
  }>): Promise<CreativeProject> {
    const projectId = stableUuid("project", input.requestId);
    try {
      return await this.repository.getProject(projectId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "PROJECT_NOT_FOUND") throw error;
    }
    const timestamp = this.now().toISOString();
    const productId = stableUuid("product", input.requestId);
    const number = await this.repository.nextProjectNumber();
    const product: Product = {
      id: productId,
      name: input.name.trim(),
      slug: slugForProject(input.name, input.requestId),
      active: true,
      description: input.productDetails.trim() || `Creative project for ${input.name.trim()}.`,
      claims: (input.verifiedClaims ?? []).map((text) => ({ kind: "FEATURE" as const, text: text.trim() })),
      defaultCta: "Create yours today",
      creativeNotes: input.creativeTopic.trim(),
      assets: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const project: CreativeProject = {
      id: projectId,
      publicId: publicProjectId(number),
      productId,
      selectedProductAssetIds: [],
      additionalInstructions: `Creative topic: ${input.creativeTopic.trim()}\nTarget duration: ${input.targetDurationSeconds} seconds.`,
      preferredVoiceProfileId: "marin",
      campaignWorkspace: true,
      strategyRequired: true,
      creativeBrief: {
        creativeTopic: input.creativeTopic.trim(),
        productDetails: input.productDetails.trim(),
        targetDurationSeconds: input.targetDurationSeconds
      },
      state: "DRAFT",
      concepts: [],
      scenes: [],
      narrationRevisions: [],
      voiceGenerations: [],
      renders: [],
      approvals: [],
      usageCosts: [],
      auditEvents: [
        this.audit("PROJECT_CREATED", "creative_project", projectId, input.actor, { requestId: input.requestId, source: "operator-ui" }, timestamp)
      ],
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try {
      if (this.repository.saveProductAndProject) await this.repository.saveProductAndProject(product, project);
      else {
        await this.repository.saveProduct(product);
        await this.repository.saveProject(project);
      }
      return project;
    } catch (error) {
      if (error instanceof DomainError && error.code === "STALE_PROJECT_VERSION") return this.repository.getProject(projectId);
      throw error;
    }
  }

  async attachProductReference(input: Readonly<{
    projectId: string;
    asset: GeneratedAsset;
    label: string;
    order: number;
    actor: string;
  }>): Promise<CreativeProject> {
    const project = await this.repository.getProject(input.projectId);
    assertState(project, ["DRAFT"], "Attach product reference");
    if (project.concepts.length > 0) {
      throw new DomainError("PRODUCT_REFERENCE_LOCKED", "Product references cannot change after concept generation begins.");
    }
    if (input.asset.kind !== "IMAGE" || input.asset.projectId !== project.id || input.asset.purpose !== "PRODUCT_REFERENCE") {
      throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH", "Product reference does not belong to this project.");
    }
    if (project.selectedProductAssetIds.includes(input.asset.id)) return project;
    const product = await this.repository.getProduct(project.productId);
    const timestamp = this.now().toISOString();
    const asset: ProductAsset = {
      id: input.asset.id,
      kind: "IMAGE",
      label: input.label.trim(),
      storageKey: input.asset.storageKey,
      mimeType: input.asset.mimeType
    };
    const ordered = [...product.assets, asset].sort((left, right) => {
      const leftOrder = left.id === asset.id ? input.order : product.assets.findIndex((item) => item.id === left.id);
      const rightOrder = right.id === asset.id ? input.order : product.assets.findIndex((item) => item.id === right.id);
      return leftOrder - rightOrder;
    });
    const updatedProduct: Product = { ...product, assets: ordered, updatedAt: timestamp };
    const updatedProject = updateProject(project, {
      selectedProductAssetIds: [...project.selectedProductAssetIds, asset.id],
      auditEvents: appendAudit(
        project,
        this.audit("PRODUCT_REFERENCE_ATTACHED", "media_asset", asset.id, input.actor, { order: input.order }, timestamp)
      )
    }, timestamp);
    if (this.repository.saveProductAndProject) {
      await this.repository.saveProductAndProject(updatedProduct, updatedProject);
    } else {
      await this.repository.saveProduct(updatedProduct);
      await this.repository.saveProject(updatedProject);
    }
    return updatedProject;
  }

  async setPrimaryProductReference(projectId: string, assetId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["DRAFT"], "Change primary product reference");
    if (!project.campaignWorkspace) {
      throw new DomainError("CAMPAIGN_REFERENCE_REQUIRED", "Primary Product reference is managed by the Campaign workspace.");
    }
    if (!project.selectedProductAssetIds.includes(assetId)) {
      throw new DomainError("INVALID_PROJECT_ASSETS", "The primary reference must already belong to this Campaign.");
    }
    const product = await this.repository.getProduct(project.productId);
    const asset = product.assets.find((item) => item.id === assetId);
    if (!asset || asset.kind !== "IMAGE") {
      throw new DomainError("INVALID_PROJECT_ASSETS", "The primary Product reference must be an image belonging to this Campaign.");
    }
    if (project.selectedProductAssetIds[0] === assetId) return project;
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      selectedProductAssetIds: [assetId, ...project.selectedProductAssetIds.filter((id) => id !== assetId)],
      auditEvents: appendAudit(project, this.audit(
        "PRIMARY_PRODUCT_REFERENCE_SELECTED",
        "product_asset",
        assetId,
        actor,
        { previousPrimaryAssetId: project.selectedProductAssetIds[0] },
        timestamp
      ))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async generateConcept(projectId: string, actor: string): Promise<CreativeProject> {
    let project = await this.repository.getProject(projectId);
    if(project.state==="CONCEPT_GENERATING"&&project.strategyOrigin)return project;
    assertState(project, ["DRAFT", "CONCEPT_REVIEW"], "Generate concept");
    const retryState = project.state;
    const product = await this.repository.getProduct(project.productId);
    const selectedAssets = selectedProductAssets(product, project.selectedProductAssetIds);
    if (project.strategyRequired && !project.strategyOrigin) {
      throw new DomainError("STRATEGY_HANDOFF_REQUIRED", "Select and send a production-safe strategy concept to Video Maker first.");
    }
    const strategyRevision = project.strategyOrigin
      ? await this.strategyRepository?.getRevision(project.strategyOrigin.conceptRevisionId)
      : undefined;
    if (project.strategyOrigin && !strategyRevision) throw new DomainError("STRATEGY_REVISION_NOT_FOUND", "The authoritative strategy revision is unavailable.");
    const strategySnapshot = strategyRevision ? selectedStrategySnapshot(strategyRevision) : undefined;
    if (project.strategyOrigin && strategySnapshot?.revisionSha256 !== project.strategyOrigin.revisionSha256) {
      throw new DomainError("STRATEGY_REVISION_CHANGED", "The authoritative strategy revision checksum no longer matches the handoff.");
    }
    const dnaRevision = project.winnerDnaOrigin && !project.winnerDnaSnapshot ? await this.creativeDnaRepository?.getRevision(project.winnerDnaOrigin.revisionId) : undefined;
    if (project.winnerDnaOrigin && !project.winnerDnaSnapshot && (!dnaRevision || !["APPROVED","ARCHIVED"].includes(dnaRevision.status))) throw new DomainError("CREATIVE_DNA_REVISION_NOT_APPROVED", "The selected Winner DNA revision is unavailable or was never approved.");
    const dnaReference = project.winnerDnaOrigin && !project.winnerDnaSnapshot ? await this.creativeDnaRepository?.getReference(project.winnerDnaOrigin.creativeReferenceId) : undefined;
    const winnerDnaSnapshot = project.winnerDnaSnapshot ?? (dnaRevision && dnaReference ? selectedWinnerDnaSnapshot(dnaReference,dnaRevision) : undefined);
    if (project.winnerDnaOrigin && winnerDnaSnapshot?.revisionSha256 !== project.winnerDnaOrigin.revisionSha256) throw new DomainError("CREATIVE_DNA_REVISION_CHANGED", "The immutable Winner DNA checksum no longer matches the handoff.");
    const currentSnapshot: CreativeInputSnapshot = {
      productName: product.name,
      description: product.description,
      claims: [...product.claims],
      defaultCta: product.defaultCta,
      ...(product.creativeNotes ? { creativeNotes: product.creativeNotes } : {}),
      ...(product.personalizationVisualAuthority ? { personalizationVisualAuthority: product.personalizationVisualAuthority } : {}),
      selectedAssets: selectedAssets.map(({ id, kind, label, mimeType }) => ({
        id,
        kind,
        label,
        mimeType
      })),
      additionalInstructions: project.additionalInstructions,
      ...(strategySnapshot ? { selectedStrategy: strategySnapshot } : {}),
      ...(winnerDnaSnapshot ? { selectedWinnerDna: winnerDnaSnapshot } : {}),
      ...(project.creativeBrief ? { creativeTopic: project.creativeBrief.creativeTopic, targetDurationMs: project.creativeBrief.targetDurationSeconds * 1000 } : {})
    };
    if (project.creativeInputSnapshot && creativeInputSnapshotSha256(project.creativeInputSnapshot.input) !== project.creativeInputSnapshot.sha256) {
      throw new DomainError("CREATIVE_INPUT_SNAPSHOT_CHANGED", "The immutable Creative Input Snapshot checksum no longer matches the handoff.");
    }
    const snapshot = project.creativeInputSnapshot?.input ?? currentSnapshot;
    if (project.strategyOrigin && snapshot.selectedStrategy?.revisionSha256 !== project.strategyOrigin.revisionSha256) throw new DomainError("STRATEGY_REVISION_CHANGED", "The Creative Input Snapshot does not contain the authoritative Strategy revision.");
    if (project.winnerDnaOrigin && snapshot.selectedWinnerDna?.revisionSha256 !== project.winnerDnaOrigin.revisionSha256) throw new DomainError("CREATIVE_DNA_REVISION_CHANGED", "The Creative Input Snapshot does not contain the selected Winner DNA revision.");
    if (snapshot.selectedStrategy) assertExecutionFeasible(snapshot);
    const revision = project.concepts.length + 1;
    const baseOperationKey = `concept:${project.id}:revision:${revision}:generate`;
    const priorTerminalAttempts = project.auditEvents.filter((event) =>
      ["CONCEPT_REJECTED", "CONCEPT_PROVIDER_FAILED", "CONCEPT_SUBMISSION_UNKNOWN", "CONCEPT_RESULT_UNAVAILABLE"].includes(event.type)
    ).length;
    const operationKey = priorTerminalAttempts === 0 ? baseOperationKey : `${baseOperationKey}:attempt:${priorTerminalAttempts + 1}`;
    const startedAt = this.now().toISOString();
    project = updateProject(project, { state: "CONCEPT_GENERATING" }, startedAt);
    await this.repository.saveProject(project);

    if(strategySnapshot){
      const existing=await this.repository.getConceptProviderOperation(operationKey);
      if(!existing)await this.repository.saveConceptProviderOperation({operationKey,projectId:project.id,state:"PENDING",provider:"configured",model:"configured",...(project.creativeInputSnapshot?{snapshotId:project.creativeInputSnapshot.id,snapshotSha256:project.creativeInputSnapshot.sha256}:{}),usage:{},validationFindings:[]});
      await this.enqueue("GENERATE_CONCEPT",project.id,this.id(),operationKey,startedAt);
      return project;
    }

    let result: Awaited<ReturnType<CreativeProvider["generateConcept"]>>;
    let generated: CreativeConceptDraft;
    let evidenceSaved = false;
    try {
      result = await this.creativeProvider.generateConcept(snapshot, {
        operationKey,
        projectId: project.id,
        targetId: `concept-revision-${revision}`
      });
      const executionFindings = [...validateConceptExecution(snapshot, result.concept)];
      if (executionFindings.length) {
        const rejectedAt=this.now().toISOString();
        await this.repository.saveConceptProviderOperation({operationKey,projectId:project.id,state:"REJECTED",provider:result.submission.provider,model:result.submission.model,...(result.submission.requestId?{requestId:result.submission.requestId}:{}),...(result.submission.providerTaskId?{providerTaskId:result.submission.providerTaskId}:{}),...(project.creativeInputSnapshot?{snapshotId:project.creativeInputSnapshot.id,snapshotSha256:project.creativeInputSnapshot.sha256}:{}),submittedAt:startedAt,completedAt:rejectedAt,durationMs:Math.max(0,Date.parse(rejectedAt)-Date.parse(startedAt)),usage:{inputTokens:result.submission.metadata.inputTokens,outputTokens:result.submission.metadata.outputTokens,totalTokens:result.submission.metadata.totalTokens},resultSha256:conceptProviderResultSha256(result.concept),safeResult:boundedConceptProviderResult(result.concept),validationFindings:executionFindings,rejectionCode:"CONCEPT_STRATEGY_MISMATCH",safeErrorMessage:"Provider execution contradicted immutable Creative authority."});
        evidenceSaved=true;
        throw new DomainError("CONCEPT_STRATEGY_MISMATCH",executionFindings.join(" "));
      }
      generated = assembleCreativeConcept(snapshot,result.concept);
      validateConcept(generated);
    } catch (error) {
      if(!evidenceSaved){const failedAt=this.now().toISOString();await this.repository.saveConceptProviderOperation({operationKey,projectId:project.id,state:"FAILED",provider:"unknown",model:"unknown",...(project.creativeInputSnapshot?{snapshotId:project.creativeInputSnapshot.id,snapshotSha256:project.creativeInputSnapshot.sha256}:{}),submittedAt:startedAt,completedAt:failedAt,durationMs:Math.max(0,Date.parse(failedAt)-Date.parse(startedAt)),usage:{},validationFindings:[],rejectionCode:error instanceof DomainError?error.code:"CONCEPT_PROVIDER_FAILED",safeErrorMessage:error instanceof Error?error.message:"Creative Concept provider failed."});}
      project = updateProject(project, { state: retryState }, this.now().toISOString());
      await this.repository.saveProject(project);
      throw error;
    }
    const completedAt = this.now().toISOString();
    await this.repository.saveConceptProviderOperation({operationKey,projectId:project.id,state:"SUCCEEDED",provider:result.submission.provider,model:result.submission.model,...(result.submission.requestId?{requestId:result.submission.requestId}:{}),...(result.submission.providerTaskId?{providerTaskId:result.submission.providerTaskId}:{}),...(project.creativeInputSnapshot?{snapshotId:project.creativeInputSnapshot.id,snapshotSha256:project.creativeInputSnapshot.sha256}:{}),submittedAt:startedAt,completedAt,durationMs:Math.max(0,Date.parse(completedAt)-Date.parse(startedAt)),usage:{inputTokens:result.submission.metadata.inputTokens,outputTokens:result.submission.metadata.outputTokens,totalTokens:result.submission.metadata.totalTokens},resultSha256:conceptProviderResultSha256(result.concept),safeResult:boundedConceptProviderResult(result.concept),validationFindings:[]});
    const conceptId = this.id();
    const concept: CreativeConcept = {
      id: conceptId,
      revision,
      source: "PROVIDER",
      status: "REVIEW",
      inputSnapshot: snapshot,
      providerMetadata: {
        provider: result.submission.provider,
        model: result.submission.model,
        requestId: result.submission.requestId,
        providerTaskId: result.submission.providerTaskId,
        operationKey,
        schemaVersion: "creative-concept/v1",
        ...result.submission.metadata
      },
      createdAt: completedAt,
      ...generated
    };
    const concepts = project.concepts.map((item) =>
      item.status === "REVIEW" ? { ...item, status: "SUPERSEDED" as const } : item
    );
    const cost = this.cost(
      result.submission.provider,
      result.submission.model,
      "CONCEPT",
      project.id,
      result.submission.requestId,
      completedAt,
      result.submission.metadata
    );
    project = updateProject(
      project,
      {
        state: "CONCEPT_REVIEW",
        concepts: [...concepts, concept],
        currentConceptId: conceptId,
        usageCosts: [...project.usageCosts, cost],
        auditEvents: appendAudit(
          project,
          this.audit(
            "CONCEPT_GENERATED",
            "creative_concept",
            conceptId,
            actor,
            { revision, operationKey },
            completedAt
          )
        )
      },
      completedAt
    );
    await this.repository.saveProject(project);
    return project;
  }


  async resetConceptForRegeneration(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["CONCEPT_REVIEW"], "Discard concept");
    const concept = currentConcept(project);
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      state: "DRAFT",
      currentConceptId: undefined,
      concepts: project.concepts.map((item) => item.id === concept.id ? { ...item, status: "SUPERSEDED" as const } : item),
      auditEvents: appendAudit(project, this.audit("CONCEPT_DISCARDED", "creative_concept", concept.id, actor, {}, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }
  async editConcept(
    projectId: string,
    patch: Partial<CreativeConceptDraft>,
    actor: string
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["CONCEPT_REVIEW"], "Edit concept");
    const previous = currentConcept(project);
    if (project.strategyOrigin && ((patch.angle !== undefined && patch.angle !== previous.angle) || (patch.hook !== undefined && patch.hook !== previous.hook) || (patch.cta !== undefined && patch.cta !== previous.cta))) {
      throw new DomainError("STRATEGY_FIELDS_IMMUTABLE", "Angle, hook, and CTA strategy are controlled by the selected immutable strategy revision.");
    }
    const draft: CreativeConceptDraft = {
      angle: patch.angle ?? previous.angle,
      hook: patch.hook ?? previous.hook,
      targetDurationMs: patch.targetDurationMs ?? previous.targetDurationMs,
      voiceScript: patch.voiceScript ?? previous.voiceScript,
      cta: patch.cta ?? previous.cta,
      editingStyleKey: patch.editingStyleKey ?? previous.editingStyleKey,
      musicCategory: patch.musicCategory ?? previous.musicCategory,
      scenes: patch.scenes ?? previous.scenes
    };
    validateConcept(draft);
    const timestamp = this.now().toISOString();
    const conceptId = this.id();
    const concept: CreativeConcept = {
      id: conceptId,
      revision: project.concepts.length + 1,
      source: "USER_EDIT",
      status: "REVIEW",
      inputSnapshot: previous.inputSnapshot,
      providerMetadata: { editedFromConceptId: previous.id },
      createdAt: timestamp,
      ...draft
    };
    const updated = updateProject(
      project,
      {
        concepts: [
          ...project.concepts.map((item) =>
            item.id === previous.id ? { ...item, status: "SUPERSEDED" as const } : item
          ),
          concept
        ],
        currentConceptId: conceptId,
        auditEvents: appendAudit(
          project,
          this.audit("CONCEPT_EDITED", "creative_concept", conceptId, actor, {}, timestamp)
        )
      },
      timestamp
    );
    await this.repository.saveProject(updated);
    return updated;
  }

  async approveConcept(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    const concept = currentConcept(project);
    // A transport retry after the committed approval must return the already
    // instantiated scene workflow instead of attempting to create it again.
    if (concept.status === "APPROVED" && project.scenes.length === 3) return project;
    assertState(project, ["CONCEPT_REVIEW"], "Approve concept");
    if (concept.status !== "REVIEW") {
      throw new DomainError("CONCEPT_NOT_REVIEWABLE", "Only the current reviewed concept can be approved.");
    }
    validateConcept(concept);
    const timestamp = this.now().toISOString();
    const approval = this.approval("CONCEPT", concept.id, actor, timestamp);
    const scenes: CreativeScene[] = concept.scenes.map((spec) => {
      const sceneId = this.id();
      const attemptId = this.id();
      const sourceType = spec.sourceType === "KLING_VIDEO" ? "AI_VIDEO" : spec.sourceType;
      const requestedGenerationMethod = supportsManualExternalVideo(sourceType) ? "MANUAL" as const : undefined;
      const requestedVideoProvider = isAiVideoSource(sourceType) && spec.sourceType === "KLING_VIDEO" ? "kling" : undefined;
      const requestedVideoModel = requestedVideoProvider
        ? (() => { try { return this.videoProviders.get(requestedVideoProvider).provider.defaultModel; } catch { return undefined; } })()
        : undefined;
      const attempt: SceneAttempt = {
        id: attemptId,
        attemptNumber: 1,
        sourceType,
        conceptSceneNumber: spec.sceneNumber,
        prompt: spec.generationPrompt,
        ...(requestedGenerationMethod ? { generationMethod: requestedGenerationMethod } : {}),
        status: "PENDING",
        operationKey: `scene:${sceneId}:attempt:1:generate`,
        ...(requestedVideoProvider ? { provider: requestedVideoProvider } : {}),
        ...(requestedVideoModel ? { providerModel: requestedVideoModel } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      return {
        id: sceneId,
        sceneNumber: spec.sceneNumber,
        status: "PENDING",
        ...(requestedVideoProvider ? { requestedVideoProvider } : {}),
        ...(requestedVideoModel ? { requestedVideoModel } : {}),
        ...(requestedGenerationMethod ? { requestedGenerationMethod } : {}),
        attempts: [attempt]
      };
    });
    let updated = updateProject(
      project,
      {
        state: "SCENES_GENERATING",
        concepts: project.concepts.map((item) =>
          item.id === concept.id ? { ...item, status: "APPROVED" as const } : item
        ),
        scenes,
        approvals: [...project.approvals, approval],
        auditEvents: appendAudit(
          project,
          this.audit(
            "CONCEPT_APPROVED",
            "creative_concept",
            concept.id,
            actor,
            { sceneCount: scenes.length },
            timestamp
          )
        )
      },
      timestamp
    );
    await this.repository.saveProject(updated);
    for (const scene of scenes) {
      const attempt = scene.attempts[0];
      if (!attempt) continue;
      if (supportsManualExternalVideo(attempt.sourceType) && attemptGenerationMethod(attempt) === "MANUAL") continue;
      await this.enqueue("GENERATE_SCENE", updated.id, attempt.id, attempt.operationKey, timestamp);
    }
    updated = await this.repository.getProject(projectId);
    return updated;
  }

  async regenerateScene(
    projectId: string,
    sceneId: string,
    prompt: string,
    actor: string,
    generationMethodOverride?: SceneGenerationMethod
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    // Manual/external scenes remain pending while an editor obtains a clip, so
    // creating a replacement attempt is valid before every scene reaches review.
    // A final candidate is immutable, but an editor may reopen a source scene to
    // create a replacement attempt. The project then returns to Scene Review;
    // the existing render remains historical until a later replacement render.
    assertState(project, ["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED", "FINAL_REVIEW"], "Regenerate scene");
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new DomainError("SCENE_NOT_FOUND", "Scene was not found.");
    if (!prompt.trim()) throw new DomainError("INVALID_SCENE_PROMPT", "Scene prompt is required.");
    const timestamp = this.now().toISOString();
    const latest = scene.attempts.at(-1);
    const attemptNumber = scene.attempts.length + 1;
    const attemptId = this.id();
    const sourceType = latest?.sourceType === "KLING_VIDEO" ? "AI_VIDEO" : latest?.sourceType ?? "AI_VIDEO";
    const generationMethod = supportsManualExternalVideo(sourceType)
      ? generationMethodOverride ?? scene.requestedGenerationMethod ?? (sourceType === "PRODUCT_IMAGE" ? "MANUAL" : latest ? attemptGenerationMethod(latest) : "MANUAL")
      : undefined;
    const requestedVideoProvider = supportsManualExternalVideo(sourceType)
      ? scene.requestedVideoProvider ?? legacyProviderKey(latest?.provider, latest?.sourceType) ?? (generationMethod === "API" ? this.videoProviders.defaultProviderKey : undefined)
      : undefined;
    const requestedVideoModel = requestedVideoProvider
      ? scene.requestedVideoModel ?? (() => { try { return this.videoProviders.get(requestedVideoProvider).provider.defaultModel; } catch { return undefined; } })()
      : undefined;
    const attempt: SceneAttempt = {
      id: attemptId,
      attemptNumber,
      sourceType,
      conceptSceneNumber: scene.sceneNumber,
      prompt: prompt.trim(),
      ...(generationMethod ? { generationMethod } : {}),
      status: "PENDING",
      operationKey: `scene:${scene.id}:attempt:${attemptNumber}:generate`,
      ...(requestedVideoProvider ? { provider: requestedVideoProvider } : {}),
      ...(requestedVideoModel ? { providerModel: requestedVideoModel } : {}),
      ...(latest?.inputAssetId ? {
        inputAssetId: latest.inputAssetId,
        ...(latest.providerMetadata?.contextProductFidelityConfirmed === true ? { providerMetadata: {
          contextProductFidelityConfirmed: true,
          contextImageSha256: latest.providerMetadata.contextImageSha256,
          contextSourceReferenceAssetIds: latest.providerMetadata.contextSourceReferenceAssetIds
        } } : {})
      } : {}),
      ...(latest ? { replacesAttemptId: latest.id } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const scenes = project.scenes.map((item) =>
      item.id === scene.id
        ? (() => {
            const reopenedScene = { ...item };
            // Do not let a historical accepted attempt satisfy editor readiness
            // while its replacement is still pending/reviewable.
            delete reopenedScene.approvedAttemptId;
            return { ...reopenedScene, status: "GENERATING" as const, attempts: [...item.attempts, attempt] };
          })()
        : item
    );
    const updated = updateProject(
      project,
      {
        state: "SCENES_REVIEW",
        scenes,
        auditEvents: appendAudit(
          project,
          this.audit(
            "SCENE_REGENERATION_REQUESTED",
            "scene_attempt",
            attempt.id,
            actor,
            { sceneId, attemptNumber },
            timestamp
          )
        )
      },
      timestamp
    );
    await this.repository.saveProject(updated);
    if (!supportsManualExternalVideo(sourceType) || generationMethod === "API") {
      await this.enqueue("GENERATE_SCENE", project.id, attempt.id, attempt.operationKey, timestamp);
    }
    return updated;
  }

  async setSceneVideoProvider(
    projectId: string,
    sceneId: string,
    requestedVideoProvider: string,
    actor: string,
    requestedVideoModel?: string
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"], "Select video provider");
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new DomainError("SCENE_NOT_FOUND", "Scene was not found.");
    const latest = scene.attempts.at(-1);
    if (!latest || !supportsManualExternalVideo(latest.sourceType)) throw new DomainError("SCENE_PROVIDER_NOT_APPLICABLE", "Only scenes with externally generated video can select a video provider.");
    if (latest.status === "SUBMITTED" || latest.status === "PROCESSING") throw new DomainError("SCENE_PROVIDER_LOCKED", "Select a provider before the scene generation starts.");
    const manualProvenanceOnly = attemptGenerationMethod(latest) === "MANUAL" && !this.videoProviders.keys().includes(requestedVideoProvider.toLowerCase());
    const resolved = manualProvenanceOnly
      ? { key: requestedVideoProvider.toLowerCase(), provider: undefined }
      : this.videoProviders.get(requestedVideoProvider);
    const timestamp = this.now().toISOString();
    const selectedModel = requestedVideoModel ?? resolved.provider?.defaultModel;
    const updated = updateProject(project, {
      scenes: project.scenes.map((item) => item.id === scene.id ? {
        ...item,
        requestedVideoProvider: resolved.key,
        ...(selectedModel ? { requestedVideoModel: selectedModel } : {}),
        // A provider preference is mutable only before its pending attempt is submitted.
        // The immutable provider/model snapshot is retained for every submitted attempt.
        attempts: item.attempts.map((candidate) => candidate.id === latest.id && candidate.status === "PENDING"
          ? { ...candidate, provider: resolved.key, ...(selectedModel ? { providerModel: selectedModel } : {}), updatedAt: timestamp }
          : candidate)
      } : item),
      auditEvents: appendAudit(project, this.audit("SCENE_VIDEO_PROVIDER_SELECTED", "creative_scene", scene.id, actor, { provider: resolved.key }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async setSceneGenerationMethod(
    projectId: string,
    sceneId: string,
    generationMethod: SceneGenerationMethod,
    actor: string
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"], "Select generation method");
    const scene = project.scenes.find((item) => item.id === sceneId);
    const latest = scene?.attempts.at(-1);
    if (!scene || !latest || !supportsManualExternalVideo(latest.sourceType)) throw new DomainError("SCENE_GENERATION_METHOD_NOT_APPLICABLE", "Only scenes with externally generated video can select a generation method.");
    if (latest.status !== "PENDING") throw new DomainError("SCENE_GENERATION_METHOD_LOCKED", "Create a new scene attempt before changing its generation method.");
    if (generationMethod === "API") {
      const providerKey = scene.requestedVideoProvider ?? this.videoProviders.defaultProviderKey;
      this.videoProviders.get(providerKey);
    }
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      scenes: project.scenes.map((item) => item.id === scene.id ? {
        ...item,
        requestedGenerationMethod: generationMethod,
        attempts: item.attempts.map((candidate) => candidate.id === latest.id
          ? { ...candidate, generationMethod, updatedAt: timestamp }
          : candidate)
      } : item),
      auditEvents: appendAudit(project, this.audit("SCENE_GENERATION_METHOD_SELECTED", "creative_scene", scene.id, actor, { generationMethod }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    if (generationMethod === "API") await this.enqueue("GENERATE_SCENE", project.id, latest.id, latest.operationKey, timestamp);
    return updated;
  }

  async attachSceneContextImage(input: Readonly<{
    projectId: string;
    sceneId: string;
    asset: GeneratedAsset;
    actor: string;
  }>): Promise<CreativeProject> {
    const project = await this.repository.getProject(input.projectId);
    assertState(project, ["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"], "Attach scene context image");
    const scene = project.scenes.find((item) => item.id === input.sceneId);
    const latest = scene?.attempts.at(-1);
    if (!scene || !latest || !supportsManualExternalVideo(latest.sourceType)) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_NOT_APPLICABLE", "Only a video-capable scene accepts a context image.");
    }
    if (latest.status !== "PENDING") {
      throw new DomainError("SCENE_CONTEXT_IMAGE_LOCKED", "Create a new scene attempt before replacing its context image.");
    }
    if (input.asset.kind !== "IMAGE" || !input.asset.mimeType.startsWith("image/") || input.asset.projectId !== project.id || input.asset.purpose !== "SCENE_CONTEXT_IMAGE" || input.asset.metadata.sceneId !== scene.id || input.asset.metadata.attemptId !== latest.id || input.asset.metadata.productFidelityConfirmed !== true) {
      throw new DomainError("INVALID_SCENE_CONTEXT_IMAGE", "The context image is not an authorized image for this scene attempt.");
    }
    const concept = currentConcept(project);
    const spec = concept.scenes.find((item) => item.sceneNumber === scene.sceneNumber);
    if (!spec) throw new DomainError("SCENE_SPEC_NOT_FOUND", "Approved scene specification missing.");
    const provenance = Array.isArray(input.asset.metadata.sourceReferenceAssetIds)
      ? input.asset.metadata.sourceReferenceAssetIds.filter((item): item is string => typeof item === "string")
      : [];
    const canonicalReferences = spec.referenceAssetIds.filter((assetId) => project.selectedProductAssetIds.includes(assetId));
    if (provenance.length === 0 || provenance.some((assetId) => !canonicalReferences.includes(assetId))) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_PROVENANCE_INVALID", "The context image is not anchored to this scene's canonical Product reference.");
    }
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      scenes: project.scenes.map((item) => item.id === scene.id ? {
        ...item,
        attempts: item.attempts.map((attempt) => attempt.id === latest.id
          ? { ...attempt, inputAssetId: input.asset.id, providerMetadata: {
            ...attempt.providerMetadata,
            contextProductFidelityConfirmed: true,
            contextImageSha256: input.asset.sha256,
            contextSourceReferenceAssetIds: provenance
          }, updatedAt: timestamp }
          : attempt)
      } : item),
      auditEvents: appendAudit(project, this.audit("SCENE_CONTEXT_IMAGE_ATTACHED", "scene_attempt", latest.id, input.actor, {
        sceneId: scene.id,
        assetId: input.asset.id,
        sha256: input.asset.sha256,
        sourceReferenceAssetIds: provenance
      }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async uploadManualSceneVideo(input: Readonly<{
    projectId: string;
    sceneId: string;
    asset: GeneratedAsset;
    provider: string;
    model?: string;
    actor: string;
  }>): Promise<CreativeProject> {
    const project = await this.repository.getProject(input.projectId);
    assertState(project, ["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"], "Upload manual scene video");
    const scene = project.scenes.find((item) => item.id === input.sceneId);
    const latest = scene?.attempts.at(-1);
    if (!scene || !latest || !supportsManualExternalVideo(latest.sourceType)) throw new DomainError("SCENE_MANUAL_UPLOAD_NOT_APPLICABLE", "Only scenes with externally generated video accept manual uploads.");
    if (attemptGenerationMethod(latest) !== "MANUAL") throw new DomainError("SCENE_MANUAL_UPLOAD_DISABLED", "Select Manual / External before uploading a generated video.");
    if (!/^[a-z][a-z0-9_-]*$/i.test(input.provider) || !input.asset.mimeType.startsWith("video/") || input.asset.kind !== "VIDEO") {
      throw new DomainError("INVALID_MANUAL_SCENE_VIDEO", "Upload a supported video and record a valid provider provenance label.");
    }
    if (["SUBMITTED", "PROCESSING", "REVIEW", "ACCEPTED"].includes(latest.status)) throw new DomainError("SCENE_MANUAL_UPLOAD_LOCKED", "Create a new scene attempt before replacing an existing reviewed or accepted video.");
    const concept = currentConcept(project);
    const spec = concept.scenes.find((item) => item.sceneNumber === scene.sceneNumber);
    if (!spec) throw new DomainError("SCENE_SPEC_NOT_FOUND", "Approved scene specification missing.");
    const timestamp = this.now().toISOString();
    const target = latest.status === "PENDING" ? latest : {
      id: this.id(), attemptNumber: scene.attempts.length + 1, sourceType: latest.sourceType,
      conceptSceneNumber: scene.sceneNumber, prompt: latest.prompt, generationMethod: "MANUAL" as const,
      operationKey: `scene:${scene.id}:attempt:${scene.attempts.length + 1}:manual-upload`, replacesAttemptId: latest.id,
      createdAt: timestamp, updatedAt: timestamp, status: "PENDING" as const
    };
    const inspection = await this.mediaInspector.inspectVideo(input.asset, { expectedDurationMs: spec.intendedDurationMs, toleranceMs: 3_000 });
    const completed: SceneAttempt = {
      ...target,
      generationMethod: "MANUAL",
      provider: input.provider.toLowerCase(),
      ...(input.model?.trim() ? { providerModel: input.model.trim() } : {}),
      providerMetadata: { generationMethod: "MANUAL", uploaded: true },
      outputAssetId: input.asset.id,
      inspection,
      status: inspection.passed ? "REVIEW" : "FAILED",
      ...(inspection.passed ? {} : { failureMessage: "Uploaded manual scene video failed local video QA." }),
      updatedAt: timestamp
    };
    const scenes = project.scenes.map((item) => item.id !== scene.id ? item : {
      ...item,
      requestedGenerationMethod: "MANUAL" as const,
      ...(completed.provider ? { requestedVideoProvider: completed.provider } : {}),
      ...(completed.providerModel ? { requestedVideoModel: completed.providerModel } : {}),
      status: inspection.passed ? "REVIEW" as const : "FAILED" as const,
      attempts: target.id === latest.id ? item.attempts.map((candidate) => candidate.id === latest.id ? completed : candidate) : [...item.attempts, completed]
    });
    const allGenerated = scenes.every((item) => item.attempts.some((candidate) => ["REVIEW", "ACCEPTED", "REJECTED"].includes(candidate.status)));
    const updated = updateProject(project, {
      state: inspection.passed && allGenerated ? "SCENES_REVIEW" : inspection.passed ? project.state : "SCENES_REVIEW",
      scenes,
      auditEvents: appendAudit(project, this.audit(inspection.passed ? "SCENE_MANUAL_VIDEO_QA_PASSED" : "SCENE_MANUAL_VIDEO_QA_FAILED", "scene_attempt", completed.id, input.actor, { sceneId: scene.id, provider: completed.provider, assetId: input.asset.id, rules: inspection.rules }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async approveScene(
    projectId: string,
    sceneId: string,
    attemptId: string,
    actor: string
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["SCENES_REVIEW", "SCENES_GENERATING"], "Approve scene");
    const scene = project.scenes.find((item) => item.id === sceneId);
    const attempt = scene?.attempts.find((item) => item.id === attemptId);
    if (!scene || !attempt || attempt.status !== "REVIEW" || !attempt.outputAssetId) {
      throw new DomainError("SCENE_NOT_REVIEWABLE", "Only a completed scene attempt can be approved.");
    }
    const timestamp = this.now().toISOString();
    const scenes = project.scenes.map((item) =>
      item.id === sceneId
        ? {
            ...item,
            status: "ACCEPTED" as const,
            approvedAttemptId: attemptId,
            attempts: item.attempts.map((candidate) =>
              candidate.id === attemptId
                ? { ...candidate, status: "ACCEPTED" as const, updatedAt: timestamp }
                : candidate
            )
          }
        : item
    );
    const allAccepted = scenes.every((item) => item.approvedAttemptId);
    const approval = this.approval("SCENE", attemptId, actor, timestamp);
    const updated = updateProject(
      project,
      {
        state: allAccepted ? "VOICE_REVIEW" : "SCENES_REVIEW",
        scenes,
        approvals: [...project.approvals, approval],
        auditEvents: appendAudit(
          project,
          this.audit("SCENE_APPROVED", "scene_attempt", attemptId, actor, { sceneId }, timestamp)
        )
      },
      timestamp
    );
    await this.repository.saveProject(updated);
    return updated;
  }

  async rejectSceneAttempt(
    projectId: string,
    sceneId: string,
    attemptId: string,
    actor: string
  ): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["SCENES_REVIEW"], "Reject scene");
    const timestamp = this.now().toISOString();
    let found = false;
    const scenes = project.scenes.map((scene) =>
      scene.id === sceneId
        ? {
            ...scene,
            status: scene.approvedAttemptId ? ("ACCEPTED" as const) : ("REVIEW" as const),
            attempts: scene.attempts.map((attempt) => {
              if (attempt.id !== attemptId || attempt.status !== "REVIEW") return attempt;
              found = true;
              return { ...attempt, status: "REJECTED" as const, updatedAt: timestamp };
            })
          }
        : scene
    );
    if (!found) throw new DomainError("SCENE_NOT_REVIEWABLE", "Scene attempt cannot be rejected.");
    const updated = updateProject(
      project,
      {
        scenes,
        approvals: [
          ...project.approvals,
          {
            ...this.approval("SCENE", attemptId, actor, timestamp),
            decision: "REJECTED" as const
          }
        ],
        auditEvents: appendAudit(
          project,
          this.audit("SCENE_REJECTED", "scene_attempt", attemptId, actor, {}, timestamp)
        )
      },
      timestamp
    );
    await this.repository.saveProject(updated);
    return updated;
  }

  async saveNarrationScript(projectId: string, script: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["VOICE_REVIEW", "READY"], "Save voice script");
    const clean = script.trim();
    if (!clean) throw new DomainError("INVALID_NARRATION_SCRIPT", "Voice script is required.");
    const current = currentNarrationRevision(project);
    if (current?.script === clean) return project;
    const timestamp = this.now().toISOString();
    const revision = this.createNarrationRevision(project, clean, "MANUAL", timestamp, current?.id);
    const updated = updateProject(project, {
      narrationRevisions: [...narrationRevisions(project), revision],
      currentNarrationRevisionId: revision.id,
      auditEvents: appendAudit(project, this.audit("NARRATION_SCRIPT_SAVED", "narration_revision", revision.id, actor, { revision: revision.revision, free: true }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async rewriteNarrationToFit(projectId: string, script: string, actor: string): Promise<CreativeProject> {
    let project = await this.repository.getProject(projectId);
    assertState(project, ["VOICE_REVIEW", "READY"], "Rewrite voice script");
    const clean = script.trim();
    if (!clean) throw new DomainError("INVALID_NARRATION_SCRIPT", "Voice script is required.");
    const concept = currentConcept(project);
    let parent = currentNarrationRevision(project);
    if (!parent || parent.script !== clean) {
      const timestamp = this.now().toISOString();
      const manual = this.createNarrationRevision(project, clean, "MANUAL", timestamp, parent?.id);
      project = updateProject(project, {
        narrationRevisions: [...narrationRevisions(project), manual], currentNarrationRevisionId: manual.id,
        auditEvents: appendAudit(project, this.audit("NARRATION_SCRIPT_SAVED", "narration_revision", manual.id, actor, { revision: manual.revision, free: true }, timestamp))
      }, timestamp);
      await this.repository.saveProject(project);
      parent = manual;
    }
    if (!this.creativeProvider.rewriteNarration) throw new DomainError("NARRATION_REWRITE_UNAVAILABLE", "Narration rewrite is not configured for this Creative Provider.");
    const product = await this.repository.getProduct(project.productId);
    const timing = assessVoiceTiming(concept.targetDurationMs);
    const revisionNumber = narrationRevisions(project).length + 1;
    const operationKey = `narration-rewrite:${project.id}:revision:${revisionNumber}:rewrite`;
    const result = await this.creativeProvider.rewriteNarration({
      script: parent.script, targetDurationMs: concept.targetDurationMs,
      recommendedMinimumMs: timing.minimumMs, recommendedMaximumMs: timing.maximumMs,
      productName: product.name, ...(project.creativeBrief?.creativeTopic ? { creativeTopic: project.creativeBrief.creativeTopic } : {}),
      ...(project.creativeBrief?.productDetails ? { productDetails: project.creativeBrief.productDetails } : {}), cta: concept.cta
    }, { operationKey, projectId: project.id, targetId: `narration-revision-${revisionNumber}` });
    const rewritten = String(result.script ?? "").trim();
    if (!rewritten) throw new DomainError("PROVIDER_NARRATION_REWRITE_INVALID", "Narration rewrite was empty.");
    const completedAt = this.now().toISOString();
    const revision = this.createNarrationRevision(project, rewritten, "AI_REWRITE", completedAt, parent.id, {
      provider: result.submission.provider, providerModel: result.submission.model, providerRequestId: result.submission.requestId,
      providerMetadata: { operationKey, ...result.submission.metadata }
    });
    const updated = updateProject(project, {
      narrationRevisions: [...narrationRevisions(project), revision], currentNarrationRevisionId: revision.id,
      usageCosts: [...project.usageCosts, this.cost(result.submission.provider, result.submission.model, "CONCEPT", project.id, result.submission.requestId, completedAt, result.submission.metadata)],
      auditEvents: appendAudit(project, this.audit("NARRATION_REWRITTEN_TO_FIT", "narration_revision", revision.id, actor, { revision: revision.revision, operationKey }, completedAt))
    }, completedAt);
    await this.repository.saveProject(updated);
    return updated;
  }

  async generateVoice(projectId: string, actor: string, options: Readonly<{ voiceProfileId?: string; script?: string; instructions?: string }> = {}): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    // A duplicate browser click/retry must never submit a second billable TTS request while one is in flight.
    // Check this before the state guard because the first request intentionally moves a non-READY project to VOICE_GENERATING.
    const inFlightVoice = project.voiceGenerations.find((item) => ["PENDING", "SUBMITTED", "PROCESSING"].includes(item.status));
    if (inFlightVoice) return project;
    assertState(project, ["VOICE_REVIEW", "SCENES_APPROVED", "READY"], "Generate voice");
    const concept = currentConcept(project);
    const currentRevision = currentNarrationRevision(project);
    const script = options.script?.trim() || currentRevision?.script || concept.voiceScript;
    if (!script) throw new DomainError("INVALID_NARRATION_SCRIPT", "Voice script is required.");

    const timestamp = this.now().toISOString();
    const revision = currentRevision?.script === script
      ? currentRevision
      : this.createNarrationRevision(project, script, currentRevision || options.script?.trim() ? "MANUAL" : "CONCEPT", timestamp, currentRevision?.id);
    const revisions = revision === currentRevision ? narrationRevisions(project) : [...narrationRevisions(project), revision!];
    const attemptNumber = project.voiceGenerations.length + 1;
    const generationId = this.id();
    const operationKey = `voice:${project.id}:attempt:${attemptNumber}:generate`;
    const voice: VoiceGeneration = {
      id: generationId, attemptNumber, voiceProfileId: options.voiceProfileId ?? project.preferredVoiceProfileId,
      sourceScript: script, ...(revision ? { narrationRevisionId: revision.id } : {}),
      ...(options.instructions?.trim() ? { deliveryInstructions: options.instructions.trim() } : {}),
      status: "PENDING", operationKey, createdAt: timestamp, updatedAt: timestamp
    };
    const retainAccepted = hasAcceptedCurrentVoice(project);
    const updated = updateProject(project, {
      state: project.state === "READY" ? "READY" : "VOICE_GENERATING",
      preferredVoiceProfileId: options.voiceProfileId ?? project.preferredVoiceProfileId,
      narrationRevisions: revisions, ...(revision ? { currentNarrationRevisionId: revision.id } : {}),
      voiceGenerations: [...project.voiceGenerations, voice],
      ...(retainAccepted ? { candidateVoiceGenerationId: voice.id } : { currentVoiceGenerationId: voice.id }),
      auditEvents: appendAudit(project, this.audit("VOICE_GENERATION_REQUESTED", "voice_generation", voice.id, actor, { narrationRevisionId: voice.narrationRevisionId }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    await this.enqueue("GENERATE_VOICE", project.id, voice.id, operationKey, timestamp);
    return updated;
  }

  async regenerateVoice(
    projectId: string,
    voiceProfileId: string,
    actor: string
  ): Promise<CreativeProject> {
    return this.generateVoice(projectId, actor, { voiceProfileId });
  }

  async approveVoice(projectId: string, voiceId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["VOICE_REVIEW", "READY"], "Approve voice");
    const voice = project.voiceGenerations.find((candidate) => candidate.id === voiceId);
    if (!voice || voice.status !== "REVIEW" || !voice.outputAssetId || !voice.inspection?.passed) throw new DomainError("VOICE_NOT_REVIEWABLE", "Only a QA-passed voice attempt can be approved.");
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      state: project.state === "READY" ? "READY" : "VOICE_REVIEW",
      voiceGenerations: project.voiceGenerations.map((item) => item.id === voice.id ? { ...item, status: "ACCEPTED" as const, updatedAt: timestamp } : item),
      currentVoiceGenerationId: voice.id,
      candidateVoiceGenerationId: undefined,
      approvals: [...project.approvals, this.approval("VOICE", voice.id, actor, timestamp)],
      auditEvents: appendAudit(project, this.audit("VOICE_APPROVED", "voice_generation", voice.id, actor, { narrationRevisionId: voice.narrationRevisionId }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async rejectVoice(projectId: string, voiceId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["VOICE_REVIEW", "READY"], "Reject voice");
    const voice = project.voiceGenerations.find((candidate) => candidate.id === voiceId);
    if (!voice || voice.status !== "REVIEW") throw new DomainError("VOICE_NOT_REVIEWABLE", "Only a reviewable voice attempt can be rejected.");
    const timestamp = this.now().toISOString();
    const rejectingCurrent = project.currentVoiceGenerationId === voice.id;
    const updated = updateProject(project, {
      state: project.state === "READY" ? "READY" : "VOICE_REVIEW",
      voiceGenerations: project.voiceGenerations.map((item) => item.id === voice.id ? { ...item, status: "REJECTED" as const, updatedAt: timestamp } : item),
      ...(rejectingCurrent ? { currentVoiceGenerationId: undefined } : {}),
      ...(project.candidateVoiceGenerationId === voice.id ? { candidateVoiceGenerationId: undefined } : {}),
      approvals: [...project.approvals, { ...this.approval("VOICE", voice.id, actor, timestamp), decision: "REJECTED" as const }],
      auditEvents: appendAudit(project, this.audit("VOICE_REJECTED", "voice_generation", voice.id, actor, {}, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async markEditorWorkComplete(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["VOICE_REVIEW"], "Mark editor work complete");
    for (const scene of project.scenes) {
      const attempt = scene.attempts.find((candidate) => candidate.id === scene.approvedAttemptId);
      if (!attempt || attempt.status !== "ACCEPTED" || !attempt.outputAssetId) {
        throw new DomainError("SCENES_NOT_READY_FOR_RENDER", "Every required scene must have an accepted QA-passed attempt.");
      }
      const asset = await this.storage.getAsset(attempt.outputAssetId);
      if (asset.kind === "VIDEO" && !attempt.inspection?.passed) {
        throw new DomainError("SCENES_NOT_READY_FOR_RENDER", "Every accepted video scene must pass local media QA.");
      }
    }
    const voice = project.voiceGenerations.find((candidate) => candidate.id === project.currentVoiceGenerationId);
    if (!voice || voice.status !== "ACCEPTED" || !voice.outputAssetId || !voice.inspection?.passed) {
      throw new DomainError("VOICE_NOT_READY", "An accepted QA-passed narration is required before editor completion.");
    }
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      state: "READY_FOR_RENDER",
      auditEvents: appendAudit(project, this.audit("EDITOR_WORK_COMPLETED", "creative_project", project.id, actor, {
        sceneAttemptIds: project.scenes.map((scene) => scene.approvedAttemptId),
        voiceGenerationId: voice.id
      }, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  /** Explicit recovery for projects created before operator voice acceptance existed. */
  async beginVoiceReview(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["FINAL_REVIEW", "SCENES_APPROVED"], "Return to voice review");
    if (!project.scenes.every((scene) => scene.approvedAttemptId)) throw new DomainError("SCENES_NOT_APPROVED", "All scenes must be approved before voice review.");
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, { state: "VOICE_REVIEW", auditEvents: appendAudit(project, this.audit("VOICE_REVIEW_REOPENED", "creative_project", project.id, actor, {}, timestamp)) }, timestamp);
    await this.repository.saveProject(updated); return updated;
  }

  /** Safe recovery for pre-explicit-render projects: preserve history and await an operator render choice. */
  async beginCompositionReview(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["FINAL_REVIEW", "SCENES_APPROVED"], "Prepare final render");
    if (!project.scenes.every((scene) => scene.approvedAttemptId)) throw new DomainError("SCENES_NOT_APPROVED", "All scenes must be approved before composition.");
    const voice = project.voiceGenerations.find((candidate) => candidate.id === project.currentVoiceGenerationId);
    if (!voice || voice.status !== "ACCEPTED" || !voice.outputAssetId) throw new DomainError("VOICE_NOT_READY", "An accepted narration is required before composition.");
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, { state: "READY_FOR_RENDER", auditEvents: appendAudit(project, this.audit("COMPOSITION_REVIEW_OPENED", "creative_project", project.id, actor, {}, timestamp)) }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async renderFinal(projectId: string, actor: string, requestedProvider?: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["READY_FOR_RENDER", "COMPOSITION_PENDING", "FINAL_REVIEW", "READY"], "Render final video");
    const publishedCandidate = project.state === "READY";
    const priorCandidate = project.candidateRenderId ? project.renders.find((item) => item.id === project.candidateRenderId) : undefined;
    if (publishedCandidate && priorCandidate && ["PENDING", "SUBMITTED", "PROCESSING", "SUBMISSION_UNKNOWN"].includes(priorCandidate.status)) return project;
    const resolvedProvider = this.compositionProviders.get(requestedProvider);
    const unavailable = resolvedProvider.provider as CompositionProvider & { configurationError?: Readonly<{ code: string; message: string }> };
    if (unavailable.configurationError) throw new DomainError(unavailable.configurationError.code, unavailable.configurationError.message);
    const { key } = resolvedProvider;
    const voice = project.voiceGenerations.find((candidate) => candidate.id === project.currentVoiceGenerationId);
    if (!voice || voice.status !== "ACCEPTED" || !voice.outputAssetId) throw new DomainError("VOICE_NOT_READY", "An accepted narration is required to render.");
    const sceneAttemptIds = project.scenes.map((scene) => {
      if (!scene.approvedAttemptId) throw new DomainError("SCENES_NOT_APPROVED", "All scenes must be approved before rendering.");
      return scene.approvedAttemptId;
    });
    const concept = currentConcept(project); const timestamp = this.now().toISOString();
    const attemptNumber = project.renders.length + 1; const renderId = this.id(); const operationKey = `render:${project.id}:attempt:${attemptNumber}:compose`;
    const render: RenderAttempt = { id: renderId, attemptNumber, status: "PENDING", operationKey, sceneAttemptIds, voiceGenerationId: voice.id, compositionStyleKey: concept.editingStyleKey, cta: concept.cta, inputSnapshot: await this.buildRenderInputSnapshot(project, voice, concept), requestedProvider: key, createdAt: timestamp, updatedAt: timestamp };
    const priorRenders = publishedCandidate && priorCandidate?.status === "SUCCEEDED" ? project.renders.map((item) => item.id === priorCandidate.id ? { ...item, status: "REJECTED" as const, updatedAt: timestamp } : item) : project.renders;
    const updated = updateProject(project, { state: publishedCandidate ? "READY" : "RENDERING", renders: [...priorRenders, render], ...(publishedCandidate ? { candidateRenderId: render.id } : { currentRenderId: render.id }), auditEvents: appendAudit(project, this.audit("FINAL_RENDER_REQUESTED", "render", render.id, actor, { provider: key, candidate: publishedCandidate }, timestamp)) }, timestamp);
    await this.repository.saveProject(updated); await this.enqueue("COMPOSE_RENDER", project.id, render.id, operationKey, timestamp);
    return updated;
  }

  async renderAgain(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    return this.renderFinal(projectId, actor, currentRender(project).requestedProvider ?? currentRender(project).provider);
  }

  async discardCandidateRender(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["READY"], "Discard candidate render");
    const candidate = project.candidateRenderId ? project.renders.find((item) => item.id === project.candidateRenderId) : undefined;
    if (!candidate || !["SUCCEEDED", "QA_FAILED", "FAILED"].includes(candidate.status)) throw new DomainError("CANDIDATE_RENDER_NOT_DISCARDABLE", "Only a completed candidate render can be discarded.");
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, { candidateRenderId: undefined, renders: project.renders.map((item) => item.id === candidate.id ? { ...item, status: "REJECTED" as const, updatedAt: timestamp } : item), auditEvents: appendAudit(project, this.audit("CANDIDATE_RENDER_DISCARDED", "render", candidate.id, actor, {}, timestamp)) }, timestamp);
    await this.repository.saveProject(updated);
    return updated;
  }

  async submitForOwnerReview(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["FINAL_REVIEW", "READY"], "Submit for owner review");
    const render = project.state === "READY" && project.candidateRenderId
      ? project.renders.find((candidate) => candidate.id === project.candidateRenderId)
      : project.renders.find((candidate) => candidate.id === project.currentRenderId);
    if (!render || render.status !== "SUCCEEDED" || !render.outputAssetId || !render.outputSha256 || !render.inspection?.passed) throw new DomainError("RENDER_NOT_REVIEWABLE", "Only a QA-passed final candidate can be submitted for owner review.");
    if (project.ownerReviewRenderId === render.id) return project;
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, { state: "OWNER_REVIEW", ownerReviewRenderId: render.id, auditEvents: appendAudit(project, this.audit("FINAL_CANDIDATE_SUBMITTED_FOR_OWNER_REVIEW", "render", render.id, actor, { sha256: render.outputSha256 }, timestamp)) }, timestamp);
    await this.repository.saveProject(updated); return updated;
  }

  async requestAnotherVersion(projectId: string, actor: string): Promise<CreativeProject> {
    const project = await this.repository.getProject(projectId);
    assertState(project, ["OWNER_REVIEW"], "Request another version");
    const render = project.renders.find((candidate) => candidate.id === project.ownerReviewRenderId);
    if (!render) throw new DomainError("OWNER_REVIEW_RENDER_NOT_FOUND", "The owner-review candidate was not found.");
    const hasPublishedFinal = Boolean(project.readyFile && project.currentRenderId && project.currentRenderId !== render.id);
    const timestamp = this.now().toISOString();
    const updated = updateProject(project, {
      state: hasPublishedFinal ? "READY" : "READY_FOR_RENDER", ownerReviewRenderId: undefined,
      ...(project.candidateRenderId === render.id ? { candidateRenderId: undefined } : {}),
      renders: project.renders.map((candidate) => candidate.id === render.id ? { ...candidate, status: "REJECTED" as const, updatedAt: timestamp } : candidate),
      auditEvents: appendAudit(project, this.audit("OWNER_REQUESTED_ANOTHER_VERSION", "render", render.id, actor, {}, timestamp))
    }, timestamp);
    await this.repository.saveProject(updated); return updated;
  }
  private async processConceptJob(job:WorkflowJob):Promise<"DONE"|"WAITING">{
    let project=await this.repository.getProject(job.projectId);
    const existingConcept=project.concepts.find(item=>item.providerMetadata.operationKey===job.dedupeKey);
    const storedOperation=await this.repository.getConceptProviderOperation(job.dedupeKey);
    if(existingConcept){
      if(storedOperation&&storedOperation.state!=="SUCCEEDED")await this.repository.saveConceptProviderOperation({...storedOperation,state:"SUCCEEDED",completedAt:this.now().toISOString(),safeErrorMessage:undefined,rejectionCode:undefined});
      return "DONE";
    }
    const snapshotRecord=project.creativeInputSnapshot;
    if(!snapshotRecord||creativeInputSnapshotSha256(snapshotRecord.input)!==snapshotRecord.sha256)throw new DomainError("CREATIVE_INPUT_SNAPSHOT_CHANGED","The immutable Creative Input Snapshot checksum no longer matches the handoff.");
    const snapshot=snapshotRecord.input;
    const feasibilityPlan=assertExecutionFeasible(snapshot);
    if(!snapshot.selectedStrategy)throw new DomainError("BACKGROUND_CONCEPT_REQUIRES_STRATEGY","Only Strategy-linked Creative Concepts use the background workflow.");
    if(!this.creativeProvider.submitConceptExecution||!this.creativeProvider.retrieveConceptExecution)throw new DomainError("CONCEPT_PROVIDER_UNAVAILABLE","The configured creative provider does not support recoverable background Creative Concept execution.");
    if(!storedOperation)throw new DomainError("CONCEPT_OPERATION_NOT_FOUND","The durable Creative Concept provider operation is missing.");
    let operation=storedOperation;
    if(["REJECTED","FAILED","SUBMISSION_UNKNOWN","RESULT_UNAVAILABLE"].includes(operation.state))throw new DomainError(`CONCEPT_${operation.state}`,operation.safeErrorMessage??"Creative Concept generation requires explicit operator review.");

    const resetProject=async(type:string,message:string)=>{
      project=updateProject(project,{state:"DRAFT",auditEvents:appendAudit(project,this.audit(type,"provider_operation",job.targetId,"worker",{operationKey:job.dedupeKey,message},this.now().toISOString()))},this.now().toISOString());
      await this.repository.saveProject(project);
    };
    let response:Awaited<ReturnType<NonNullable<CreativeProvider["submitConceptExecution"]>>>|undefined;
    let draft:Parameters<typeof boundedConceptProviderResult>[0]|undefined;
    if(operation.state==="POLLING"&&operation.latestProviderStatus==="completed"&&operation.safeResult&&!operation.safeResult.truncated){
      draft=operation.safeResult as typeof draft;
    }else if(operation.state==="POLLING"){
      if(!operation.providerTaskId){
        const timestamp=this.now().toISOString();
        operation={...operation,state:"RESULT_UNAVAILABLE",completedAt:timestamp,rejectionCode:"CONCEPT_RESULT_UNAVAILABLE",safeErrorMessage:"The known Creative Concept submission has no durable Response ID."};
        await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_RESULT_UNAVAILABLE",operation.safeErrorMessage!);
        throw new DomainError("CONCEPT_RESULT_UNAVAILABLE",operation.safeErrorMessage!);
      }
      try{response=await this.creativeProvider.retrieveConceptExecution(operation.providerTaskId);}
      catch(error){
        const timestamp=this.now().toISOString();
        if(error instanceof DomainError&&error.code==="PROVIDER_CONCEPT_RESULT_UNAVAILABLE"){
          operation={...operation,state:"RESULT_UNAVAILABLE",completedAt:timestamp,rejectionCode:error.code,safeErrorMessage:error.message};
          await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_RESULT_UNAVAILABLE",error.message);throw error;
        }
        operation={...operation,latestPollAt:timestamp,safeErrorMessage:error instanceof Error?error.message:"Creative Concept retrieval failed."};
        await this.repository.saveConceptProviderOperation(operation);
        throw new ConceptPollPending(new Date(Date.parse(timestamp)+5_000).toISOString(),"Creative Concept retrieval will resume from the persisted Response ID.");
      }
    }else if(operation.state==="SUBMITTING"){
      const ageMs=Date.now()-Date.parse(operation.latestPollAt??operation.submittedAt??project.updatedAt);
      if(Number.isFinite(ageMs)&&ageMs<120_000)throw new ConceptPollPending(new Date(Date.now()+5_000).toISOString(),"Creative Concept submission is already being claimed.");
      const timestamp=this.now().toISOString();
      operation={...operation,state:"SUBMISSION_UNKNOWN",completedAt:timestamp,rejectionCode:"PROVIDER_CONCEPT_SUBMISSION_UNKNOWN",safeErrorMessage:"Worker stopped after paid submission began but before a Response ID was persisted."};
      await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_SUBMISSION_UNKNOWN",operation.safeErrorMessage!);
      throw new DomainError("CONCEPT_SUBMISSION_UNKNOWN",operation.safeErrorMessage!);
    }else{
      const begun=await this.repository.beginConceptProviderOperation(job.dedupeKey);
      operation=begun.operation;
      if(!begun.claimed)throw new ConceptPollPending(new Date(Date.now()+5_000).toISOString(),"Creative Concept operation is already claimed.");
      const submittedAt=this.now().toISOString();
      operation={...operation,state:"SUBMITTING",submittedAt,latestPollAt:submittedAt};
      await this.repository.saveConceptProviderOperation(operation);
      try{response=await this.creativeProvider.submitConceptExecution(snapshot,{operationKey:job.dedupeKey,projectId:project.id,targetId:job.targetId},feasibilityPlan);}
      catch(error){
        const timestamp=this.now().toISOString();
        const unknown=error instanceof DomainError&&error.code.endsWith("SUBMISSION_UNKNOWN");
        operation={...operation,state:unknown?"SUBMISSION_UNKNOWN":"FAILED",completedAt:timestamp,rejectionCode:error instanceof DomainError?error.code:"CONCEPT_PROVIDER_FAILED",safeErrorMessage:error instanceof Error?error.message:"Creative Concept submission failed."};
        await this.repository.saveConceptProviderOperation(operation);await resetProject(unknown?"CONCEPT_SUBMISSION_UNKNOWN":"CONCEPT_PROVIDER_FAILED",operation.safeErrorMessage!);throw error;
      }
    }

    if(response){
      const polledAt=this.now().toISOString();
      operation={...operation,state:"POLLING",provider:response.provider,model:response.model,requestId:response.responseId,providerTaskId:response.responseId,submittedAt:operation.submittedAt??polledAt,latestProviderStatus:response.status,latestPollAt:polledAt,usage:response.usage??{},safeErrorMessage:undefined,rejectionCode:undefined};
      await this.repository.saveConceptProviderOperation(operation);
      if(response.status==="queued"||response.status==="in_progress")throw new ConceptPollPending(new Date(Date.parse(polledAt)+5_000).toISOString(),`Creative Concept response is ${response.status}; polling will resume from the persisted Response ID.`);
      if(response.status!=="completed"){
        const message=response.safeError?.message??`OpenAI Creative Concept response ended with status ${response.status}.`;
        operation={...operation,state:"FAILED",completedAt:polledAt,rejectionCode:"CONCEPT_PROVIDER_TERMINAL_FAILURE",safeErrorMessage:message};
        await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_PROVIDER_FAILED",message);throw new DomainError("CONCEPT_PROVIDER_TERMINAL_FAILURE",message);
      }
      if(!response.outputText){
        operation={...operation,state:"FAILED",completedAt:polledAt,rejectionCode:"PROVIDER_CONCEPT_INVALID",safeErrorMessage:"Completed Creative Concept response contained no structured output."};
        await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_PROVIDER_FAILED",operation.safeErrorMessage!);throw new DomainError("PROVIDER_CONCEPT_INVALID",operation.safeErrorMessage!);
      }
      try{draft=JSON.parse(response.outputText) as typeof draft;}catch{
        operation={...operation,state:"FAILED",completedAt:polledAt,rejectionCode:"PROVIDER_CONCEPT_INVALID",safeErrorMessage:"Completed Creative Concept response contained malformed structured output."};
        await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_PROVIDER_FAILED",operation.safeErrorMessage!);throw new DomainError("PROVIDER_CONCEPT_INVALID",operation.safeErrorMessage!);
      }
      operation={...operation,resultSha256:conceptProviderResultSha256(draft!),safeResult:boundedConceptProviderResult(draft!)};
      await this.repository.saveConceptProviderOperation(operation);
    }
    if(!draft)throw new DomainError("CONCEPT_RESULT_UNAVAILABLE","The durable Creative Concept result cannot be replayed.");
    const findings=[...validateConceptExecution(snapshot,draft)];
    const methods=new Set([snapshot.selectedStrategy.primaryProductionMethod,...snapshot.selectedStrategy.supportingProductionMethods]);
    const allowsProductImage=methods.has("PRODUCT_IMAGE_MOTION")||methods.has("PERSONALIZATION_DEMO")||methods.has("MOTION_GRAPHICS");
    if(!allowsProductImage&&draft.scenes.some(scene=>scene.sourceType==="PRODUCT_IMAGE"))findings.push("PRODUCTION_METHOD_CHANGED: execution uses Product-image motion outside the selected Strategy methods.");
    const completedAt=this.now().toISOString();
    if(findings.length){
      operation={...operation,state:"REJECTED",completedAt,durationMs:operation.submittedAt?Math.max(0,Date.parse(completedAt)-Date.parse(operation.submittedAt)):undefined,validationFindings:findings,rejectionCode:"CONCEPT_STRATEGY_MISMATCH",safeErrorMessage:"Provider execution contradicted immutable Creative authority."};
      await this.repository.saveConceptProviderOperation(operation);await resetProject("CONCEPT_REJECTED",operation.safeErrorMessage!);throw new DomainError("CONCEPT_STRATEGY_MISMATCH",findings.join(" "));
    }
    const generated=assembleCreativeConcept(snapshot,draft);validateConcept(generated);
    const revision=project.concepts.length+1;const conceptId=this.id();
    const concept:CreativeConcept={id:conceptId,revision,source:"PROVIDER",status:"REVIEW",inputSnapshot:snapshot,providerMetadata:{provider:operation.provider,model:operation.model,requestId:operation.requestId,providerTaskId:operation.providerTaskId,operationKey:job.dedupeKey,schemaVersion:"creative-concept/v1",...operation.usage},createdAt:completedAt,...generated};
    project=updateProject(project,{state:"CONCEPT_REVIEW",concepts:[...project.concepts.map(item=>item.status==="REVIEW"?{...item,status:"SUPERSEDED" as const}:item),concept],currentConceptId:conceptId,usageCosts:[...project.usageCosts,this.cost(operation.provider,operation.model,"CONCEPT",project.id,operation.requestId??operation.providerTaskId??job.dedupeKey,completedAt,operation.usage)],auditEvents:appendAudit(project,this.audit("CONCEPT_GENERATED","creative_concept",conceptId,"worker",{revision,operationKey:job.dedupeKey},completedAt))},completedAt);
    try {
      await this.repository.saveProject(project);
    } catch {
      throw new ConceptPollPending(new Date(Date.now()+5_000).toISOString(),"The completed Creative Concept result is durable; local persistence will be replayed without another provider submission.");
    }
    operation={...operation,state:"SUCCEEDED",completedAt,durationMs:operation.submittedAt?Math.max(0,Date.parse(completedAt)-Date.parse(operation.submittedAt)):undefined,validationFindings:[],safeErrorMessage:undefined,rejectionCode:undefined};
    await this.repository.saveConceptProviderOperation(operation);
    return "DONE";
  }

  async processJob(jobId: string): Promise<WorkflowJob> {
    let job = await this.repository.getJob(jobId);
    if (job.status === "COMPLETED"||job.status==="FAILED") return job;
    const timestamp = this.now().toISOString();
    job = {
      ...job,
      status: "RUNNING",
      attempts: job.attempts + 1,
      updatedAt: timestamp
    };
    await this.repository.saveJob(job);
    try {
      let outcome: "DONE" | "WAITING";
      if (job.type === "GENERATE_CONCEPT") outcome = await this.processConceptJob(job);
      else if (job.type === "GENERATE_SCENE") outcome = await this.processSceneJob(job);
      else if (job.type === "GENERATE_VOICE") outcome = await this.processVoiceJob(job);
      else outcome = await this.processRenderJob(job);
      const terminalJob={...job};
      delete terminalJob.lastError;
      delete terminalJob.nextAttemptAt;
      const completed: WorkflowJob = {
        ...terminalJob,
        status: outcome === "DONE" ? "COMPLETED" : "PENDING",
        updatedAt: this.now().toISOString()
      };
      await this.repository.saveJob(completed);
      return completed;
    } catch (error) {
      const retryable=error instanceof ConceptPollPending;
      const failed: WorkflowJob = {
        ...job,
        status: retryable?"PENDING":"FAILED",
        ...(retryable?{nextAttemptAt:error.nextAttemptAt}:{}),
        lastError: error instanceof Error ? error.message : "Unknown workflow failure.",
        updatedAt: this.now().toISOString()
      };
      await this.repository.saveJob(failed);
      if(!retryable)throw error;
      return failed;
    }
  }

  /**
   * A desktop worker has already uploaded and passed server-side QA when this
   * runs. Reconcile the durable composition workflow immediately rather than
   * waiting for an exponential BullMQ polling retry.
   */
  async reconcileCompletedDesktopRender(projectId: string, renderId: string): Promise<CreativeProject> {
    const jobs = await this.repository.listJobs(projectId);
    const workflow = jobs.find((job) => job.type === "COMPOSE_RENDER" && job.targetId === renderId);
    if (!workflow) throw new DomainError("RENDER_WORKFLOW_NOT_FOUND", "Desktop render workflow is missing.");
    await this.processJob(workflow.id);
    return this.repository.getProject(projectId);
  }
  async processAllPendingJobs(projectId: string): Promise<void> {
    // Test/dev helper only: production retries are driven by durable BullMQ delivery.
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const jobs = await this.repository.listJobs(projectId);
      const pending = jobs.find((job) => job.status === "PENDING");
      if (!pending) return;
      await this.processJob(pending.id);
    }
    throw new DomainError("WORKFLOW_DID_NOT_SETTLE", "Pending workflow jobs did not settle within the safety limit.");
  }

  async approveAndSave(projectId: string, actor: string): Promise<CreativeProject> {
    let project = await this.repository.getProject(projectId);
    assertState(project, ["FINAL_REVIEW", "OWNER_REVIEW", "READY"], "Approve and save");
    const replacingPublished = Boolean(project.readyFile && project.currentRenderId);
    const render = project.state === "OWNER_REVIEW"
      ? project.renders.find((item) => item.id === project.ownerReviewRenderId)
      : project.state === "READY"
        ? project.renders.find((item) => item.id === project.candidateRenderId)
        : currentRender(project);
    if (!render) throw new DomainError("CANDIDATE_RENDER_NOT_APPROVABLE", "A completed candidate render is required to replace the published final.");
    if (
      render.status !== "SUCCEEDED" ||
      !render.inspection?.passed ||
      !render.outputAssetId ||
      !render.outputSha256
    ) {
      throw new DomainError("RENDER_NOT_APPROVABLE", "Only a QA-passing render can be saved.");
    }
    const product = await this.repository.getProduct(project.productId);
    const timestamp = this.now().toISOString();
    const finalApproval: Approval = {
      ...this.approval("FINAL", render.id, actor, timestamp),
      targetSha256: render.outputSha256
    };
    const saveApproval: Approval = {
      ...this.approval("READY_SAVE", render.id, actor, timestamp),
      targetSha256: render.outputSha256
    };
    const priorPublishedRenderId = project.currentRenderId;
    project = updateProject(
      project,
      {
        state: replacingPublished ? "READY" : "SAVING",
        approvals: [...project.approvals, finalApproval, saveApproval]
      },
      timestamp
    );
    await this.repository.saveProject(project);
    const asset = await this.storage.getAsset(render.outputAssetId);
    if (asset.sha256 !== render.outputSha256) {
      throw new DomainError("RENDER_CHECKSUM_MISMATCH", "The reviewed render no longer matches its approved checksum.");
    }
    const readyFile = await this.readyPublisher.publish({
      source: asset,
      productSlug: product.slug,
      projectPublicId: project.publicId,
      approvedSha256: render.outputSha256
    });
    const readyAt = this.now().toISOString();
    const publishedRenderIds = [...new Set([
      ...(project.publishedRenderIds ?? (priorPublishedRenderId ? [priorPublishedRenderId] : [])),
      render.id
    ])];
    project = updateProject(
      project,
      {
        state: "READY",
        readyFile,
        currentRenderId: render.id,
        candidateRenderId: undefined,
        ownerReviewRenderId: undefined,
        publishedRenderIds,
        auditEvents: appendAudit(
          project,
          this.audit(
            replacingPublished ? "PROJECT_PUBLISHED_VERSION_REPLACED" : "PROJECT_PUBLISHED_READY",
            "render",
            render.id,
            actor,
            { sha256: readyFile.sha256, path: readyFile.path, previousRenderId: priorPublishedRenderId },
            readyAt
          )
        )
      },
      readyAt
    );
    await this.repository.saveProject(project);
    return project;
  }
  async getProject(projectId: string): Promise<CreativeProject> {
    return this.repository.getProject(projectId);
  }

  /**
   * Revalidates retained provider output against the current deterministic
   * authority rules. The historical provider operation is intentionally read
   * only: its terminal state, findings, checksum, and timestamps remain audit
   * evidence of the validator decision made at that time.
   */
  async revalidateStoredConceptResult(projectId:string,operationKey:string,actor:string):Promise<CreativeProject>{
    let project=await this.repository.getProject(projectId);
    const existing=project.concepts.find((item)=>item.providerMetadata.revalidatedFromOperationKey===operationKey);
    if(existing)return project;
    assertState(project,["DRAFT","CONCEPT_REVIEW"],"Revalidate stored concept result");
    const snapshotRecord=project.creativeInputSnapshot;
    if(!snapshotRecord||creativeInputSnapshotSha256(snapshotRecord.input)!==snapshotRecord.sha256)throw new DomainError("CREATIVE_INPUT_SNAPSHOT_CHANGED","The immutable Creative Input Snapshot checksum no longer matches the handoff.");
    const operation=await this.repository.getConceptProviderOperation(operationKey);
    if(!operation||operation.projectId!==project.id)throw new DomainError("CONCEPT_OPERATION_NOT_FOUND","The retained Creative Concept provider operation is unavailable.");
    if(operation.state!=="REJECTED")throw new DomainError("CONCEPT_OPERATION_NOT_REJECTED","Only a historically rejected provider result can be revalidated through this workflow.");
    if(operation.snapshotId!==snapshotRecord.id||operation.snapshotSha256!==snapshotRecord.sha256)throw new DomainError("CREATIVE_INPUT_SNAPSHOT_CHANGED","The retained provider result belongs to a different immutable snapshot.");
    if(!operation.safeResult||operation.safeResult.truncated===true)throw new DomainError("CONCEPT_RESULT_UNAVAILABLE","The retained Creative Concept result is unavailable or truncated.");
    const draft=operation.safeResult as unknown as CreativeConceptProviderDraft;
    const resultSha256=conceptProviderResultSha256(draft);
    if(!operation.resultSha256||operation.resultSha256!==resultSha256)throw new DomainError("CONCEPT_RESULT_CHECKSUM_MISMATCH","The retained Creative Concept result checksum does not match its audit evidence.");
    const findings=[...validateConceptExecution(snapshotRecord.input,draft)];
    const strategy=snapshotRecord.input.selectedStrategy;
    if(strategy){
      const methods=new Set([strategy.primaryProductionMethod,...strategy.supportingProductionMethods]);
      const allowsProductImage=methods.has("PRODUCT_IMAGE_MOTION")||methods.has("PERSONALIZATION_DEMO")||methods.has("MOTION_GRAPHICS");
      if(!allowsProductImage&&draft.scenes.some((scene)=>scene.sourceType==="PRODUCT_IMAGE"))findings.push("PRODUCTION_METHOD_CHANGED: execution uses Product-image motion outside the selected Strategy methods.");
    }
    if(findings.length)throw new DomainError("CONCEPT_STRATEGY_MISMATCH",findings.join(" "));
    const generated=assembleCreativeConcept(snapshotRecord.input,draft);validateConcept(generated);
    const timestamp=this.now().toISOString();
    const revision=project.concepts.length+1;
    const conceptId=this.id();
    const requestId=operation.requestId??operation.providerTaskId??operationKey;
    const concept:CreativeConcept={id:conceptId,revision,source:"PROVIDER",status:"REVIEW",inputSnapshot:snapshotRecord.input,providerMetadata:{provider:operation.provider,model:operation.model,requestId:operation.requestId,providerTaskId:operation.providerTaskId,operationKey,schemaVersion:"creative-concept/v1",revalidatedFromOperationKey:operationKey,historicalOperationState:operation.state,resultSha256,...operation.usage},createdAt:timestamp,...generated};
    const hasUsage=project.usageCosts.some((item)=>item.operationType==="CONCEPT"&&item.requestId===requestId);
    project=updateProject(project,{state:"CONCEPT_REVIEW",concepts:[...project.concepts.map((item)=>item.status==="REVIEW"?{...item,status:"SUPERSEDED" as const}:item),concept],currentConceptId:conceptId,usageCosts:hasUsage?project.usageCosts:[...project.usageCosts,this.cost(operation.provider,operation.model,"CONCEPT",project.id,requestId,timestamp,operation.usage)],auditEvents:appendAudit(project,this.audit("CONCEPT_REVALIDATED_FROM_STORED_RESULT","creative_concept",conceptId,actor,{operationKey,historicalOperationState:operation.state,resultSha256},timestamp))},timestamp);
    await this.repository.saveProject(project);
    return project;
  }

  async getProjectWithConceptStatus(projectId:string):Promise<CreativeProject&Readonly<{executionFeasibility?:ReturnType<typeof buildExecutionFeasibilityPlan>;conceptGenerationStatus?:Readonly<{workflowStatus:WorkflowJob["status"];operationState?:string;providerStatus?:string;message?:string}>}>>{
    const project=await this.repository.getProject(projectId);
    const feasibility=project.creativeInputSnapshot?.input.selectedStrategy?buildExecutionFeasibilityPlan(project.creativeInputSnapshot.input):undefined;
    const jobs=(await this.repository.listJobs(projectId)).filter(job=>job.type==="GENERATE_CONCEPT").sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
    const workflow=jobs[0];
    if(!workflow)return {...project,...(feasibility?{executionFeasibility:feasibility}:{})};
    const operation=await this.repository.getConceptProviderOperation(workflow.dedupeKey);
    return {...project,...(feasibility?{executionFeasibility:feasibility}:{}),conceptGenerationStatus:{workflowStatus:workflow.status,...(operation?{operationState:operation.state,...(operation.latestProviderStatus?{providerStatus:operation.latestProviderStatus}:{}),...(operation.validationFindings.length?{validationFindings:[...operation.validationFindings]}:{}),...(operation.safeErrorMessage?{message:operation.safeErrorMessage}:workflow.lastError?{message:workflow.lastError}:{})}:workflow.lastError?{message:workflow.lastError}:{})}};
  }

  async listProjects(): Promise<readonly CreativeProject[]> {
    return this.repository.listProjects();
  }

  async listProducts(): Promise<readonly Product[]> {
    return this.repository.listProducts();
  }

  async getProduct(productId: string): Promise<Product> {
    return this.repository.getProduct(productId);
  }

  async updateProduct(
    productId: string,
    input: Readonly<{
      name: string;
      slug: string;
      description: string;
      claims: readonly ProductClaim[];
      defaultCta: string;
      creativeNotes?: string;
      assets: readonly ProductAsset[];
      personalizationVisualAuthority?: ProductPersonalizationVisualAuthority;
    }>
  ): Promise<Product> {
    const existing = await this.repository.getProduct(productId);
    const updated: Product = {
      ...existing,
      name: input.name.trim(),
      slug: input.slug,
      description: input.description.trim(),
      claims: [...input.claims],
      defaultCta: input.defaultCta.trim(),
      ...(input.creativeNotes ? { creativeNotes: input.creativeNotes.trim() } : {}),
      assets: [...input.assets],
      ...(input.personalizationVisualAuthority ? { personalizationVisualAuthority: input.personalizationVisualAuthority } : {}),
      updatedAt: this.now().toISOString()
    };
    await this.repository.saveProduct(updated);
    return updated;
  }

  async listJobs(projectId: string): Promise<readonly WorkflowJob[]> {
    return this.repository.listJobs(projectId);
  }

  private async processSceneJob(job: WorkflowJob): Promise<"DONE" | "WAITING"> {
    let project = await this.repository.getProject(job.projectId);
    const scene = project.scenes.find((item) =>
      item.attempts.some((attempt) => attempt.id === job.targetId)
    );
    const attempt = scene?.attempts.find((item) => item.id === job.targetId);
    if (!scene || !attempt) throw new DomainError("SCENE_ATTEMPT_NOT_FOUND", "Scene attempt missing.");
    if (attempt.status === "REVIEW" || attempt.status === "ACCEPTED") return "DONE";
    if (scene.attempts.at(-1)?.id !== attempt.id) return "DONE";
    const concept = currentConcept(project);
    const spec = concept.scenes.find((item) => item.sceneNumber === scene.sceneNumber);
    if (!spec) throw new DomainError("SCENE_SPEC_NOT_FOUND", "Approved scene specification missing.");
    // Manual/external attempts are completed only by the secure upload boundary.
    // A duplicate queue delivery must never turn a manual scene into an API submission.
    if (supportsManualExternalVideo(attempt.sourceType) && attemptGenerationMethod(attempt) === "MANUAL") return "DONE";
    const referenceId = spec.referenceAssetIds.find((assetId) => project.selectedProductAssetIds.includes(assetId));
    if (!isAiVideoSource(attempt.sourceType)) {
      const referenceAsset = referenceId ? await this.storage.getAsset(referenceId) : undefined;
      if (!referenceAsset) throw new DomainError("SCENE_SOURCE_ASSET_MISSING", "The selected non-generated scene source is unavailable.");
      let inspection;
      if (attempt.sourceType === "UPLOADED_VIDEO" || referenceAsset.kind === "VIDEO") {
        inspection = await this.mediaInspector.inspectVideo(referenceAsset, { expectedDurationMs: spec.intendedDurationMs, toleranceMs: 10_000 });
        if (!inspection.passed) throw new DomainError("SCENE_VIDEO_QA_FAILED", "The selected source video failed local media inspection.");
      }
      const completedAt = this.now().toISOString();
      project = this.replaceSceneAttempt(project, scene.id, attempt.id, {
        ...attempt, status: "REVIEW", inputAssetId: referenceAsset.id, outputAssetId: referenceAsset.id,
        ...(inspection ? { inspection } : {}), updatedAt: completedAt
      }, completedAt);
      const allGenerated = project.scenes.every((item) => item.attempts.some((candidate) => ["REVIEW", "ACCEPTED", "REJECTED"].includes(candidate.status)));
      project = updateProject(project, { state: allGenerated ? "SCENES_REVIEW" : project.state,
        auditEvents: appendAudit(project, this.audit("SCENE_SOURCE_SELECTED", "scene_attempt", attempt.id, "worker", { sceneId: scene.id, sourceType: attempt.sourceType, assetId: referenceAsset.id }, completedAt)) }, completedAt);
      await this.repository.saveProject(project);
      return "DONE";
    }
    const providerKey = legacyProviderKey(attempt.provider, attempt.sourceType)
      ?? scene.requestedVideoProvider
      ?? this.videoProviders.defaultProviderKey;
    const resolvedProvider = this.videoProviders.get(providerKey);
    const videoProvider = resolvedProvider.provider;
    const videoInputAssetId = attempt.inputAssetId ?? referenceId;
    const referenceAsset = videoInputAssetId && videoProvider.requiresExternalMedia
      ? await this.storage.getAsset(videoInputAssetId)
      : undefined;
    if (attempt.inputAssetId && videoProvider.requiresExternalMedia && (!referenceAsset || referenceAsset.kind !== "IMAGE" || referenceAsset.projectId !== project.id || referenceAsset.purpose !== "SCENE_CONTEXT_IMAGE" || referenceAsset.metadata.sceneId !== scene.id)) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_INVALID", "The selected scene context image is unavailable or no longer belongs to this scene.");
    }
    let activeAttempt = attempt;
    let providerTaskId = attempt.providerTaskId;
    let submission: ProviderSubmission | undefined;
    if (!providerTaskId) {
      const stagedReference = referenceAsset?.kind === "IMAGE"
        ? await this.externalMediaDelivery.stage({ projectId: project.id, operationId: attempt.operationKey, asset: referenceAsset, storage: this.storage })
        : undefined;
      try {
        submission = await videoProvider.submit(
          {
            sceneNumber: scene.sceneNumber,
            durationMs: spec.intendedDurationMs,
            prompt: attempt.prompt,
            sourceType: attempt.sourceType,
            ...(attempt.providerModel ? { model: attempt.providerModel } : {}),
            referenceAssetIds: videoInputAssetId ? [videoInputAssetId] : spec.referenceAssetIds,
            generationMode: stagedReference ? "IMAGE_TO_VIDEO" : "TEXT_TO_VIDEO",
            accuracyRequirements: spec.accuracyRequirements,
            ...(stagedReference && referenceAsset ? { referenceImage: { assetId: referenceAsset.id, sha256: referenceAsset.sha256, mimeType: referenceAsset.mimeType, reference: stagedReference } } : {})
          },
          { operationKey: attempt.operationKey, projectId: project.id, targetId: attempt.id }
        );
      } catch (error) {
        if (error instanceof DomainError && error.code.endsWith("_SUBMISSION_UNKNOWN")) {
          const unknownAt = this.now().toISOString();
          project = this.replaceSceneAttempt(project, scene.id, attempt.id, { ...attempt, status: "SUBMISSION_UNKNOWN", provider: resolvedProvider.key, failureMessage: error.message, updatedAt: unknownAt }, unknownAt);
          await this.repository.saveProject(project);
          return "DONE";
        }
        throw error;
      }
      providerTaskId = submission.providerTaskId;
      const submittedAt = this.now().toISOString();
      activeAttempt = {
        ...attempt,
        status: "SUBMITTED",
        providerTaskId,
        provider: submission.provider,
        providerModel: submission.model,
        providerRequestId: submission.requestId,
        providerMetadata: submission.metadata,
        updatedAt: submittedAt
      };
      project = this.replaceSceneAttempt(project, scene.id, attempt.id, activeAttempt, submittedAt);
      await this.repository.saveProject(project);
    }
    const status = await videoProvider.getStatus(providerTaskId);
    if (status.state === "PROCESSING") {
      if (activeAttempt.status !== "PROCESSING") {
        const processingAt = this.now().toISOString();
        project = this.replaceSceneAttempt(project, scene.id, attempt.id, { ...activeAttempt, status: "PROCESSING", providerTaskId, updatedAt: processingAt }, processingAt);
        await this.repository.saveProject(project);
      }
      return "WAITING";
    }
    if (status.state === "FAILED") {
      const failedAt = this.now().toISOString();
      project = this.replaceSceneAttempt(project, scene.id, attempt.id, { ...activeAttempt, status: "FAILED", providerTaskId, failureMessage: status.message, updatedAt: failedAt }, failedAt);
      await this.repository.saveProject(project);
      await this.externalMediaDelivery.cleanup(attempt.operationKey).catch(() => undefined);
      return "DONE";
    }
    const providerOutputMetadata = status.result.kind === "TRUSTED_REMOTE" ? status.result.metadata : status.result.payload.metadata;
    const payload = await this.videoOutputIngestor.ingest(status.result);
    const asset = await this.storage.put(
      `projects/${project.id}/scenes/${scene.id}/${attempt.attemptNumber}/scene.${payload.extension}`,
      { ...payload, metadata: { ...payload.metadata, projectId: project.id, purpose: "SCENE_VIDEO" } }
    );
    const inspection = await this.mediaInspector.inspectVideo(asset, { expectedDurationMs: spec.intendedDurationMs, toleranceMs: activeAttempt.provider === "fake" || activeAttempt.provider === "fake-kling" ? 20_000 : 3_000 });
    const completedAt = this.now().toISOString();
    if (!inspection.passed) {
      project = this.replaceSceneAttempt(project, scene.id, attempt.id, { ...activeAttempt, status: "FAILED", providerTaskId, outputAssetId: asset.id, inspection, failureMessage: "Generated scene failed local video QA.", updatedAt: completedAt }, completedAt);
      await this.repository.saveProject(project);
      await this.externalMediaDelivery.cleanup(attempt.operationKey).catch(() => undefined);
      return "DONE";
    }
    project = this.replaceSceneAttempt(project, scene.id, attempt.id, {
      ...activeAttempt,
      status: "REVIEW",
      providerTaskId,
      outputAssetId: asset.id,
      inspection,
      providerMetadata: { ...(activeAttempt.providerMetadata ?? {}), output: providerOutputMetadata },
      updatedAt: completedAt
    }, completedAt);
    const allGenerated = project.scenes.every((item) =>
      item.attempts.some((candidate) =>
        ["REVIEW", "ACCEPTED", "REJECTED"].includes(candidate.status)
      )
    );
    const provider = submission?.provider ?? activeAttempt.provider ?? "fake-or-reconciled-video";
    const model = submission?.model ?? activeAttempt.providerModel ?? "reconciled";
    const requestId = submission?.requestId ?? activeAttempt.providerRequestId ?? providerTaskId;
    project = updateProject(
      project,
      {
        state: allGenerated ? "SCENES_REVIEW" : project.state,
        usageCosts: [
          ...project.usageCosts,
          {
            ...this.cost(provider, model, "VIDEO", project.id, requestId, completedAt),
            sceneId: scene.id
          }
        ],
        auditEvents: appendAudit(
          project,
          this.audit(
            "SCENE_GENERATED",
            "scene_attempt",
            attempt.id,
            "worker",
            { sceneId: scene.id, providerTaskId },
            completedAt
          )
        )
      },
      completedAt
    );
    await this.repository.saveProject(project);
    await this.externalMediaDelivery.cleanup(attempt.operationKey).catch(() => undefined);
    return "DONE";
  }

  private async processVoiceJob(job: WorkflowJob): Promise<"DONE" | "WAITING"> {
    let project = await this.repository.getProject(job.projectId);
    const voice = project.voiceGenerations.find((item) => item.id === job.targetId);
    if (!voice) throw new DomainError("VOICE_GENERATION_NOT_FOUND", "Voice attempt missing.");
    if (voice.status === "REVIEW" || voice.status === "ACCEPTED") return "DONE";
    let providerTaskId = voice.providerTaskId;
    let submission: ProviderSubmission | undefined;
    if (!providerTaskId) {
      submission = await this.voiceProvider.submit(
        { voiceProfileId: voice.voiceProfileId, script: voice.sourceScript, ...(voice.deliveryInstructions ? { instructions: voice.deliveryInstructions } : {}) },
        { operationKey: voice.operationKey, projectId: project.id, targetId: voice.id }
      );
      const submittedTaskId = submission!.providerTaskId;
      providerTaskId = submittedTaskId;
      const submittedAt = this.now().toISOString();
      project = updateProject(
        project,
        {
          voiceGenerations: project.voiceGenerations.map((item) =>
            item.id === voice.id
              ? {
                  ...item,
                  status: "SUBMITTED" as const,
                  providerTaskId: submittedTaskId,
                  updatedAt: submittedAt
                }
              : item
          )
        },
        submittedAt
      );
      await this.repository.saveProject(project);
    }
    const status = await this.voiceProvider.getStatus(providerTaskId);
    if (status.state === "PROCESSING") return "WAITING";
    if (status.state === "FAILED") throw new DomainError("VOICE_PROVIDER_FAILED", status.message);
    const asset = await this.storage.put(
      `projects/${project.id}/audio/${voice.attemptNumber}/narration.${status.result.extension}`,
      { ...status.result, metadata: { ...status.result.metadata, projectId: project.id, purpose: "VOICE" } }
    );
    const audioInspection = await this.mediaInspector.inspectAudio(asset, { maxDurationMs: 120_000 });
    if (!audioInspection.passed) throw new DomainError("VOICE_AUDIO_QA_FAILED", "Generated narration failed audio quality validation.");
    const completedAt = this.now().toISOString();
    const retainCurrentAcceptedVoice = project.candidateVoiceGenerationId === voice.id && hasAcceptedCurrentVoice(project);
    project = updateProject(
      project,
      {
        state: project.state === "READY" ? "READY" : "VOICE_REVIEW",
        voiceGenerations: project.voiceGenerations.map((item) =>
          item.id === voice.id
            ? {
                ...item,
                status: "REVIEW" as const,
                providerTaskId,
                outputAssetId: asset.id,
                ...(submission?.provider ? { provider: submission.provider } : {}),
                ...(submission?.model ? { providerModel: submission.model } : {}),
                inspection: audioInspection,
                updatedAt: completedAt
              }
            : item
        ),
        ...(retainCurrentAcceptedVoice ? {} : { currentVoiceGenerationId: voice.id }),
        usageCosts: [
          ...project.usageCosts,
          this.cost(
            submission?.provider ?? "fake-or-reconciled-voice",
            submission?.model ?? "reconciled",
            "VOICE",
            project.id,
            submission?.requestId ?? providerTaskId,
            completedAt
          )
        ],
        auditEvents: appendAudit(
          project,
          this.audit(
            "VOICE_GENERATED_REVIEW_READY",
            "voice_generation",
            voice.id,
            "worker",
            { assetId: asset.id },
            completedAt
          )
        )
      },
      completedAt
    );
    await this.repository.saveProject(project);
    return "DONE";
  }

  private async processRenderJob(job: WorkflowJob): Promise<"DONE" | "WAITING"> {
    let project = await this.repository.getProject(job.projectId);
    const render = project.renders.find((item) => item.id === job.targetId);
    if (!render) throw new DomainError("RENDER_NOT_FOUND", "Render attempt missing.");
    if (render.status === "SUCCEEDED") return "DONE";
    const snapshot = render.inputSnapshot;
    const composition = this.compositionProviders.get(render.requestedProvider ?? render.provider);
    const sceneAssets = await Promise.all(snapshot.sceneInputs.map((input) => this.storage.getAsset(input.assetId)));
    const narrationAsset = await this.storage.getAsset(snapshot.narration.assetId);
    const musicAsset = snapshot.music ? await this.storage.getAsset(snapshot.music.assetId) : undefined;
    const logoAsset = snapshot.logo ? await this.storage.getAsset(snapshot.logo.assetId) : undefined;
    let providerTaskId = render.providerTaskId;
    let submission: ProviderSubmission | undefined;
    if (!providerTaskId) {
      const internalReference = (asset: GeneratedAsset) => ({ url: `internal-asset://${asset.id}`, expiresAt: "9999-12-31T23:59:59.999Z", contentType: asset.mimeType, size: asset.byteSize });
      const sceneReferences = await Promise.all(sceneAssets.map(async (asset) => ({
        assetId: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        reference: composition.provider.requiresExternalMedia === false ? internalReference(asset) : await this.externalMediaDelivery.stage({
          projectId: project.id,
          operationId: render.operationKey,
          asset,
          storage: this.storage
        })
      })));
      const narrationReference = {
        assetId: narrationAsset.id,
        sha256: narrationAsset.sha256,
        mimeType: narrationAsset.mimeType,
        reference: composition.provider.requiresExternalMedia === false ? internalReference(narrationAsset) : await this.externalMediaDelivery.stage({
          projectId: project.id,
          operationId: render.operationKey,
          asset: narrationAsset,
          storage: this.storage
        })
      };
      const optionalReference = async (asset: GeneratedAsset | undefined) => asset ? {
        assetId: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        reference: composition.provider.requiresExternalMedia === false ? internalReference(asset) : await this.externalMediaDelivery.stage({ projectId: project.id, operationId: render.operationKey, asset, storage: this.storage })
      } : undefined;
      const musicReference = await optionalReference(musicAsset);
      const logoReference = await optionalReference(logoAsset);
      try {
      submission = await composition.provider.submit(
        {
          snapshot,
          sceneAssets: sceneReferences,
          narration: narrationReference,
          captionTimings: snapshot.narration.captionTimings,
          ...(musicReference ? { music: musicReference } : {}),
          ...(logoReference ? { logo: logoReference } : {}),
          marketingOverlays: snapshot.marketingOverlays,
          cta: snapshot.cta,
          compositionStyleKey: render.compositionStyleKey,
          target: snapshot.target
        },
        { operationKey: render.operationKey, projectId: project.id, targetId: render.id }
      );
      } catch (error) {
        if (error instanceof DomainError && error.code === "CREATOMATE_UNAVAILABLE") {
          const unknownAt = this.now().toISOString();
          project = updateProject(project, {
            state: "FAILED",
            renders: project.renders.map((item) => item.id === render.id ? { ...item, status: "SUBMISSION_UNKNOWN" as const, failureMessage: error.message, updatedAt: unknownAt } : item),
            auditEvents: appendAudit(project, this.audit("RENDER_SUBMISSION_UNKNOWN", "render", render.id, "worker", { operationKey: render.operationKey }, unknownAt))
          }, unknownAt);
          await this.repository.saveProject(project);
          return "DONE";
        }
        throw error;
      }
      const submittedTaskId = submission.providerTaskId;
      providerTaskId = submittedTaskId;
      const submittedAt = this.now().toISOString();
      project = updateProject(
        project,
        {
          renders: project.renders.map((item) =>
            item.id === render.id
              ? {
                  ...item,
                  status: "SUBMITTED" as const,
                  provider: submission!.provider,
                  providerModel: submission!.model,
                  providerRequestId: submission!.requestId,
                  providerTaskId: submittedTaskId,
                  providerMetadata: submission!.metadata,
                  updatedAt: submittedAt
                }
              : item
          )
        },
        submittedAt
      );
      await this.repository.saveProject(project);
    }
    const status = await composition.provider.getStatus(providerTaskId);
    if (status.state === "PROCESSING") {
      if (render.status !== "PROCESSING") {
        const processingAt = this.now().toISOString();
        project = updateProject(project, {
          renders: project.renders.map((item) => item.id === render.id
            ? { ...item, status: "PROCESSING" as const, providerTaskId, updatedAt: processingAt }
            : item)
        }, processingAt);
        await this.repository.saveProject(project);
      }
      return "WAITING";
    }
    if (status.state === "FAILED") {
      await this.externalMediaDelivery.cleanup(render.operationKey);
      const failedAt = this.now().toISOString();
      project = updateProject(project, {
        state: project.state === "READY" && project.candidateRenderId === render.id ? "READY" : "FAILED",
        renders: project.renders.map((item) => item.id === render.id
          ? { ...item, status: "FAILED" as const, providerTaskId, updatedAt: failedAt }
          : item),
        auditEvents: appendAudit(project, this.audit("RENDER_PROVIDER_FAILED", "render", render.id, "worker", { providerTaskId, message: status.message }, failedAt))
      }, failedAt);
      await this.repository.saveProject(project);
      throw new DomainError("COMPOSITION_PROVIDER_FAILED", status.message);
    }
    let asset: GeneratedAsset;
    let resultMetadata: Readonly<Record<string, unknown>>;
    if (status.result.kind === "INTERNAL_ASSET") {
      asset = status.result.asset;
      resultMetadata = status.result.metadata;
    } else {
      const outputIngestor = this.compositionOutputIngestors.get(composition.key) ?? this.compositionOutputIngestor;
      const ingestedPayload = await outputIngestor.ingest(status.result);
      resultMetadata = status.result.kind === "INLINE" ? status.result.payload.metadata : {};
      asset = await this.storage.put(
        `projects/${project.id}/renders/${render.attemptNumber}/final.${ingestedPayload.extension}`,
        { ...ingestedPayload, metadata: { ...ingestedPayload.metadata, projectId: project.id, purpose: "FINAL_RENDER" } }
      );
    }
    const inspection = await this.mediaInspector.inspect(asset, {
      width: 1080,
      height: 1920,
      durationMs: snapshot.target.durationMs,
      requireAudio: true
    });
    const completedAt = this.now().toISOString();
    project = updateProject(
      project,
      {
        state: project.state === "READY" && project.candidateRenderId === render.id ? "READY" : inspection.passed ? "FINAL_REVIEW" : "FAILED",
        renders: project.renders.map((item) =>
          item.id === render.id
            ? {
                ...item,
                status: inspection.passed ? ("SUCCEEDED" as const) : ("QA_FAILED" as const),
                providerTaskId,
                outputAssetId: asset.id,
                outputSha256: asset.sha256,
                inspection,
                providerMetadata: { ...item.providerMetadata, ...resultMetadata },
                updatedAt: completedAt
              }
            : item
        ),
        usageCosts: [
          ...project.usageCosts,
          this.cost(
            submission?.provider ?? "fake-or-reconciled-composition",
            submission?.model ?? "reconciled",
            "COMPOSITION",
            project.id,
            submission?.requestId ?? providerTaskId,
            completedAt
          )
        ],
        auditEvents: appendAudit(
          project,
          this.audit(
            inspection.passed ? "RENDER_QA_PASSED" : "RENDER_QA_FAILED",
            "render",
            render.id,
            "worker",
            { sha256: asset.sha256, rules: inspection.rules },
            completedAt
          )
        )
      },
      completedAt
    );
    await this.repository.saveProject(project);
    await this.externalMediaDelivery.cleanup(render.operationKey);
    return "DONE";
  }

  private createNarrationRevision(
    project: CreativeProject,
    script: string,
    source: NarrationRevision["source"],
    timestamp: string,
    parentRevisionId?: string,
    provider?: Pick<NarrationRevision, "provider" | "providerModel" | "providerRequestId" | "providerMetadata">
  ): NarrationRevision {
    return {
      id: this.id(), revision: narrationRevisions(project).length + 1, script: script.trim(), source,
      estimatedDurationMs: estimateNarrationDurationMs(script),
      ...(parentRevisionId ? { parentRevisionId } : {}), ...(provider ?? {}), createdAt: timestamp
    };
  }

  private async buildRenderInputSnapshot(
    project: CreativeProject,
    voice: VoiceGeneration,
    concept: CreativeConcept
  ): Promise<RenderInputSnapshot> {
    if (!voice.outputAssetId) throw new DomainError("VOICE_ASSET_MISSING", "Narration asset missing.");
    const narrationAsset = await this.storage.getAsset(voice.outputAssetId);
    const sceneInputs = await Promise.all(project.scenes.map(async (scene) => {
      const attemptId = scene.approvedAttemptId;
      const attempt = attemptId ? scene.attempts.find((candidate) => candidate.id === attemptId) : undefined;
      if (!attempt?.outputAssetId) throw new DomainError("SCENES_NOT_APPROVED", "All scenes must be approved before rendering.");
      const asset = await this.storage.getAsset(attempt.outputAssetId);
      const spec = concept.scenes.find((candidate) => candidate.sceneNumber === scene.sceneNumber);
      if (!spec) throw new DomainError("SCENE_SPEC_NOT_FOUND", "Approved scene specification missing.");
      return { attemptId: attempt.id, assetId: asset.id, sha256: asset.sha256, intendedDurationMs: spec.intendedDurationMs, ...(attempt.inspection?.durationMs ? { sourceDurationMs: attempt.inspection.durationMs } : {}) };
    }));
    const timings = Array.isArray(narrationAsset.metadata.captionTimings)
      ? narrationAsset.metadata.captionTimings
          .filter((value): value is { text: unknown; startMs: unknown; endMs: unknown } => Boolean(value) && typeof value === "object")
          .map((value) => ({ text: String(value.text), startMs: Number(value.startMs), endMs: Number(value.endMs) }))
          .filter((value) => value.text && Number.isFinite(value.startMs) && Number.isFinite(value.endMs) && value.endMs >= value.startMs)
      : [];
    return {
      // The provider-owned template version is immutable even if the concept style label changes later.
      templateVersion: "koolezt-ugc-fast/v1",
      sceneInputs,
      narration: { voiceGenerationId: voice.id, assetId: narrationAsset.id, sha256: narrationAsset.sha256, captionTimings: timings, ...(voice.inspection?.durationMs ? { durationMs: voice.inspection.durationMs } : {}) },
      timeline: { transition: DEFAULT_SCENE_TRANSITION, transitionDurationMs: DEFAULT_SCENE_TRANSITION_DURATION_MS, narrationLeadInMs: assessVoiceTiming(concept.targetDurationMs, voice.inspection?.durationMs).leadInMs },
      marketingOverlays: concept.scenes.map((scene) => scene.overlayText),
      cta: concept.cta,
      target: { width: 1080, height: 1920, durationMs: concept.targetDurationMs }
    };
  }

  private replaceSceneAttempt(
    project: CreativeProject,
    sceneId: string,
    attemptId: string,
    replacement: SceneAttempt,
    timestamp: string
  ): CreativeProject {
    return updateProject(
      project,
      {
        ...(replacement.status === "FAILED" || replacement.status === "SUBMISSION_UNKNOWN" ? { state: "SCENES_REVIEW" as const } : {}),
        scenes: project.scenes.map((scene) =>
          scene.id === sceneId
            ? {
                ...scene,
                status: replacement.status === "REVIEW" ? ("REVIEW" as const)
                  : replacement.status === "FAILED" || replacement.status === "SUBMISSION_UNKNOWN" ? ("FAILED" as const)
                  : ("GENERATING" as const),
                attempts: scene.attempts.map((attempt) =>
                  attempt.id === attemptId ? replacement : attempt
                )
              }
            : scene
        )
      },
      timestamp
    );
  }

  private async enqueue(
    type: WorkflowJobType,
    projectId: string,
    targetId: string,
    dedupeKey: string,
    timestamp: string
  ): Promise<WorkflowJob> {
    return this.repository.enqueueJob({
      id: this.id(),
      dedupeKey,
      type,
      projectId,
      targetId,
      status: "PENDING",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  private approval(
    stage: Approval["stage"],
    targetId: string,
    actor: string,
    timestamp: string
  ): Approval {
    return {
      id: this.id(),
      stage,
      targetId,
      decision: "APPROVED",
      actor,
      createdAt: timestamp
    };
  }

  private audit(
    type: string,
    entityType: string,
    entityId: string,
    actor: string,
    details: Readonly<Record<string, unknown>>,
    timestamp: string
  ): AuditEvent {
    return {
      id: this.id(),
      type,
      entityType,
      entityId,
      actor,
      details,
      createdAt: timestamp
    };
  }

  private cost(
    provider: string,
    model: string,
    operationType: UsageCost["operationType"],
    projectId: string,
    requestId: string,
    timestamp: string,
    metadata: Readonly<Record<string, unknown>> = {}
  ): UsageCost {
    return {
      id: this.id(),
      provider,
      model,
      operationType,
      projectId,
      requestId,
      status: "UNAVAILABLE",
      currency: "USD",
      ...(typeof metadata.inputTokens === "number" ? { inputTokens: metadata.inputTokens } : {}),
      ...(typeof metadata.outputTokens === "number" ? { outputTokens: metadata.outputTokens } : {}),
      createdAt: timestamp
    };
  }
}
