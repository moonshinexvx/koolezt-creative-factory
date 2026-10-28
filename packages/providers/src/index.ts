import { DomainError } from "@koolezt/domain";
import type {
  CompositionProvider,
  CompositionOutput,
  CompositionMediaInput,
  CaptionTiming,
  RenderInputSnapshot,
  CreativeConceptProviderDraft,
  CreativeInputSnapshot,
  CreativeProvider,
  CreativeDnaAnalysisInput,
  StrategyProviderConceptDraft,
  StrategyGenerationInput,
  StrategyProviderResponse,
  MediaPayload,
  NarrationRewriteInput,
  ProviderJobStatus,
  ProviderOperationContext,
  ProviderSubmission,
  VideoGenerationProvider,
  VideoGenerationOutput,
  VoiceProvider,
  VariantCreativePackageDraft,
  VariantPackageGenerationInput,
  VideoPlanInput
} from "@koolezt/domain";
import { readFile } from "node:fs/promises";
export { ClaudeCreativeProvider, schemaViolation, toClaudeSchema } from "./claude-creative.js";
export type { ClaudeEffort } from "./claude-creative.js";
export { OpenAICreativeProvider } from "./openai-creative.js";
export { OPENAI_CREATIVE_INSTRUCTIONS, OPENAI_CREATIVE_PROMPT_VERSION, OPENAI_NARRATION_REWRITE_INSTRUCTIONS } from "./openai-creative-prompt.js";
export { OpenAIVoiceProvider, OPENAI_VOICE_DEFAULT_STYLE } from "./openai-voice.js";
export { OpenAIAudioTranscriber } from "./openai-transcription.js";
export { HttpMetaAdsGateway, metaAdMetrics, normalizeAdAccountId } from "./meta-ads.js";
export { ElevenLabsVoiceProvider, normalizeElevenLabsAlignment } from "./elevenlabs-voice.js";
export {
  CreatomateCompositionProvider,
  CreatomateOutputIngestor,
  HttpCreatomateTransport,
  buildKooleztUgcFastRenderScript,
  KOOLEZT_UGC_FAST_TEMPLATE_VERSION
} from "./creatomate-composition.js";
export {
  HttpKlingTransport,
  KlingOutputIngestor,
  KlingVideoGenerationProvider,
  buildKlingScenePrompt,
  KLING_SCENE_PROMPT_VERSION
} from "./kling-video.js";
export {
  HttpSeedanceTransport,
  SeedanceOutputIngestor,
  SeedanceVideoGenerationProvider,
  buildSeedanceScenePrompt,
  SEEDANCE_SCENE_PROMPT_VERSION
} from "./seedance-video.js";
export { RoutedVideoOutputIngestor, UnavailableVideoGenerationProvider } from "./video-provider-support.js";

const encoder = new TextEncoder();

function submission(
  provider: string,
  model: string,
  operationKey: string
): ProviderSubmission {
  return {
    providerTaskId: `${provider}-task-${operationKey}`,
    requestId: `${provider}-request-${operationKey}`,
    provider,
    model,
    metadata: { fake: true }
  };
}

export class FakeCreativeProvider implements CreativeProvider {
  readonly calls: ProviderOperationContext[] = [];
  readonly strategyRetrievals: string[] = [];
  private readonly strategyResponses = new Map<string, StrategyProviderResponse>();
  readonly conceptRetrievals: string[] = [];
  private readonly conceptResponses = new Map<string, StrategyProviderResponse>();
  readonly dnaRetrievals: string[] = [];
  private readonly dnaResponses = new Map<string, StrategyProviderResponse>();

  async generateConcept(
    input: CreativeInputSnapshot,
    context: ProviderOperationContext
  ): Promise<Readonly<{ concept: CreativeConceptProviderDraft; submission: ProviderSubmission }>> {
    this.calls.push(context);
    const referenceAssetIds = input.selectedAssets[0] ? [input.selectedAssets[0].id] : [];
    const referenceRoles = input.selectedAssets[0] ? ["PRIMARY_PRODUCT_REFERENCE"] : [];
    const execution = {
        completedPersonalizedVariantCount: input.selectedWinnerDna ? 3 : 0,
        completedVariantExamples: input.selectedWinnerDna ? [
          {sceneNumber:2,label:"Finished personalization A",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Pet portrait A"},{field:"House number",value:"102"},{field:"Street text",value:"Oak Street"}],productStructurePreserved:true},
          {sceneNumber:3,label:"Finished personalization B",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Pet portrait B"},{field:"House number",value:"245"},{field:"Street text",value:"Pine Avenue"}],productStructurePreserved:true},
          {sceneNumber:3,label:"Finished personalization C",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Pet portrait C"},{field:"House number",value:"318"},{field:"Street text",value:"Maple Road"}],productStructurePreserved:true}
        ] : [],
        targetDurationMs: 15_000,
        voiceScript: input.selectedStrategy ? `See ${input.selectedStrategy.conceptName} come together through personalized pet and address details, then compare multiple finished examples. ${input.defaultCta}.` : "We couldn't choose just one favorite, so we put the whole family on one personalized sign.",
        editingStyleKey: "UGC_FAST/v1",
        musicCategory: "UGC upbeat",
        scenes: [1, 2, 3].map((sceneNumber) => ({
          sceneNumber,
          intendedDurationMs: 5_000,
          purpose: sceneNumber === 1
              ? "Open with the finished product immediately visible and make the personalization hook clear"
              : sceneNumber === 2
                ? "Demonstrate pet plus address personalization with accurate product detail"
                : "Show multiple finished personalized examples and the current CTA",
          sourceType: "AI_VIDEO" as const,
          generationPrompt: `Scene ${sceneNumber}: vertical product-focused motion with the finished sign visible, using the supplied mockup without changing product details. ${sceneNumber===2?"Visually assemble pet artwork plus house number/address into the personalized sign.":sceneNumber===3?"Use a short gallery of multiple personalized sign variations with consistent product structure.":"Start on the finished personalized product in the first frame."}${input.selectedWinnerDna ? ` Apply approved execution DNA: ${input.selectedWinnerDna.preserveTraits.join("; ")}; do not copy historical scenes.` : ""}`,
          overlayText:
            sceneNumber === 1
              ? "ALL OF THEM?!"
              : sceneNumber === 2
                ? "MADE FOR YOUR HOME"
                : "CREATE YOURS",
          ...(input.selectedStrategy?{referenceRoles}:{referenceAssetIds}),
          accuracyRequirements: input.claims
            .filter((claim) => claim.kind === "RESTRICTION")
            .map((claim) => claim.text)
        }))
      };
    return {
      concept: input.selectedStrategy ? {...execution,strategyExecutionSummary:`Execute ${input.selectedStrategy.coreAngle} through an immediate finished-product opening, a pet-plus-number personalization demonstration, and multiple examples with ${input.defaultCta}.`} : {...execution,angle:"Personalization that includes the whole family",hook:"All of them—on one sign?",cta:input.defaultCta},
      submission: submission("fake-openai", "fake-structured-concept-v1", context.operationKey)
    };
  }

  async submitConceptExecution(input:CreativeInputSnapshot,context:ProviderOperationContext):Promise<StrategyProviderResponse>{
    const generated=await this.generateConcept(input,context);
    const response={responseId:`fake-concept-${context.operationKey}`,status:"completed" as const,provider:generated.submission.provider,model:generated.submission.model,outputText:JSON.stringify(generated.concept),usage:{inputTokens:100,outputTokens:200,totalTokens:300}};
    this.conceptResponses.set(response.responseId,response);
    return response;
  }

  async retrieveConceptExecution(responseId:string):Promise<StrategyProviderResponse>{
    this.conceptRetrievals.push(responseId);
    const response=this.conceptResponses.get(responseId);
    if(!response)throw new Error("Unknown fake Creative Concept response.");
    return response;
  }

  async submitStrategyConcepts(input: StrategyGenerationInput, context: ProviderOperationContext): Promise<StrategyProviderResponse> {
    this.calls.push(context);
    const families = ["Emotional keepsake","Personal identity","Gift discovery","Customization demo","Problem solution","Home belonging","Seasonal ritual","Multi-pet story","Design transformation","Proud owner signal","Memorial meaning","Simple creation"];
    const buyers = ["sentimental pet parent","proud breed owner","personalized-gift buyer","hands-on custom shopper","gift buyer seeking specificity","pet-parent homeowner","seasonal gift shopper","multi-pet household","visual design shopper","identity-driven pet owner","memorial keepsake buyer","time-conscious custom shopper"];
    const methods = ["AI_LIFESTYLE","AI_UGC_STYLE","PRODUCT_IMAGE_MOTION","PERSONALIZATION_DEMO","AI_BEFORE_AFTER","AI_CINEMATIC","MOTION_GRAPHICS","SEASONAL_AI"] as const;
    const ordinals = input.replacementOrdinals ?? Array.from({length:input.requestedCount},(_,index)=>index+1);
    const concepts = ordinals.map((ordinal):StrategyProviderConceptDraft=>{
      const candidate = methods[(ordinal-1)%methods.length]!;
      const primaryProductionMethod = !input.availableAssetCapabilities.includes("PRODUCT_IMAGE") && ["PRODUCT_IMAGE_MOTION","PERSONALIZATION_DEMO","AI_BEFORE_AFTER"].includes(candidate) ? "AI_LIFESTYLE" as const : candidate;
      return ({
      ordinal, conceptName:`${families[ordinal-1] ?? `Direction ${ordinal}`} concept`, conceptFamily:families[ordinal-1] ?? `Distinct family ${ordinal}`,
      buyerPersona:buyers[ordinal-1] ?? `purchase context ${ordinal}`, customerDesireOrProblem:`Distinct purchase motivation ${ordinal}`, awarenessLevel:["Problem aware","Solution aware","Product aware"][ordinal%3]!,
      coreAngle:`A distinct truthful angle focused on motivation ${ordinal}`, emotionalTerritory:["warmth","pride","delight","confidence","belonging","nostalgia"][ordinal%6]!, primaryPromise:`A personalized outcome framed for motivation ${ordinal}`,
      hook:`A distinct hook ${ordinal}`, openingVisualPattern:`Opening pattern ${ordinal} using supplied product visuals`, creativeFormat:`Format ${ordinal}`,
      primaryProductionMethod, supportingProductionMethods:[], proofMechanism:`Visual proof pattern ${ordinal}`, offerFraming:`Purchase framing ${ordinal}`, ctaStrategy:`Create the personalized version ${ordinal}`,
      differentiationSummary:`This direction differs through purchase context, opening pattern, proof, and emotional territory ${ordinal}.`,
      creativeVisualExecutionNotes:`Execute direction ${ordinal} with the selected references while preserving visible product details.`,
      ugcRepresentation:primaryProductionMethod==="AI_UGC_STYLE"?"AI_STYLE_NON_CUSTOMER":"NOT_APPLICABLE"
    });});
    const response = { responseId: `fake-response-${context.operationKey}`, status: "completed" as const, provider: "fake-openai", model: "fake-strategy-v1", outputText: JSON.stringify({ concepts }), usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } };
    this.strategyResponses.set(response.responseId, response);
    return response;
  }

  async retrieveStrategyConcepts(responseId: string): Promise<StrategyProviderResponse> {
    this.strategyRetrievals.push(responseId);
    const response = this.strategyResponses.get(responseId);
    if (!response) throw new Error("Unknown fake Strategy response.");
    return response;
  }

  async submitCreativeDnaAnalysis(input:CreativeDnaAnalysisInput,context:ProviderOperationContext):Promise<StrategyProviderResponse>{
    this.calls.push(context);const first=input.frames[0];const last=input.frames.at(-1);const draft={openingPattern:"Product-led opening",openingProductVisible:true,approximateProductRevealMs:0,visualHookMechanism:"Immediate product visibility",productProminence:"Product remains the visual hero",personalizationVisibility:"Personalization is shown visually",repeatedExamplePattern:"Multiple product examples reinforce variety",approximateExampleCount:3,pacingPattern:"Fast opening then steady demonstration",beatStructure:"Product hook → examples → personalization → CTA",overlayTextPattern:"Short, low-density direct-response overlays",offerVisibilityPattern:"Offer visibility is observed only as historical presentation, never current truth",ctaPattern:"Clear final direct CTA",proofPattern:"Visible product and personalization examples",visualFormat:"Vertical product showcase",lifestyleVsProductBalance:"Product-dominant",soundOffComprehension:"Core product and personalization remain understandable without audio",directResponsePattern:"Low-complexity product demonstration",closingPattern:"Product plus direct CTA",preserveTraits:["Immediate product visibility","Product prominence","Clear personalization","Simple direct CTA"],safeToVaryTraits:["Buyer motivation","Hook wording","Setting","Voiceover wording"],avoidTraits:[],sourceEvidence:[...(first?[{kind:"VISUAL_FRAME",observation:"Opening evidence frame",timestampMs:first.timestampMs,frameSha256:first.sha256}]:[]),...(last?[{kind:"VISUAL_FRAME",observation:"Closing evidence frame",timestampMs:last.timestampMs,frameSha256:last.sha256}]:[])]};
    const end=input.mediaMetadata.durationMs;const winnerReport={verdict:{summary:"Fake report: product-first opening with a clear spoken CTA.",reasons:[{title:"Product visible from frame one",explanation:"The finished product is on screen in the first frame.",confidence:"HIGH",evidence:[{source:"FRAME",detail:"Opening frame shows the product",timestampMs:first?.timestampMs??0,endTimestampMs:null}]}]},hook:{visualHook:"Product shown immediately",textHook:"",spokenHook:"",hookType:"PRODUCT_REVEAL",productFirstVisibleMs:0,whyItStops:"Immediate product clarity",strength:"STRONG"},angle:{coreAngle:"Personalized pride",buyerMotivation:"Make the home feel personal",desireOrProblem:"Generic decor",emotionalTriggers:["pride"],awarenessLevel:"PRODUCT_AWARE",promise:"A sign that is yours",proof:"Visual demonstration",offer:"",objectionsHandled:[],cta:"Customize yours",ctaTimestampMs:null},timeline:[{startMs:0,endMs:end,beat:"HOOK",visual:"Product in context",voiceLine:"",onScreenText:"",purpose:"Show the product"}],voice:{deliveryStyle:"Not assessed by the fake provider",scriptStructure:"",keyPhrases:[]},editing:{format:"Vertical",captionStyle:"",productProminence:"High",soundOffComprehension:"High",pacingAssessment:"Steady"},claimsCheck:[],performanceRead:"No performance figures were supplied.",nextCreativeBrief:{keep:["Product-first opening"],test:[{idea:"Open on a different home exterior",hypothesis:"Setting variety keeps attention",type:"VISUAL"}],avoid:["Historical offers"]}};
    const response={responseId:`fake-dna-${context.operationKey}`,status:"completed" as const,provider:"fake-openai",model:"fake-creative-dna-v1",outputText:JSON.stringify({...draft,winnerReport}),usage:{inputTokens:50,outputTokens:100,totalTokens:150}};this.dnaResponses.set(response.responseId,response);return response;
  }
  async planWinnerVideos(input: VideoPlanInput, context: ProviderOperationContext): Promise<Readonly<{ plans: readonly unknown[]; submission: ProviderSubmission }>> {
    this.calls.push(context);
    const seconds = Math.round(input.targetDurationMs / 1000);
    const motions = ["ZOOM_IN", "PAN_RIGHT", "ZOOM_OUT", "PAN_LEFT"];
    const plans = Array.from({ length: input.requestedCount }, (_, i) => ({
      title: `Variation ${i + 1}`, keepsFromWinner: "Keeps the product visible from the first second.", changes: `Tests hook ${i + 1}.`,
      hookText: `Hook number ${i + 1}`, voiceover: `This is fake voiceover number ${i + 1} for ${input.product.name}.`, ctaText: "Shop now",
      scenes: [0, 1, 2].map((s) => ({ photo: input.photos.length ? (s % input.photos.length) + 1 : 1, motion: motions[(i + s) % motions.length], caption: `Caption ${s + 1}`, seconds: seconds / 3, imagePrompt: `Use the attached product photo as the exact product. Fake scene ${s + 1}.`, videoPrompt: `Slow push-in, product stays still. Fake scene ${s + 1}.` }))
    }));
    return { plans, submission: { provider: "fake", model: "fake-video-plans-v1", providerTaskId: `fake-plans-${context.operationKey}`, requestId: `fake-plans-${context.operationKey}`, metadata: { operationKey: context.operationKey } } };
  }

  async retrieveCreativeDnaAnalysis(responseId:string):Promise<StrategyProviderResponse>{this.dnaRetrievals.push(responseId);const response=this.dnaResponses.get(responseId);if(!response)throw new Error("Unknown fake Creative DNA response.");return response;}

  async generateVariantPackages(input: VariantPackageGenerationInput, context: ProviderOperationContext): Promise<Readonly<{ packages: readonly VariantCreativePackageDraft[]; submission: ProviderSubmission }>> {
    this.calls.push(context);
    const angles = [
      ["Emotional keepsake", "Made for their spot", "Turn a favorite pet photo into a personalized Christmas ornament made to bring a smile every time you see the tree.", "Create your keepsake"],
      ["Personalized gift", "Their name, their ornament", "Add their photo and name to create a one-of-a-kind Christmas ornament that feels made just for your pet.", "Personalize yours"],
      ["Simple custom process", "Photo to ornament", "Choose a favorite photo, add their name, and preview a personalized ornament ready for your Christmas tree.", "Start your design"],
      ["Gift-worthy surprise", "A gift pet lovers keep", "Give pet lovers a personal Christmas ornament with their favorite face and name at the heart of the celebration.", "Make it personal"]
    ] as const;
    return { packages: angles.map(([angleName,hook,narrationText,cta],index)=>({slot:["A","B","C","D"][index] as "A"|"B"|"C"|"D",angleName,hook,narrationText,cta})), submission: submission("fake-openai", "fake-variant-copy-v1", context.operationKey) };
  }
  async rewriteNarration(input: NarrationRewriteInput, context: ProviderOperationContext): Promise<Readonly<{ script: string; submission: ProviderSubmission }>> {
    this.calls.push(context);
    return { script: input.script.trim(), submission: submission("fake-openai", "fake-narration-rewrite-v1", context.operationKey) };
  }
}

abstract class FakeAsyncMediaProvider<T = MediaPayload> {
  readonly submissions: ProviderOperationContext[] = [];
  protected readonly results = new Map<string, T>();

  protected remember(
    provider: string,
    model: string,
    context: ProviderOperationContext,
    payload: T
  ): ProviderSubmission {
    const submitted = submission(provider, model, context.operationKey);
    this.submissions.push(context);
    this.results.set(submitted.providerTaskId, payload);
    return submitted;
  }

  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<T>> {
    const result = this.results.get(providerTaskId);
    if (!result) {
      return { state: "FAILED", message: "Unknown fake provider task.", retryable: false };
    }
    return { state: "SUCCEEDED", result };
  }
}

export class FakeVideoGenerationProvider
  extends FakeAsyncMediaProvider<VideoGenerationOutput>
  implements VideoGenerationProvider
{
  readonly providerKey = "fake";
  readonly defaultModel = "fake-video-v1";
  readonly requiresExternalMedia = false;
  constructor(private readonly mp4FixturePath?: string) { super(); }
  async submit(
    input: Readonly<{
      sceneNumber: number;
      durationMs: number;
      prompt: string;
      sourceType: "AI_VIDEO" | "KLING_VIDEO" | "UPLOADED_VIDEO" | "PRODUCT_IMAGE" | "EXISTING_ASSET";
      referenceAssetIds: readonly string[];
      generationMode: "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO";
      model?: string;
      accuracyRequirements: readonly string[];
    }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission> {
    return this.remember("fake", input.model ?? this.defaultModel, context, { kind: "INLINE", payload: {
      bytes: this.mp4FixturePath ? await readFile(this.mp4FixturePath) : encoder.encode(`FAKE_SCENE_${input.sceneNumber}_${input.prompt}`), mimeType: "video/mp4", extension: "mp4", metadata: {
        fake: true,
        sceneNumber: input.sceneNumber,
        durationMs: input.durationMs,
        referenceAssetIds: input.referenceAssetIds,
        generationMode: input.generationMode,
        promptVersion: "fake-video-prompt/v1",
        width: 1080,
        height: 1920,
        hasVideo: true,
        hasAudio: false,
        videoCodec: "h264"
      }
    }});
  }
}

export class FakeVoiceProvider extends FakeAsyncMediaProvider implements VoiceProvider {
  constructor(private readonly audioFixturePath?: string) { super(); }
  async submit(
    input: Readonly<{ voiceProfileId: string; script: string }>,
    context: ProviderOperationContext
  ): Promise<ProviderSubmission> {
    return this.remember("fake-elevenlabs", "fake-voice-v1", context, {
      bytes: this.audioFixturePath ? await readFile(this.audioFixturePath) : encoder.encode(`FAKE_AUDIO_${input.voiceProfileId}_${input.script}`),
      mimeType: "audio/mpeg",
      extension: "mp3",
      metadata: { fake: true, voiceProfileId: input.voiceProfileId, captionTimings: input.script.split(/\s+/).filter(Boolean).map((text, index) => ({ text, startMs: index * 300, endMs: (index + 1) * 300 })) }
    });
  }
}

export class FakeCompositionProvider
  implements CompositionProvider
{
  readonly submissions: ProviderOperationContext[] = [];
  private readonly results = new Map<string, CompositionOutput>();
  private readonly polls = new Map<string, number>();
  constructor(private readonly mp4FixturePath?: string) {}

  async submit(
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
  ): Promise<ProviderSubmission> {
    const bytes = this.mp4FixturePath
      ? await readFile(this.mp4FixturePath)
      : encoder.encode(
        `FAKE_RENDER_NOT_A_REAL_MP4:${input.sceneAssets.map((asset) => asset.sha256).join(":")}:${input.narration.sha256}:${input.cta}`
      );
    const submitted = submission("fake-composition", "fake-render-v1", context.operationKey);
    this.submissions.push(context);
    this.results.set(submitted.providerTaskId, { kind: "INLINE", payload: {
      bytes,
      mimeType: "video/mp4",
      extension: "mp4",
      metadata: {
        fake: true,
        orchestrationOnly: true,
        width: input.target.width,
        height: input.target.height,
        durationMs: input.target.durationMs,
        hasVideo: true,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
        compositionStyleKey: input.compositionStyleKey,
        marketingOverlays: input.marketingOverlays,
        captionTimings: input.captionTimings
      }
    }});
    return submitted;
  }

  async getStatus(providerTaskId: string): Promise<ProviderJobStatus<CompositionOutput>> {
    const result = this.results.get(providerTaskId);
    if (!result) return { state: "FAILED", message: "Unknown fake composition task.", retryable: false };
    const polls = this.polls.get(providerTaskId) ?? 0;
    this.polls.set(providerTaskId, polls + 1);
    return polls === 0 ? { state: "PROCESSING" } : { state: "SUCCEEDED", result };
  }
}

/** Makes an explicitly selected paid composition provider fail safely before any network submission. */
export class UnavailableCompositionProvider implements CompositionProvider {
  readonly configurationError: Readonly<{ code: string; message: string }>;
  constructor(providerKey: string, code: string, message: string) { this.configurationError = { code, message: `${providerKey}: ${message}` }; }
  async submit(): Promise<ProviderSubmission> { throw new DomainError(this.configurationError.code, this.configurationError.message); }
  async getStatus(): Promise<ProviderJobStatus<CompositionOutput>> { throw new DomainError(this.configurationError.code, this.configurationError.message); }
}
