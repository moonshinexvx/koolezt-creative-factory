export type ProjectState =
  | "DRAFT"
  | "CONCEPT_GENERATING"
  | "CONCEPT_REVIEW"
  | "CONCEPT_APPROVED"
  | "SCENES_GENERATING"
  | "SCENES_REVIEW"
  | "SCENES_APPROVED"
  | "VOICE_REVIEW"
  | "VOICE_GENERATING"
  | "READY_FOR_RENDER"
  | "COMPOSITION_PENDING"
  | "RENDERING"
  | "FINAL_REVIEW"
  | "OWNER_REVIEW"
  | "SAVING"
  | "READY"
  | "FAILED";

export type ProductClaimKind = "FEATURE" | "SELLING_POINT" | "RESTRICTION";
export type ProductAssetKind = "IMAGE" | "VIDEO";
export type SceneSourceType =
/** Creative/reference semantics: PRODUCT_IMAGE requires exact supplied artwork, while AI_VIDEO may not. This does not select an attempt-generation method. */
  | "AI_VIDEO"
  /** Legacy concept value. New concepts use AI_VIDEO and select a provider separately. */
  | "KLING_VIDEO"
  | "UPLOADED_VIDEO"
  | "PRODUCT_IMAGE"
  | "EXISTING_ASSET";

export type ProductClaim = Readonly<{
  kind: ProductClaimKind;
  text: string;
}>;

export type ProductAsset = Readonly<{
  id: string;
  kind: ProductAssetKind;
  label: string;
  storageKey: string;
  mimeType: string;
}>;

export type ProductPersonalizationVisualAuthority = Readonly<{
  /** Only an explicit operator confirmation makes these visual permissions authoritative. */
  status: "OPERATOR_CONFIRMED";
  immutableStructure: readonly string[];
  authorizedPersonalizationFields: readonly string[];
  /** Product configurations that may be shown when independently supported by verified Product truth. */
  authorizedProductConfigurations?: readonly string[];
}>;

export type Product = Readonly<{
  id: string;
  name: string;
  slug: string;
  active: boolean;
  description: string;
  claims: readonly ProductClaim[];
  defaultCta: string;
  personalizationVisualAuthority?: ProductPersonalizationVisualAuthority;
  creativeNotes?: string;
  assets: readonly ProductAsset[];
  createdAt: string;
  updatedAt: string;
}>;

export type ConceptSceneDraft = Readonly<{
  sceneNumber: number;
  intendedDurationMs: number;
  purpose: string;
  sourceType: SceneSourceType;
  generationPrompt: string;
  overlayText: string;
  referenceAssetIds: readonly string[];
  accuracyRequirements: readonly string[];
}>;

export type SceneContextImagePromptInput = Readonly<{
  productName: string;
  purpose: string;
  generationPrompt: string;
  accuracyRequirements: readonly string[];
}>;

/** Compiles a reviewed still-image brief while keeping the canonical Product asset authoritative. */
export function buildSceneContextImagePrompt(input: SceneContextImagePromptInput): string {
  const accuracy = input.accuracyRequirements.map((item) => item.trim()).filter(Boolean);
  return [
    "Create one production-ready 9:16 BACKGROUND PLATE for later deterministic Product compositing.",
    `The authoritative finished ${input.productName.trim() || "Product"} will be placed by the operator after this image is generated.`,
    "DO NOT draw, recreate, reinterpret, personalize, mount, or include the Product. Leave a clear, realistically lit placement area appropriate to the scene.",
    "Use the scene plan only to determine environment, framing, lighting, depth, and camera viewpoint. Ignore every instruction to change Product artwork, numbers, wording, geometry, layout, mounting, or personalization.",
    `Scene objective for environment only: ${input.purpose.trim()}`,
    `Scene plan for environment only: ${input.generationPrompt.trim()}`,
    ...(accuracy.length > 0 ? [`Lower-priority scene constraints: ${accuracy.join("; ")}. None may override the instruction to omit the Product.`] : []),
    "Return only the clean background plate. Do not add Product imagery, captions, CTA typography, prices, discounts, fake website UI, packaging, watermarks, or logos; the authoritative Product and deterministic overlays are added later."
  ].join("\n");
}

/**
 * Execution-only scene returned by a Creative Concept provider. Strategy-linked
 * generation uses application-defined reference roles; legacy direct Video
 * Maker may continue returning explicit asset IDs until canonical assembly.
 */
export type CreativeConceptProviderSceneDraft = Readonly<{
  sceneNumber: number;
  intendedDurationMs: number;
  purpose: string;
  sourceType: SceneSourceType;
  generationPrompt: string;
  overlayText: string;
  referenceRoles?: readonly string[];
  referenceAssetIds?: readonly string[];
  accuracyRequirements: readonly string[];
}>;

/** Execution-only evidence that a completed personalized Product variant is visibly shown. */
export type CompletedPersonalizedVariantExample = Readonly<{
  sceneNumber: number;
  label: string;
  finishedProductVisible: boolean;
  personalizationValues: readonly Readonly<{
    field: string;
    value: string;
  }>[];
  productStructurePreserved: boolean;
}>;

export type CreativeConceptDraft = Readonly<{
  angle: string;
  hook: string;
  /** Provider-authored explanation of how immutable Strategy authority is executed. */
  strategyExecutionSummary?: string;
  completedPersonalizedVariantCount?: number;
  completedVariantExamples?: readonly CompletedPersonalizedVariantExample[];
  targetDurationMs: number;
  voiceScript: string;
  cta: string;
  editingStyleKey: string;
  musicCategory: string;
  scenes: readonly ConceptSceneDraft[];
}>;

/**
 * Creative judgment returned by the provider. For Strategy-linked projects the
 * canonical angle, hook and CTA are intentionally absent and are injected by
 * the application from the immutable CreativeInputSnapshot. Legacy direct
 * Video Maker projects still require those three provider fields.
 */
export type CreativeConceptProviderDraft = Readonly<{
  angle?: string;
  hook?: string;
  cta?: string;
  strategyExecutionSummary?: string;
  completedPersonalizedVariantCount?: number;
  completedVariantExamples?: readonly CompletedPersonalizedVariantExample[];
  targetDurationMs: number;
  voiceScript: string;
  editingStyleKey: string;
  musicCategory: string;
  scenes: readonly CreativeConceptProviderSceneDraft[];
}>;

export type ConceptProviderOperationEvidence = Readonly<{
  operationKey: string;
  projectId: string;
  state: "PENDING" | "SUBMITTING" | "POLLING" | "SUCCEEDED" | "REJECTED" | "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE";
  provider: string;
  model: string;
  requestId?: string | undefined;
  providerTaskId?: string | undefined;
  snapshotId?: string | undefined;
  snapshotSha256?: string | undefined;
  submittedAt?: string | undefined;
  latestProviderStatus?: StrategyProviderResponseStatus | undefined;
  latestPollAt?: string | undefined;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  usage: Readonly<Record<string, unknown>>;
  resultSha256?: string | undefined;
  safeResult?: Readonly<Record<string, unknown>> | undefined;
  validationFindings: readonly string[];
  rejectionCode?: string | undefined;
  safeErrorMessage?: string | undefined;
}>;

export type CreativeInputSnapshot = Readonly<{
  productName: string;
  description: string;
  claims: readonly ProductClaim[];
  defaultCta: string;
  creativeNotes?: string;
  selectedAssets: readonly Pick<ProductAsset, "id" | "kind" | "label" | "mimeType">[];
  additionalInstructions: string;
  creativeTopic?: string;
  targetDurationMs?: number;
  /** Capabilities available when the handoff was created. Historical Winner DNA cannot expand this list. */
  productionCapabilities?: readonly StrategyAssetCapability[];
  /** Immutable strategy execution contract. Present only for strategy-linked Video Maker projects. */
  selectedStrategy?: SelectedStrategySnapshot;
  /** Product-specific visual mutability authority captured at handoff time. */
  personalizationVisualAuthority?: ProductPersonalizationVisualAuthority;
  /** Optional immutable execution guidance. It cannot override Strategy, Product truth, or visual references. */
  selectedWinnerDna?: SelectedWinnerDnaSnapshot;
}>;

export type ExecutionFeasibilityResolution =
  | "REQUIRED_AND_SUPPORTED"
  | "PREFERRED_AND_SUPPORTED"
  | "ADAPTED_DUE_TO_HIGHER_AUTHORITY"
  | "UNSUPPORTED_REQUIRED"
  | "NOT_APPLICABLE";
export type ExecutionFeasibilityAuthority =
  | "STRATEGY"
  | "PRODUCT_TRUTH"
  | "VISUAL_PRODUCT_AUTHORITY"
  | "WINNER_DNA"
  | "PRODUCTION_CAPABILITIES";
export type ExecutionFeasibilityRequirement = Readonly<{
  code: string;
  sourceAuthority: ExecutionFeasibilityAuthority;
  requirement: string;
  resolution: ExecutionFeasibilityResolution;
  support: readonly string[];
  capabilityOrAssetIds: readonly string[];
  reason: string;
}>;
export type ExecutionFeasibilityPlan = Readonly<{
  version: 1;
  status: "SUPPORTED" | "BLOCKED";
  requirements: readonly ExecutionFeasibilityRequirement[];
  required: readonly string[];
  preserve: readonly string[];
  mayVary: readonly string[];
  forbidden: readonly string[];
}>;

export type CreativeHandoffInputSnapshot = Readonly<{
  id: string;
  input: CreativeInputSnapshot;

  sha256: string;
  createdAt: string;
}>;

export type CreativeReferenceOperatorStatus = "WINNER" | "CONTROL" | "REFERENCE" | "LOSER";
export type CreativeDnaStatus = "NOT_ANALYZED" | "ANALYZING" | "DRAFT" | "APPROVED" | "ARCHIVED" | "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE";
export type CreativeDnaEvidenceKind = "VISUAL_FRAME" | "MEDIA_METADATA" | "VISIBLE_TEXT" | "OPERATOR_TRANSCRIPT" | "OPERATOR_NOTE" | "AUDIO_TRANSCRIPT" | "SCENE_CUT";
export type CreativeDnaEvidence = Readonly<{ kind: CreativeDnaEvidenceKind; observation: string; timestampMs?: number; endTimestampMs?: number; frameSha256?: string }>;
export type CreativeDnaMediaMetadata = Readonly<{ durationMs: number; width: number; height: number; frameRate?: number; hasAudio: boolean; mimeType: string }>;
export type CreativePerformanceContext = Readonly<{ spend?: number; purchases?: number; purchaseCpa?: number; revenue?: number; roas?: number; linkCtr?: number; cpc?: number; cpm?: number; currency?: string; dateStart?: string; dateEnd?: string; metricSource?: string;
  impressions?: number; linkClicks?: number; threeSecondViews?: number; thruPlays?: number; hookRate?: number; holdRate?: number; videoCompletion?: Readonly<{ p25?: number; p50?: number; p75?: number; p100?: number }> }>;
/** Normalized ad-level results from the Meta Marketing API. Rates are fractions (0.25 = 25%). */
export type MetaAdMetrics = Readonly<{
  spend: number; impressions: number; linkClicks: number; purchases: number; purchaseValue: number;
  threeSecondViews?: number; thruPlays?: number; videoP25?: number; videoP50?: number; videoP75?: number; videoP100?: number;
  linkCtr?: number; cpc?: number; cpm?: number; cpa?: number; roas?: number; hookRate?: number; holdRate?: number;
}>;
export type MetaAdAccount = Readonly<{ id: string; name: string; currency?: string }>;
export type MetaAdSummary = Readonly<{ accountId: string; adId: string; adName: string; campaignName?: string; adsetName?: string; currency?: string; dateStart: string; dateEnd: string; metrics: MetaAdMetrics }>;
export type MetaAdCreative = Readonly<{ adId: string; adName: string; creativeId?: string; videoId?: string; thumbnailUrl?: string }>;
/** Read-only Meta Marketing API access; it never creates or edits ads. */
export interface MetaAdsGateway {
  readonly accountIds: readonly string[];
  listAccounts(): Promise<readonly MetaAdAccount[]>;
  topAds(accountId: string, since: string, until: string): Promise<readonly MetaAdSummary[]>;
  adCreative(adId: string): Promise<MetaAdCreative>;
  /** A temporary download URL for the ad's video, or undefined when the token cannot read it. */
  videoSourceUrl(videoId: string): Promise<string | undefined>;
  lifetimeResults(accountId: string, adId: string): Promise<MetaAdSummary | undefined>;
}
export type CreativeMetaLink = Readonly<{
  creativeReferenceId: string; accountId: string; adId: string; adName: string; creativeId?: string; videoId?: string; thumbnailUrl?: string;
  currency?: string; metrics?: MetaAdMetrics; dateStart?: string; dateEnd?: string; syncedAt?: string; syncError?: string; createdAt: string; updatedAt: string;
}>;
export type CreativeReference = Readonly<{
  id: string; displayName: string; sourceProjectId?: string; productId?: string; sourceAssetId: string; operatorStatus: CreativeReferenceOperatorStatus;
  operatorNotes?: string; operatorTranscript?: string; dateStart?: string; dateEnd?: string; platform?: string;
  performance?: CreativePerformanceContext; analysisStatus: CreativeDnaStatus; approvedRevisionId?: string; createdBy: string; createdAt: string; updatedAt: string;
}>;
export type CreativeDnaDraft = Readonly<{
  openingPattern: string; openingProductVisible: boolean; approximateProductRevealMs?: number; visualHookMechanism: string;
  productProminence: string; personalizationVisibility: string; repeatedExamplePattern: string; approximateExampleCount?: number;
  pacingPattern: string; beatStructure: string; overlayTextPattern: string; offerVisibilityPattern: string; ctaPattern: string;
  proofPattern: string; visualFormat: string; lifestyleVsProductBalance: string; soundOffComprehension: string;
  directResponsePattern: string; closingPattern: string; preserveTraits: readonly string[]; safeToVaryTraits: readonly string[];
  avoidTraits: readonly string[]; sourceEvidence: readonly CreativeDnaEvidence[];
}>;
export type CreativeDnaRevision = CreativeDnaDraft & Readonly<{
  id: string; creativeReferenceId: string; revision: number; status: "DRAFT" | "APPROVED" | "ARCHIVED";
  source: "AI_PROVIDER" | "OPENAI" | "OPERATOR_EDIT"; mediaMetadata: CreativeDnaMediaMetadata; operatorNotes?: string;
  providerMetadata: Readonly<Record<string, unknown>>; createdBy: string; createdAt: string;
}>;
export type SelectedWinnerDnaSnapshot = Omit<CreativeDnaRevision, "providerMetadata"> & Readonly<{ revisionSha256: string; referenceDisplayName: string }>;
export type CreativeDnaFrame = Readonly<{ timestampMs: number; mimeType: "image/jpeg"; bytesBase64: string; sha256: string }>;
/** Application-measured shot boundaries; scene cuts are detected by FFmpeg, not inferred by the model. */
export type CreativeDnaPacing = Readonly<{ sceneCutsMs: readonly number[]; shotCount: number; averageShotMs: number; firstCutMs?: number; detectionThreshold: number }>;
export type CreativeDnaTranscriptSegment = Readonly<{ startMs: number; endMs: number; text: string }>;
export type CreativeDnaTranscription = Readonly<{ provider: string; model: string; language?: string; text: string; segments: readonly CreativeDnaTranscriptSegment[] }>;
/** Machine transcript of the historical ad's audio track. An operator transcript, when supplied, takes precedence. */
export type CreativeDnaAudioTranscript =
  | (CreativeDnaTranscription & Readonly<{ status: "TRANSCRIBED" }>)
  | Readonly<{ status: "NO_AUDIO" | "DISABLED" | "FAILED"; reason?: string }>;
/** FFmpeg loudness and silence measurement of the whole audio track. */
export type CreativeDnaAudioLevels = Readonly<{ integratedLufs?: number; audioPresentRatio: number }>;
export type CreativeDnaPreprocessed = Readonly<{ mediaMetadata: CreativeDnaMediaMetadata; frames: readonly CreativeDnaFrame[]; pacing?: CreativeDnaPacing; audioTranscript?: CreativeDnaAudioTranscript; audioLevels?: CreativeDnaAudioLevels }>;

export const WINNER_HOOK_TYPES = ["PATTERN_INTERRUPT", "PRODUCT_REVEAL", "PROBLEM_CALLOUT", "QUESTION", "DEMONSTRATION", "SOCIAL_PROOF", "OFFER", "STORY", "CURIOSITY", "IDENTITY", "OTHER"] as const;
export const WINNER_AWARENESS_LEVELS = ["UNAWARE", "PROBLEM_AWARE", "SOLUTION_AWARE", "PRODUCT_AWARE", "MOST_AWARE"] as const;
export const WINNER_BEATS = ["HOOK", "PROBLEM", "PRODUCT_REVEAL", "DEMONSTRATION", "PERSONALIZATION", "PROOF", "OFFER", "CTA", "OTHER"] as const;
export const WINNER_TEST_TYPES = ["HOOK", "ANGLE", "FORMAT", "OFFER_FRAMING", "VISUAL", "CTA"] as const;
export const WINNER_EVIDENCE_SOURCES = ["FRAME", "TRANSCRIPT", "SCENE_CUT", "ON_SCREEN_TEXT", "PERFORMANCE", "OPERATOR_NOTE"] as const;
export const WINNER_CLAIM_STATUSES = ["MATCHES_CURRENT_PRODUCT", "NOT_IN_CURRENT_PRODUCT", "HISTORICAL_OFFER"] as const;
export type WinnerConfidence = "HIGH" | "MEDIUM" | "LOW";
export type WinnerEvidence = Readonly<{ source: (typeof WINNER_EVIDENCE_SOURCES)[number]; detail: string; timestampMs?: number; endTimestampMs?: number }>;
/** Human-facing explanation of a historical winner. Reasons are evidence-backed hypotheses, not proven causes. */
export type WinnerReport = Readonly<{
  verdict: Readonly<{ summary: string; reasons: readonly Readonly<{ title: string; explanation: string; confidence: WinnerConfidence; evidence: readonly WinnerEvidence[] }>[] }>;
  hook: Readonly<{ visualHook: string; textHook: string; spokenHook: string; hookType: (typeof WINNER_HOOK_TYPES)[number]; productFirstVisibleMs?: number; whyItStops: string; strength: "STRONG" | "AVERAGE" | "WEAK" }>;
  angle: Readonly<{ coreAngle: string; buyerMotivation: string; desireOrProblem: string; emotionalTriggers: readonly string[]; awarenessLevel: (typeof WINNER_AWARENESS_LEVELS)[number]; promise: string; proof: string; offer: string; objectionsHandled: readonly string[]; cta: string; ctaTimestampMs?: number }>;
  timeline: readonly Readonly<{ startMs: number; endMs: number; beat: (typeof WINNER_BEATS)[number]; visual: string; voiceLine: string; onScreenText: string; purpose: string }>[];
  voice: Readonly<{ deliveryStyle: string; scriptStructure: string; keyPhrases: readonly string[] }>;
  editing: Readonly<{ format: string; captionStyle: string; productProminence: string; soundOffComprehension: string; pacingAssessment: string }>;
  claimsCheck: readonly Readonly<{ claim: string; status: (typeof WINNER_CLAIM_STATUSES)[number]; note: string }>[];
  performanceRead: string;
  nextCreativeBrief: Readonly<{ keep: readonly string[]; test: readonly Readonly<{ idea: string; hypothesis: string; type: (typeof WINNER_TEST_TYPES)[number] }>[]; avoid: readonly string[] }>;
}>;
/** Application-computed facts shown beside the AI report; none of these come from the model. */
export type WinnerMeasurements = Readonly<{
  durationMs: number; width: number; height: number; frameCount: number;
  shotCount?: number; sceneCutsMs: readonly number[]; averageShotMs?: number; firstCutMs?: number;
  hasAudio: boolean; transcriptStatus: CreativeDnaAudioTranscript["status"] | "NOT_REQUESTED"; transcriptModel?: string; transcriptText?: string;
  transcriptSegments: readonly CreativeDnaTranscriptSegment[]; speechCoverage?: number; wordsPerMinute?: number; timeToFirstWordMs?: number;
  audioPresentRatio?: number; integratedLufs?: number;
  performance?: Readonly<{ spend?: number; purchases?: number; revenue?: number; cpa?: number; roas?: number; linkCtr?: number; cpc?: number; cpm?: number; currency?: string; dateStart?: string; dateEnd?: string; metricSource?: string; impressions?: number; threeSecondViews?: number; thruPlays?: number; hookRate?: number; holdRate?: number }>;
}>;
/** Background work for the winner-to-video app. Jobs run one at a time in the worker. */
export type WinnerJobKind = "ANALYZE_WINNER" | "WRITE_VIDEO_PLANS" | "RENDER_VIDEO";
export type WinnerJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
export type WinnerJob = Readonly<{
  id: string; kind: WinnerJobKind; targetId: string; operationKey: string; status: WinnerJobStatus; attempts: number;
  nextAttemptAt?: string; lastError?: string; createdAt: string; updatedAt: string;
}>;
export interface WinnerJobRepository {
  /** Idempotent on operationKey: a repeated request returns the existing job. */
  enqueue(job: WinnerJob): Promise<WinnerJob>;
  /** Claims the oldest due job; a RUNNING job older than staleAfterMs is reclaimed. */
  claimNext(now: string, staleAfterMs: number): Promise<WinnerJob | undefined>;
  finish(id: string, outcome: Readonly<{ status: "COMPLETED" | "FAILED" | "PENDING"; lastError?: string; nextAttemptAt?: string }>, timestamp: string): Promise<void>;
  list(targetId?: string): Promise<readonly WinnerJob[]>;
}

export const VIDEO_PLAN_MOTIONS = ["ZOOM_IN", "ZOOM_OUT", "PAN_LEFT", "PAN_RIGHT"] as const;
export type VideoPlanMotion = (typeof VIDEO_PLAN_MOTIONS)[number];
/** PHOTO_MOTION: smooth zoom/pan with fades. STOP_MOTION: the same photos moved in small jumps at about 7 frames a second, with hand-made shake, flicker and hard cuts. */
export const VIDEO_PLAN_STYLES = ["PHOTO_MOTION", "STOP_MOTION"] as const;
export type VideoPlanStyle = (typeof VIDEO_PLAN_STYLES)[number];
/** imagePrompt and videoPrompt are ready to paste into OpenAI image generation and Kling/Seedance image-to-video; the app does not call those services yet. */
export type VideoPlanScene = Readonly<{ photoAssetId: string; motion: VideoPlanMotion; caption: string; durationMs: number; imagePrompt?: string; videoPrompt?: string }>;
/** One new video based on a winner: what it keeps, what it changes, and exactly what to render. Plans written before styles existed have no style and render as PHOTO_MOTION. */
export type VideoPlan = Readonly<{ title: string; keepsFromWinner: string; changes: string; hookText: string; voiceover: string; scenes: readonly VideoPlanScene[]; ctaText: string; style?: VideoPlanStyle }>;
export type WinnerVideoBatchStatus = "WRITING" | "READY" | "FAILED";
export type WinnerVideoBatch = Readonly<{
  id: string; creativeReferenceId: string; productId: string; requestedCount: 3 | 6 | 12; targetDurationMs: 15_000 | 30_000;
  status: WinnerVideoBatchStatus; failureMessage?: string; providerMetadata: Readonly<Record<string, unknown>>; createdBy: string; createdAt: string; updatedAt: string;
}>;
export type WinnerVideoStatus = "PLANNED" | "QUEUED" | "RENDERING" | "READY" | "FAILED";
export type WinnerVideo = Readonly<{
  id: string; batchId: string; ordinal: number; plan: VideoPlan; status: WinnerVideoStatus;
  outputAssetId?: string; durationMs?: number; failureMessage?: string; createdAt: string; updatedAt: string;
}>;
export interface WinnerVideoRepository {
  createBatch(batch: WinnerVideoBatch): Promise<void>;
  updateBatch(batch: WinnerVideoBatch): Promise<void>;
  getBatch(id: string): Promise<WinnerVideoBatch>;
  listBatches(creativeReferenceId?: string): Promise<readonly WinnerVideoBatch[]>;
  saveVideos(videos: readonly WinnerVideo[]): Promise<void>;
  updateVideo(video: WinnerVideo): Promise<void>;
  getVideo(id: string): Promise<WinnerVideo>;
  listVideos(batchId?: string): Promise<readonly WinnerVideo[]>;
}
export type VideoPlanInput = Readonly<{
  requestedCount: 3 | 6 | 12; targetDurationMs: number; style: VideoPlanStyle;
  product: Readonly<{ name: string; description: string; facts: readonly string[]; lookRules?: unknown }>;
  photos: readonly Readonly<{ index: number; label: string; mimeType: string; bytesBase64: string }>[];
  winner: Readonly<{ name: string; report?: unknown; dna?: unknown; measurements?: unknown; metaResults?: unknown }>;
}>;

export type CreativeWinnerReportStatus = "PENDING" | "READY" | "FAILED";
export type CreativeWinnerReportRecord = Readonly<{
  creativeReferenceId: string; status: CreativeWinnerReportStatus; report?: WinnerReport; measurements?: WinnerMeasurements;
  failureMessage?: string; providerMetadata: Readonly<Record<string, unknown>>; createdAt: string; updatedAt: string;
}>;
export type CreativeDnaAnalysisInput = Readonly<{
  referenceId: string; displayName: string; mediaMetadata: CreativeDnaMediaMetadata; frames: readonly CreativeDnaFrame[];
  pacing?: CreativeDnaPacing; audioTranscript?: CreativeDnaAudioTranscript; audioLevels?: CreativeDnaAudioLevels;
  operatorNotes?: string; operatorTranscript?: string; performance?: CreativePerformanceContext;
  currentProduct?: Readonly<{ name: string; description: string; verifiedClaims: readonly ProductClaim[] }>;
}>;
export type CreativeDnaProviderResponse = StrategyProviderResponse;
export type CreativeDnaProviderOperation = Readonly<{
  id: string; referenceId: string; operationKey: string; status: "PENDING" | "SUBMITTING" | "POLLING" | "SUCCEEDED" | "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE";
  responseId?: string; model?: string; submittedAt?: string; latestProviderStatus?: StrategyProviderResponseStatus; latestPollAt?: string;
  terminalAt?: string; resultSha256?: string; providerMetadata: Readonly<Record<string, unknown>>; result?: CreativeDnaDraft; createdAt: string; updatedAt: string;
}>;

export const STRATEGY_PRODUCTION_METHODS = [
  "AI_LIFESTYLE", "AI_UGC_STYLE", "PRODUCT_IMAGE_MOTION", "PERSONALIZATION_DEMO",
  "AI_BEFORE_AFTER", "AI_CINEMATIC", "MOTION_GRAPHICS", "SEASONAL_AI"
] as const;
export type StrategyProductionMethod = typeof STRATEGY_PRODUCTION_METHODS[number];
export type StrategyDiversityState = "DISTINCT" | "NEEDS_DIFFERENTIATION" | "DUPLICATE_REPLACEMENT_REQUIRED";
export type StrategyProductionSafetyState = "PRODUCTION_SAFE" | "MISSING_REQUIRED_REAL_ASSET" | "UNSUPPORTED_PRODUCT_CLAIM" | "UNSAFE_AI_TESTIMONIAL" | "NEEDS_OPERATOR_REVIEW";
export type StrategyBatchStatus = "PENDING" | "GENERATING" | "VALIDATING" | "REVIEW" | "REVIEW_WITH_ISSUES" | "HANDED_OFF" | "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE";
export type StrategyConstraintSourceType = "VERIFIED_PRODUCT_CLAIM" | "OPERATOR_AUTHORITY" | "REFERENCE_VISUAL";
export type StrategyConstraintAuthority = "FACTUAL_CLAIM" | "VISUAL_EVIDENCE";
export type StrategyEvidenceConstraint = Readonly<{ text: string; sourceType: StrategyConstraintSourceType; authority: StrategyConstraintAuthority; sourceId?: string }>;
export type StrategyAssetCapability = "PRODUCT_IMAGE" | "PRODUCT_MOCKUP" | "CUSTOMER_REFERENCE_IMAGE" | "REAL_PRODUCT_VIDEO" | "REAL_CREATOR_PRODUCT_VIDEO" | "REAL_FACTORY_VIDEO" | "REAL_UNBOXING_VIDEO" | "REAL_CUSTOMER_TESTIMONIAL";
export type StrategyUgcRepresentation = "NOT_APPLICABLE" | "AI_STYLE_NON_CUSTOMER" | "REAL_SUPPLIED_TESTIMONIAL";
export type StrategyRequestedCount = 3 | 6 | 12;

/** Creative judgment returned by the provider. Authority data is intentionally absent. */
export type StrategyProviderConceptDraft = Readonly<{
  ordinal: number;
  conceptName: string;
  conceptFamily: string;
  /** Purchase context/motivation, never inferred demographic targeting. */
  buyerPersona: string;
  customerDesireOrProblem: string;
  awarenessLevel: string;
  coreAngle: string;
  emotionalTerritory: string;
  primaryPromise: string;
  hook: string;
  openingVisualPattern: string;
  creativeFormat: string;
  primaryProductionMethod: StrategyProductionMethod;
  supportingProductionMethods: readonly StrategyProductionMethod[];
  proofMechanism: string;
  offerFraming: string;
  ctaStrategy: string;
  differentiationSummary: string;
  creativeVisualExecutionNotes: string;
  ugcRepresentation: StrategyUgcRepresentation;
}>;

/** Canonical persisted draft after application-owned truth/capability injection. */
export type StrategyConceptDraft = StrategyProviderConceptDraft & Readonly<{
  productTruthConstraints: readonly StrategyEvidenceConstraint[];
  visualFidelityRequirements: readonly StrategyEvidenceConstraint[];
  requiredRealAssetCapabilities: readonly StrategyAssetCapability[];
}>;

export type StrategyConceptRevision = StrategyConceptDraft & Readonly<{
  id: string; conceptId: string; batchId: string; revision: number;
  source: "AI_PROVIDER" | "OPENAI" | "OPERATOR_REPLACEMENT";
  diversityState: StrategyDiversityState;
  productionSafetyState: StrategyProductionSafetyState;
  validationFindings: readonly string[];
  providerMetadata: Readonly<Record<string, unknown>>;
  createdBy: string; createdAt: string;
}>;
export type StrategyConcept = Readonly<{ id: string; batchId: string; ordinal: number; currentRevision: StrategyConceptRevision; status: "ACTIVE" | "SELECTED" | "HANDED_OFF"; createdAt: string; updatedAt: string }>;

export type StrategyHistoryEntry = Readonly<{
  conceptRevisionId: string; conceptFamily: string; buyerPersona: string; customerDesireOrProblem: string;
  coreAngle: string; emotionalTerritory: string; openingVisualPattern: string; creativeFormat: string;
  primaryProductionMethod: StrategyProductionMethod; supportingProductionMethods: readonly StrategyProductionMethod[];
  proofMechanism: string; offerFraming: string; differentiationSummary: string;
}>;
export type StrategyGenerationInput = Readonly<{
  productName: string; productDescription: string; verifiedClaims: readonly ProductClaim[];
  selectedAssets: readonly Pick<ProductAsset, "id" | "kind" | "label" | "mimeType">[];
  additionalInstructions: string; targetDurationMs: number;
  availableAssetCapabilities: readonly StrategyAssetCapability[];
  authoritativeConstraints: readonly StrategyEvidenceConstraint[];
  creativeHistory: readonly StrategyHistoryEntry[];
  requestedCount: StrategyRequestedCount;
  preservedConcepts?: readonly StrategyProviderConceptDraft[];
  replacementOrdinals?: readonly number[];
  replacementFindings?: readonly Readonly<{ ordinal: number; findings: readonly string[] }>[];
}>;
export type SelectedStrategySnapshot = Omit<StrategyConceptRevision, "providerMetadata" | "validationFindings"> & Readonly<{ revisionSha256: string }>;
export type StrategyBatch = Readonly<{
  id: string; sourceProjectId: string; productId: string; revision: number; requestedCount: StrategyRequestedCount; operationKey: string;
  inputSnapshot: StrategyGenerationInput; historySnapshot: readonly StrategyHistoryEntry[]; historySha256: string;
  status: StrategyBatchStatus; providerRequestCount: number; automaticRepairAttempted: boolean;
  validationSummary: Readonly<Record<string, unknown>>; providerMetadata: readonly Readonly<Record<string, unknown>>[];
  createdBy: string; createdAt: string; updatedAt: string;
}>;
export type StrategyProviderOperationKind = "INITIAL" | "AUTO_REPAIR" | "EXPLICIT_REPLACEMENT";
export type StrategyProviderResponseStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
export type StrategyProviderResponse = Readonly<{
  responseId: string;
  status: StrategyProviderResponseStatus;
  provider: string;
  model: string;
  outputText?: string;
  usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
  safeError?: Readonly<{ code?: string; message: string }>;
}>;
export type ConceptProviderResponse = StrategyProviderResponse;
export type StrategyProviderOperation = Readonly<{
  id: string; batchId: string; kind: StrategyProviderOperationKind; operationKey: string;
  status: "PENDING" | "SUBMITTING" | "POLLING" | "SUCCEEDED" | "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE";
  responseId?: string;
  model?: string;
  submittedAt?: string;
  latestProviderStatus?: StrategyProviderResponseStatus;
  latestPollAt?: string;
  terminalAt?: string;
  resultSha256?: string;
  providerMetadata: Readonly<Record<string, unknown>>;
  /** Durable provider result permits job replay without a second paid request. */
  result?: Readonly<{ concepts: readonly StrategyProviderConceptDraft[]; submission: ProviderSubmission }>;
  createdAt: string; updatedAt: string;
}>;
export type StrategyOrigin = Readonly<{
  batchId: string;
  conceptId: string;
  conceptRevisionId: string;
  revisionSha256: string;
  /** Campaign workspace that owns shared References and Strategy authority. */
  sourceProjectId?: string;
}>;

export type ProjectCreativeBrief = Readonly<{
  creativeTopic: string;
  productDetails: string;
  targetDurationSeconds: number;
}>;

export type CreativeConcept = CreativeConceptDraft &
  Readonly<{
    id: string;
    revision: number;
    source: "PROVIDER" | "USER_EDIT";
    status: "REVIEW" | "APPROVED" | "SUPERSEDED";
    inputSnapshot: CreativeInputSnapshot;
    providerMetadata: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>;

export type GeneratedAsset = Readonly<{
  id: string;
  kind: "VIDEO" | "AUDIO" | "RENDER" | "IMAGE";
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** Durable backing store identity; omitted on legacy/in-memory fixtures. */
  storageProvider?: string;
  storageBucket?: string;
  projectId?: string;
  purpose?: string;
  lifecycleStatus?: "PENDING_UPLOAD" | "AVAILABLE" | "FAILED" | "CLEANUP_PENDING" | "CLEANED";
  deleteAfter?: string;
  deletedAt?: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type SceneAttemptStatus =
  | "PENDING"
  | "SUBMITTED"
  | "PROCESSING"
  | "SUBMISSION_UNKNOWN"
  | "REVIEW"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED";

/** Immutable attempt provenance: manual/external upload or an optional API provider, independent of scene reference semantics. */
export type SceneGenerationMethod = "MANUAL" | "API";

export type SceneAttempt = Readonly<{
  id: string;
  attemptNumber: number;
  sourceType: SceneSourceType;
  conceptSceneNumber: number;
  prompt: string;
  /** Immutable execution/provenance method for this specific attempt. */
  generationMethod?: SceneGenerationMethod;
  status: SceneAttemptStatus;
  operationKey: string;
  inputAssetId?: string;
  outputAssetId?: string;
  providerTaskId?: string;
  provider?: string;
  providerModel?: string;
  providerRequestId?: string;
  providerMetadata?: Readonly<Record<string, unknown>>;
  inspection?: MediaInspection;
  replacesAttemptId?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CreativeScene = Readonly<{
  id: string;
  sceneNumber: number;
  status: "PENDING" | "GENERATING" | "REVIEW" | "ACCEPTED" | "FAILED";
  /** Mutable selection for the next AI-video attempt; attempts retain their own snapshot. */
  requestedVideoProvider?: string;
  requestedVideoModel?: string;
  /** Phase 1 defaults manual-capable scenes to manual/external upload. */
  requestedGenerationMethod?: SceneGenerationMethod;
  attempts: readonly SceneAttempt[];
  approvedAttemptId?: string;
}>;

export type NarrationRevision = Readonly<{
  id: string;
  revision: number;
  script: string;
  /** Concept copy is preserved; later manual/rewrite revisions are append-only. */
  source: "CONCEPT" | "MANUAL" | "AI_REWRITE" | "OPENAI_REWRITE";
  estimatedDurationMs: number;
  parentRevisionId?: string;
  provider?: string;
  providerModel?: string;
  providerRequestId?: string;
  providerMetadata?: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type VoiceGeneration = Readonly<{
  id: string;
  attemptNumber: number;
  voiceProfileId: string;
  sourceScript: string;
  narrationRevisionId?: string;
  deliveryInstructions?: string;
  status: "PENDING" | "SUBMITTED" | "PROCESSING" | "REVIEW" | "ACCEPTED" | "REJECTED" | "FAILED";
  operationKey: string;
  providerTaskId?: string;
  outputAssetId?: string;
  provider?: string;
  providerModel?: string;
  inspection?: MediaInspection;
  createdAt: string;
  updatedAt: string;
}>;

export type MediaInspection = Readonly<{
  passed: boolean;
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  audioCodec?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  byteSize: number;
  rules: Readonly<Record<string, boolean>>;
}>;

export type RenderAttempt = Readonly<{
  id: string;
  attemptNumber: number;
  status: "PENDING" | "SUBMITTED" | "PROCESSING" | "SUBMISSION_UNKNOWN" | "SUCCEEDED" | "QA_FAILED" | "REJECTED" | "FAILED";
  operationKey: string;
  sceneAttemptIds: readonly string[];
  voiceGenerationId: string;
  compositionStyleKey: string;
  cta: string;
  inputSnapshot: RenderInputSnapshot;
  /** Immutable provider selection for this paid composition attempt. */
  requestedProvider?: string;
  provider?: string;
  providerModel?: string;
  providerMetadata?: Readonly<Record<string, unknown>>;
  providerRequestId?: string;
  providerTaskId?: string;
  failureMessage?: string;
  outputAssetId?: string;
  outputSha256?: string;
  inspection?: MediaInspection;
  createdAt: string;
  updatedAt: string;
}>;

export type CaptionTiming = Readonly<{ text: string; startMs: number; endMs: number }>;

/** Immutable, provider-neutral description of what a render attempt submitted. */
export type RenderInputSnapshot = Readonly<{
  templateVersion: string;
  sceneInputs: readonly Readonly<{ attemptId: string; assetId: string; sha256: string; intendedDurationMs: number; sourceDurationMs?: number | undefined }>[],
  narration: Readonly<{ voiceGenerationId: string; assetId: string; sha256: string; captionTimings: readonly CaptionTiming[]; durationMs?: number }>;
  /** Immutable render plan. Older snapshots fall back to the Phase 1 default. */
  timeline?: Readonly<{ transition: "CUT" | "CROSSFADE" | "SOFT_DISSOLVE"; transitionDurationMs: number; narrationLeadInMs: number }>;
  music?: Readonly<{ assetId: string; sha256: string }>;
  logo?: Readonly<{ assetId: string; sha256: string }>;
  marketingOverlays: readonly string[];
  cta: string;
  target: Readonly<{ width: number; height: number; durationMs: number }>;
}>;

export type VariantTreatment = "PUSH_IN" | "REFRAME_PAN" | "ALTERNATE_ZOOM" | "FAST_HOOK";
export type VariantSceneTransform = Readonly<{ treatment: VariantTreatment; startScale: number; endScale: number; panX?: number | undefined; panY?: number | undefined; endPanX?: number | undefined; endPanY?: number | undefined; startOffsetMs?: number | undefined }>;
export type VariantPackageSlot = "A" | "B" | "C" | "D";
export type VariantRecipe = Readonly<{ recipeVersion: "variant-v1" | "variant-v2"; projectId: string; batchId: string; variantId: string; targetDurationMs: number; sceneOrder: readonly number[]; scenes: readonly Readonly<{ sourceAttemptId: string; sourceChecksum: string; transform: VariantSceneTransform }>[]; hook: string; cta: string; voice: Readonly<{ attemptId: string; checksum: string; durationMs?: number | undefined }>; package?: Readonly<{ slot: VariantPackageSlot; packageRevisionId: string; angle: string; narration: string; secondaryOverlay?: string | undefined; variantVoiceId: string }>; transition: Readonly<{ type: "SOFT_DISSOLVE"; durationMs: number }>; }>;

/** Stable 3 x 4 matrix: every source opens four variants and all orders are represented. */
export const VARIANT_ORDER_MATRIX: readonly (readonly [number, number, number])[] = [
  [1, 2, 3], [1, 3, 2], [1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1], [3, 1, 2], [3, 2, 1]
];
export const VARIANT_TREATMENT_MATRIX: readonly VariantTreatment[] = [
  "PUSH_IN", "REFRAME_PAN", "ALTERNATE_ZOOM", "FAST_HOOK", "PUSH_IN", "REFRAME_PAN", "ALTERNATE_ZOOM", "FAST_HOOK", "PUSH_IN", "REFRAME_PAN", "ALTERNATE_ZOOM", "FAST_HOOK"
];/** B02+ creative-diversity matrix: one opening scene × each package/treatment. */
export const VARIANT_DIVERSITY_MATRIX: readonly Readonly<{ openingScene: 1 | 2 | 3; slot: VariantPackageSlot; treatment: VariantTreatment; sceneOrder: readonly [number, number, number] }>[] = [
  { openingScene: 1, slot: "A", treatment: "PUSH_IN", sceneOrder: [1, 2, 3] }, { openingScene: 1, slot: "B", treatment: "REFRAME_PAN", sceneOrder: [1, 3, 2] }, { openingScene: 1, slot: "C", treatment: "ALTERNATE_ZOOM", sceneOrder: [1, 2, 3] }, { openingScene: 1, slot: "D", treatment: "FAST_HOOK", sceneOrder: [1, 3, 2] },
  { openingScene: 2, slot: "A", treatment: "PUSH_IN", sceneOrder: [2, 3, 1] }, { openingScene: 2, slot: "B", treatment: "REFRAME_PAN", sceneOrder: [2, 1, 3] }, { openingScene: 2, slot: "C", treatment: "ALTERNATE_ZOOM", sceneOrder: [2, 3, 1] }, { openingScene: 2, slot: "D", treatment: "FAST_HOOK", sceneOrder: [2, 1, 3] },
  { openingScene: 3, slot: "A", treatment: "PUSH_IN", sceneOrder: [3, 1, 2] }, { openingScene: 3, slot: "B", treatment: "REFRAME_PAN", sceneOrder: [3, 2, 1] }, { openingScene: 3, slot: "C", treatment: "ALTERNATE_ZOOM", sceneOrder: [3, 1, 2] }, { openingScene: 3, slot: "D", treatment: "FAST_HOOK", sceneOrder: [3, 2, 1] }
];export const DEFAULT_SCENE_TRANSITION = "SOFT_DISSOLVE" as const;
export const DEFAULT_SCENE_TRANSITION_DURATION_MS = 500;

/** Calculates source durations so dissolve overlap never shortens the final output. */
export function calculateSceneTimeline(targetDurationMs: number, sceneCount: number, transitionDurationMs = DEFAULT_SCENE_TRANSITION_DURATION_MS): readonly number[] {
  if (!Number.isInteger(targetDurationMs) || targetDurationMs <= 0 || !Number.isInteger(sceneCount) || sceneCount <= 0) throw new DomainError("INVALID_RENDER_TIMELINE", "Render timeline requires a positive target duration and scene count.");
  const overlap = sceneCount > 1 ? Math.max(0, transitionDurationMs) * (sceneCount - 1) : 0;
  const sourceTotal = targetDurationMs + overlap;
  const base = Math.floor(sourceTotal / sceneCount);
  return Array.from({ length: sceneCount }, (_, index) => base + (index < sourceTotal % sceneCount ? 1 : 0));
}

export type VoiceTimingAssessment = Readonly<{ minimumMs: number; maximumMs: number; leadInMs: number; classification: "GOOD" | "TOO_SHORT" | "TOO_LONG" | "UNKNOWN"; atempo: number }>;

/** Lightweight pre-TTS estimate. Actual duration comes only from post-generation audio QA. */
export const DEFAULT_ESTIMATED_NARRATION_WPM = 140;
export function estimateNarrationDurationMs(script: string, wordsPerMinute = DEFAULT_ESTIMATED_NARRATION_WPM): number {
  const words = script.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu)?.length ?? 0;
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0 || words === 0) return 0;
  return Math.round(words * 60_000 / wordsPerMinute);
}

/** Voice is normally 86–94% of the final runtime, with a small visual lead-in. */
export function assessVoiceTiming(targetDurationMs: number, actualDurationMs?: number): VoiceTimingAssessment {
  const minimumMs = Math.round(targetDurationMs * 0.8667);
  const maximumMs = Math.round(targetDurationMs * 0.9467);
  const leadInMs = Math.max(300, Math.min(500, Math.round(targetDurationMs * 0.0267)));
  if (!actualDurationMs || actualDurationMs <= 0) return { minimumMs, maximumMs, leadInMs, classification: "UNKNOWN", atempo: 1 };
  const classification = actualDurationMs < minimumMs ? "TOO_SHORT" : actualDurationMs > maximumMs ? "TOO_LONG" : "GOOD";
  const desiredDurationMs = classification === "TOO_SHORT" ? minimumMs : classification === "TOO_LONG" ? maximumMs : actualDurationMs;
  const candidate = actualDurationMs / desiredDurationMs;
  // FFmpeg atempo is deliberately limited to an imperceptible ±8% correction.
  const atempo = candidate >= 0.92 && candidate <= 1.08 ? Math.round(candidate * 10_000) / 10_000 : 1;
  return { minimumMs, maximumMs, leadInMs, classification, atempo };
}
export type Approval = Readonly<{
  id: string;
  stage: "CONCEPT" | "SCENE" | "VOICE" | "FINAL" | "READY_SAVE";
  targetId: string;
  targetSha256?: string;
  decision: "APPROVED" | "REJECTED";
  actor: string;
  note?: string;
  createdAt: string;
}>;

export type UsageCost = Readonly<{
  id: string;
  provider: string;
  model: string;
  operationType: "CONCEPT" | "VIDEO" | "VOICE" | "COMPOSITION" | "STRATEGY" | "CREATIVE_DNA";
  projectId: string;
  sceneId?: string;
  requestId: string;
  status: "ESTIMATED" | "REPORTED" | "FINAL" | "UNAVAILABLE";
  estimatedCost?: number;
  actualCost?: number;
  currency: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}>;

export type AuditEvent = Readonly<{
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  actor: string;
  details: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type ReadyFile = Readonly<{
  path: string;
  sha256: string;
  byteSize: number;
  publishedAt: string;
  assetId?: string;
  storageProvider?: string;
  storageKey?: string;
}>;

export type CreativeProject = Readonly<{
  id: string;
  publicId: string;
  productId: string;
  selectedProductAssetIds: readonly string[];
  additionalInstructions: string;
  preferredVoiceProfileId: string;
  /** Structured inputs for operator-created projects. Legacy projects omit this field. */
  creativeBrief?: ProjectCreativeBrief;
  /** Shared Campaign authority workspace; execution children reference it through Strategy origin. */
  campaignWorkspace?: boolean;
  strategyRequired?: boolean;
  strategyOrigin?: StrategyOrigin;
  winnerDnaOrigin?: Readonly<{ creativeReferenceId: string; revisionId: string; revisionSha256: string }>;
  winnerDnaSnapshot?: SelectedWinnerDnaSnapshot;
  /** Complete immutable authority snapshot created before any Creative Concept provider call. */
  creativeInputSnapshot?: CreativeHandoffInputSnapshot;
  state: ProjectState;
  concepts: readonly CreativeConcept[];
  currentConceptId?: string | undefined;
  scenes: readonly CreativeScene[];
  narrationRevisions?: readonly NarrationRevision[];
  currentNarrationRevisionId?: string | undefined;
  voiceGenerations: readonly VoiceGeneration[];
  /** Current accepted narration used by future render snapshots. */
  currentVoiceGenerationId?: string | undefined;
  /** A READY project can review a new voice without replacing its accepted/published source. */
  candidateVoiceGenerationId?: string | undefined;
  renders: readonly RenderAttempt[];
  currentRenderId?: string;
  /** A READY project can review one new immutable candidate without replacing its published final. */
  candidateRenderId?: string | undefined;
  /** Exact QA-passed candidate explicitly submitted by the editor for owner review. */
  ownerReviewRenderId?: string | undefined;
  /** Approved render history, newest last; media retention is managed independently. */
  publishedRenderIds?: readonly string[];
  approvals: readonly Approval[];
  usageCosts: readonly UsageCost[];
  auditEvents: readonly AuditEvent[];
  readyFile?: ReadyFile;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

/**
 * A Strategy source can be reused for its first Video Maker handoff only while
 * it has no immutable handoff or execution history. Product references and a
 * completed Strategy batch are expected on an otherwise untouched source.
 */
export function isReusableAsPristineStrategySource(project: CreativeProject): boolean {
  const hasExecutionAuditHistory = project.auditEvents.some((event) =>
    event.type !== "PROJECT_CREATED" && event.type !== "PRODUCT_REFERENCE_ATTACHED"
  );
  return project.state === "DRAFT"
    && project.creativeInputSnapshot === undefined
    && project.strategyOrigin === undefined
    && project.winnerDnaOrigin === undefined
    && project.winnerDnaSnapshot === undefined
    && project.concepts.length === 0
    && project.scenes.length === 0
    && (project.narrationRevisions?.length ?? 0) === 0
    && project.voiceGenerations.length === 0
    && project.renders.length === 0
    && project.approvals.length === 0
    && project.usageCosts.length === 0
    && !hasExecutionAuditHistory
    && (project.publishedRenderIds?.length ?? 0) === 0
    && project.currentConceptId === undefined
    && project.currentNarrationRevisionId === undefined
    && project.currentVoiceGenerationId === undefined
    && project.candidateVoiceGenerationId === undefined
    && project.currentRenderId === undefined
    && project.candidateRenderId === undefined
    && project.ownerReviewRenderId === undefined
    && project.readyFile === undefined;
}

export type WorkflowJobType = "GENERATE_CONCEPT" | "GENERATE_SCENE" | "GENERATE_VOICE" | "COMPOSE_RENDER" | "GENERATE_STRATEGY" | "REPLACE_STRATEGY" | "ANALYZE_CREATIVE_DNA";
export type WorkflowJob = Readonly<{
  id: string;
  dedupeKey: string;
  type: WorkflowJobType;
  projectId: string;
  targetId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  attempts: number;
  lastError?: string;
  /** Durable not-before time used for provider polling without occupying a worker. */
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProviderOperationContext = Readonly<{
  operationKey: string;
  projectId: string;
  targetId: string;
}>;

export type ProviderSubmission = Readonly<{
  providerTaskId: string;
  requestId: string;
  provider: string;
  model: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type MediaPayload = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type CompositionMediaInput = Readonly<{
  assetId: string;
  sha256: string;
  mimeType: string;
  reference: ExternalMediaReference;
}>;

/** A provider result is deliberately not a persistent asset identity. */
export type CompositionOutput =
  | Readonly<{ kind: "INLINE"; payload: MediaPayload }>
  | Readonly<{ kind: "INTERNAL_ASSET"; asset: GeneratedAsset; metadata: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "TRUSTED_REMOTE"; provider: string; outputId: string; url: string; metadata: Readonly<Record<string, unknown>> }>;

export type VideoGenerationMode = "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO";
export type VideoGenerationOutput = Exclude<CompositionOutput, Readonly<{ kind: "INTERNAL_ASSET" }>>;
export type VideoReferenceInput = Readonly<{
  assetId: string;
  sha256: string;
  mimeType: string;
  reference: ExternalMediaReference;
}>;

export type ProviderJobStatus<T> =
  | Readonly<{ state: "PROCESSING" }>
  | Readonly<{ state: "FAILED"; message: string; retryable: boolean }>
  | Readonly<{ state: "SUCCEEDED"; result: T }>;

export type NarrationRewriteInput = Readonly<{
  script: string;
  targetDurationMs: number;
  recommendedMinimumMs: number;
  recommendedMaximumMs: number;
  productName: string;
  creativeTopic?: string;
  productDetails?: string;
  cta: string;
}>;

export type VariantCreativePackageDraft = Readonly<{ slot: VariantPackageSlot; angleName: string; hook: string; narrationText: string; cta: string; secondaryOverlay?: string; }>;
export type VariantPackageGenerationInput = Readonly<{ productName: string; productDetails?: string; creativeTopic?: string; approvedConcept?: Readonly<{ angle: string; hook: string; voiceScript: string; cta: string; }>; scenes: readonly Readonly<{ purpose: string; generationPrompt: string; }>[]; targetDurationMs: number; }>;

export interface CreativeProvider {
  generateConcept(
    input: CreativeInputSnapshot,
    context: ProviderOperationContext
  ): Promise<Readonly<{ concept: CreativeConceptProviderDraft; submission: ProviderSubmission }>>;
  /** Strategy-linked Creative Concept submission returns promptly with a durable background Response ID. */
  submitConceptExecution?(input: CreativeInputSnapshot, context: ProviderOperationContext, feasibilityPlan?: ExecutionFeasibilityPlan): Promise<ConceptProviderResponse>;
  /** Retrieves only the known Concept response and must never create a replacement request. */
  retrieveConceptExecution?(responseId: string): Promise<ConceptProviderResponse>;
  /** Explicit operator action only; never invoked by normal concept or voice generation. */
  rewriteNarration?(
    input: NarrationRewriteInput,
    context: ProviderOperationContext
  ): Promise<Readonly<{ script: string; submission: ProviderSubmission }>>;
  /** Explicit Variant Factory action only; never called by batch creation or rendering. */
  generateVariantPackages?(input: VariantPackageGenerationInput, context: ProviderOperationContext): Promise<Readonly<{ packages: readonly VariantCreativePackageDraft[]; submission: ProviderSubmission }>>;
  /** Explicit Creative Strategy action only. Submission returns promptly with a durable provider response ID. */
  submitStrategyConcepts?(input: StrategyGenerationInput, context: ProviderOperationContext): Promise<StrategyProviderResponse>;
  /** Retrieves an already-submitted Strategy response. This method must never create a new response. */
  retrieveStrategyConcepts?(responseId: string): Promise<StrategyProviderResponse>;
  /** Writes new video plans based on an analyzed winner; photos are referenced by their 1-based index. */
  planWinnerVideos?(input: VideoPlanInput, context: ProviderOperationContext): Promise<Readonly<{ plans: readonly unknown[]; submission: ProviderSubmission }>>;
  /** Explicit historical-ad analysis. Submission returns a durable background response ID. */
  submitCreativeDnaAnalysis?(input: CreativeDnaAnalysisInput, context: ProviderOperationContext): Promise<CreativeDnaProviderResponse>;
  /** Retrieves only the known response and must never create a replacement request. */
  retrieveCreativeDnaAnalysis?(responseId: string): Promise<CreativeDnaProviderResponse>;
}

export interface VideoGenerationProvider {
  readonly providerKey?: string;
  readonly defaultModel?: string;
  readonly requiresExternalMedia?: boolean;
  submit(
    input: Readonly<{
      sceneNumber: number;
      durationMs: number;
      prompt: string;
      sourceType: SceneSourceType;
      referenceAssetIds: readonly string[];
      generationMode: VideoGenerationMode;
      model?: string;
      accuracyRequirements: readonly string[];
      referenceImage?: VideoReferenceInput;
    }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission>;
  getStatus(providerTaskId: string): Promise<ProviderJobStatus<VideoGenerationOutput>>;
}

/** Ingests only video output references emitted by the configured video provider. */
export interface VideoOutputIngestor {
  ingest(output: VideoGenerationOutput): Promise<MediaPayload>;
}

export interface VoiceProvider {
  submit(
    input: Readonly<{ voiceProfileId: string; script: string; instructions?: string }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission>;
  getStatus(providerTaskId: string): Promise<ProviderJobStatus<MediaPayload>>;
}

export interface CompositionProvider {
  readonly requiresExternalMedia?: boolean;
  submit(
    input: Readonly<{
      snapshot: RenderInputSnapshot;
      sceneAssets: readonly CompositionMediaInput[];
      narration: CompositionMediaInput;
      captionTimings: readonly CaptionTiming[];
      music?: CompositionMediaInput;
      logo?: CompositionMediaInput;
      marketingOverlays: readonly string[];
      cta: string;
      compositionStyleKey: string;
      target: Readonly<{ width: number; height: number; durationMs: number }>;
    }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission>;
  getStatus(providerTaskId: string): Promise<ProviderJobStatus<CompositionOutput>>;
}

/** Ingests only output references emitted by a known composition provider. */
export interface CompositionOutputIngestor {
  ingest(output: CompositionOutput): Promise<MediaPayload>;
}

export interface StorageProvider {
  put(key: string, payload: MediaPayload): Promise<GeneratedAsset>;
  read(key: string): Promise<Uint8Array>;
  getAsset(assetId: string): Promise<GeneratedAsset>;
}


export type DurableUploadTarget = Readonly<{
  asset: GeneratedAsset;
  method: "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
}>;

/** Durable media is separate from temporary provider-staging delivery. */
export interface DurableMediaStore extends StorageProvider {
  readonly providerKey: string;
  createUpload(input: Readonly<{
    projectId: string;
    purpose: string;
    kind: GeneratedAsset["kind"];
    mimeType: string;
    extension: string;
    byteSize: number;
    sha256: string;
    originalFilename?: string;
    namespace?: "working" | "final";
    metadata?: Readonly<Record<string, unknown>>;
  }>): Promise<DurableUploadTarget>;
  getUploadTarget(assetId: string): Promise<DurableUploadTarget>;
  completeUpload(assetId: string): Promise<GeneratedAsset>;
  getDownloadReference(assetId: string, options?: Readonly<{ downloadFilename?: string }>): Promise<ExternalMediaReference>;
  rejectUpload(assetId: string, safeReason: string): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
}
export interface MediaInspector {
  inspect(asset: GeneratedAsset, expectation: Readonly<{
    width: number;
    height: number;
    durationMs: number;
    requireAudio: boolean;
  }>): Promise<MediaInspection>;
  inspectAudio(asset: GeneratedAsset, expectation: Readonly<{ maxDurationMs: number }>): Promise<MediaInspection>;
  inspectVideo(asset: GeneratedAsset, expectation: Readonly<{ expectedDurationMs: number; toleranceMs: number }>): Promise<MediaInspection>;
}

export interface CreativeDnaPreprocessor {
  preprocess(asset: GeneratedAsset): Promise<CreativeDnaPreprocessed>;
}

/** Speech-to-text for a historical ad's extracted audio. Failures are reported to the analysis, never retried by it. */
export interface CreativeDnaTranscriber {
  transcribe(input: Readonly<{ bytes: Uint8Array; mimeType: "audio/mpeg"; fileName: string; durationMs: number }>): Promise<CreativeDnaTranscription>;
}

export interface ReadyPublisher {
  publish(input: Readonly<{
    source: GeneratedAsset;
    productSlug: string;
    projectPublicId: string;
    approvedSha256: string;
  }>): Promise<ReadyFile>;
}

export type ExternalMediaReference = Readonly<{ url: string; expiresAt: string; contentType: string; size: number }>;
export interface ExternalMediaDeliveryProvider {
  stage(input: Readonly<{ projectId: string; operationId: string; asset: GeneratedAsset; storage: StorageProvider }>): Promise<ExternalMediaReference>;
  cleanup(operationId: string): Promise<void>;
}

export interface FactoryRepository {
  nextProjectNumber(): Promise<number>;
  saveProduct(product: Product): Promise<void>;
  getProduct(id: string): Promise<Product>;
  listProducts(): Promise<readonly Product[]>;
  saveProject(project: CreativeProject): Promise<void>;
  /** Atomically persists a one-project product and its project aggregate when supported. */
  saveProductAndProject?(product: Product, project: CreativeProject): Promise<void>;
  getProject(id: string): Promise<CreativeProject>;
  listProjects(): Promise<readonly CreativeProject[]>;
  /** Safe bounded evidence for accepted or rejected synchronous concept responses. */
  saveConceptProviderOperation(operation: ConceptProviderOperationEvidence): Promise<void>;
  getConceptProviderOperation(operationKey: string): Promise<ConceptProviderOperationEvidence | undefined>;
  beginConceptProviderOperation(operationKey: string): Promise<Readonly<{ operation: ConceptProviderOperationEvidence; claimed: boolean }>>;
  enqueueJob(job: WorkflowJob): Promise<WorkflowJob>;
  getJobByDedupeKey(dedupeKey: string): Promise<WorkflowJob | undefined>;
  getJob(id: string): Promise<WorkflowJob>;
  saveJob(job: WorkflowJob): Promise<void>;
  listJobs(projectId: string): Promise<readonly WorkflowJob[]>;
}

export interface StrategyRepository {
  createBatch(input: Readonly<{ id: string; sourceProjectId: string; productId: string; operationKey: string; inputSnapshot: StrategyGenerationInput; historySnapshot: readonly StrategyHistoryEntry[]; historySha256: string; actor: string; timestamp: string }>): Promise<StrategyBatch>;
  getBatch(id: string): Promise<StrategyBatch>;
  listBatches(projectId: string): Promise<readonly Readonly<{ batch: StrategyBatch; concepts: readonly StrategyConcept[] }>[] >;
  listConcepts(batchId: string): Promise<readonly StrategyConcept[]>;
  getRevision(id: string): Promise<StrategyConceptRevision>;
  listProductHistory(productId: string, excludeBatchId?: string): Promise<readonly StrategyHistoryEntry[]>;
  getOrCreateOperation(input: Readonly<{ id: string; batchId: string; kind: StrategyProviderOperationKind; operationKey: string; timestamp: string }>): Promise<StrategyProviderOperation>;
  beginOperation(id: string): Promise<Readonly<{ operation: StrategyProviderOperation; claimed: boolean }>>;
  recordOperationSubmission(id: string, input: Readonly<{ response: StrategyProviderResponse; submittedAt: string }>): Promise<void>;
  recordOperationPoll(id: string, input: Readonly<{ response: StrategyProviderResponse; polledAt: string }>): Promise<void>;
  recordOperationPollFailure(id: string, input: Readonly<{ polledAt: string; message: string }>): Promise<void>;
  completeOperation(id: string, result: Readonly<{ concepts: readonly StrategyProviderConceptDraft[]; submission: ProviderSubmission }>): Promise<void>;
  failOperation(id: string, status: "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE", message: string): Promise<void>;
  setBatchState(id: string, status: StrategyBatchStatus, timestamp: string): Promise<void>;
  saveGeneratedConcepts(input: Readonly<{ batchId: string; concepts: readonly StrategyConceptDraft[]; source: StrategyConceptRevision["source"]; actor: string; providerMetadata: Readonly<Record<string, unknown>>; timestamp: string; replaceOrdinals?: readonly number[] }>): Promise<void>;
  saveValidation(input: Readonly<{ batchId: string; results: readonly Readonly<{ conceptId: string; revisionId: string; diversityState: StrategyDiversityState; productionSafetyState: StrategyProductionSafetyState; findings: readonly string[] }>[]; status: StrategyBatchStatus; automaticRepairAttempted: boolean; summary: Readonly<Record<string, unknown>>; timestamp: string }>): Promise<void>;
  createHandoff(input: Readonly<{ batchId: string; revisionIds: readonly string[]; requestId: string; actor: string; timestamp: string; winnerDna?: SelectedWinnerDnaSnapshot; inputSnapshots?: readonly Readonly<{ revisionId: string; snapshot: CreativeHandoffInputSnapshot }>[] }>): Promise<readonly CreativeProject[]>;
}

export interface CreativeDnaRepository {
  createReference(reference: CreativeReference): Promise<CreativeReference>;
  getReference(id: string): Promise<CreativeReference>;
  listReferences(sourceProjectId?: string): Promise<readonly Readonly<{ reference: CreativeReference; revisions: readonly CreativeDnaRevision[] }>[] >;
  updateReference(reference: CreativeReference): Promise<void>;
  getRevision(id: string): Promise<CreativeDnaRevision>;
  listApproved(productId?: string, sourceProjectId?: string): Promise<readonly Readonly<{ reference: CreativeReference; revision: CreativeDnaRevision }>[] >;
  saveWinnerReport(record: CreativeWinnerReportRecord): Promise<void>;
  saveMetaLink(link: CreativeMetaLink): Promise<void>;
  deleteMetaLink(creativeReferenceId: string): Promise<void>;
  /** Hides the reference from every listing; its rows are kept so it can be restored. */
  archiveReference(id: string, actor: string, timestamp: string): Promise<void>;
  listMetaLinks(): Promise<readonly CreativeMetaLink[]>;
  listWinnerReports(): Promise<readonly CreativeWinnerReportRecord[]>;
  saveRevision(revision: CreativeDnaRevision): Promise<void>;
  approveRevision(referenceId: string, revisionId: string, actor: string, timestamp: string): Promise<CreativeDnaRevision>;
  getOrCreateOperation(input: Readonly<{ id: string; referenceId: string; operationKey: string; timestamp: string }>): Promise<CreativeDnaProviderOperation>;
  beginOperation(id: string): Promise<Readonly<{ operation: CreativeDnaProviderOperation; claimed: boolean }>>;
  recordOperationSubmission(id: string, response: CreativeDnaProviderResponse, timestamp: string): Promise<void>;
  recordOperationPoll(id: string, response: CreativeDnaProviderResponse, timestamp: string): Promise<void>;
  recordOperationPollFailure(id: string, message: string, timestamp: string): Promise<void>;
  completeOperation(id: string, draft: CreativeDnaDraft, metadata: Readonly<Record<string, unknown>>, timestamp: string): Promise<void>;
  failOperation(id: string, status: "FAILED" | "SUBMISSION_UNKNOWN" | "RESULT_UNAVAILABLE", message: string, timestamp: string): Promise<void>;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}
