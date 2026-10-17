import OpenAI from "openai";
import { DomainError } from "@koolezt/domain";
import type { ConceptProviderResponse, CreativeConceptProviderDraft, CreativeDnaAnalysisInput, CreativeInputSnapshot, CreativeProvider, ExecutionFeasibilityPlan, NarrationRewriteInput, ProviderOperationContext, ProviderSubmission, StrategyGenerationInput, StrategyProviderResponse, VariantCreativePackageDraft, VariantPackageGenerationInput } from "@koolezt/domain";
import { OPENAI_CREATIVE_INSTRUCTIONS, OPENAI_CREATIVE_PROMPT_VERSION, OPENAI_NARRATION_REWRITE_INSTRUCTIONS } from "./openai-creative-prompt.js";

const sceneSchema = { type: "object", additionalProperties: false,
  required: ["sceneNumber", "intendedDurationMs", "purpose", "sourceType", "generationPrompt", "overlayText", "referenceAssetIds", "accuracyRequirements"],
  properties: { sceneNumber: { type: "integer", minimum: 1 }, intendedDurationMs: { type: "integer", minimum: 1 }, purpose: { type: "string", maxLength: 500 }, sourceType: { type: "string", enum: ["AI_VIDEO", "PRODUCT_IMAGE", "UPLOADED_VIDEO", "EXISTING_ASSET"] }, generationPrompt: { type: "string", maxLength: 4000 }, overlayText: { type: "string", maxLength: 300 }, referenceAssetIds: { type: "array", maxItems: 12, items: { type: "string" } }, accuracyRequirements: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } } }
} as const;
const strategySceneSchemaFor = (roles: readonly string[]) => ({ type: "object", additionalProperties: false,
  required: ["sceneNumber", "intendedDurationMs", "purpose", "sourceType", "generationPrompt", "overlayText", "referenceRoles", "accuracyRequirements"],
  properties: { sceneNumber: { type: "integer", minimum: 1 }, intendedDurationMs: { type: "integer", minimum: 1 }, purpose: { type: "string", maxLength: 500 }, sourceType: { type: "string", enum: ["AI_VIDEO", "PRODUCT_IMAGE", "UPLOADED_VIDEO", "EXISTING_ASSET"] }, generationPrompt: { type: "string", maxLength: 4000 }, overlayText: { type: "string", maxLength: 300 }, referenceRoles: { type: "array", maxItems: 12, items: { type: "string", enum: roles.length?roles:["NO_AUTHORIZED_REFERENCE"] } }, accuracyRequirements: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } } }
} as const);
const legacyConceptSchema = {
  type: "object", additionalProperties: false,
  required: ["angle", "hook", "targetDurationMs", "voiceScript", "cta", "editingStyleKey", "musicCategory", "scenes"],
  properties: {
    angle: { type: "string", maxLength: 600 }, hook: { type: "string", maxLength: 300 }, targetDurationMs: { type: "integer", minimum: 1 },
    voiceScript: { type: "string", maxLength: 5000 }, cta: { type: "string", maxLength: 300 }, editingStyleKey: { type: "string", maxLength: 120 }, musicCategory: { type: "string", maxLength: 120 },
    scenes: { type: "array", minItems: 3, maxItems: 3, items: sceneSchema }
  }
} as const;
const completedVariantExampleSchema={type:"object",additionalProperties:false,required:["sceneNumber","label","finishedProductVisible","personalizationValues","productStructurePreserved"],properties:{sceneNumber:{type:"integer",minimum:1,maximum:3},label:{type:"string",minLength:1,maxLength:120},finishedProductVisible:{type:"boolean"},personalizationValues:{type:"array",maxItems:12,items:{type:"object",additionalProperties:false,required:["field","value"],properties:{field:{type:"string",minLength:1,maxLength:120},value:{type:"string",minLength:1,maxLength:240}}}},productStructurePreserved:{type:"boolean"}}} as const;
const strategyExecutionSchemaFor = (roles: readonly string[]) => ({type:"object",additionalProperties:false,required:["strategyExecutionSummary","completedPersonalizedVariantCount","completedVariantExamples","targetDurationMs","voiceScript","editingStyleKey","musicCategory","scenes"],properties:{strategyExecutionSummary:{type:"string",minLength:1,maxLength:1000},completedPersonalizedVariantCount:{type:"integer",minimum:0,maximum:10},completedVariantExamples:{type:"array",maxItems:10,items:completedVariantExampleSchema},targetDurationMs:{type:"integer",minimum:1},voiceScript:{type:"string",maxLength:5000},editingStyleKey:{type:"string",maxLength:120},musicCategory:{type:"string",maxLength:120},scenes:{type:"array",minItems:3,maxItems:3,items:strategySceneSchemaFor(roles)}}} as const);

function referenceCatalog(input: CreativeInputSnapshot) {
  return input.selectedAssets.map((asset,index)=>({role:index===0?"PRIMARY_PRODUCT_REFERENCE":`PRODUCT_REFERENCE_${index+1}`,kind:asset.kind,label:asset.label,mimeType:asset.mimeType}));
}
function strategyProviderInput(input: CreativeInputSnapshot) {
  return {...input,selectedAssets:referenceCatalog(input)};
}

const finishedVariationInstructions="\nWhen the resolved Execution Feasibility Plan or selected Winner DNA requires repeated personalized Product examples, plan and report AT LEAST TWO visibly distinct COMPLETED personalized Product results (prefer three when duration supports it). Populate completedPersonalizedVariantCount and completedVariantExamples with the finished results actually visible in the scenes. For each result, list concrete values for the operator-authorized personalization fields that differ. A selection card, input tile, assembly arrow, UI state, the same finished sign in another room/background/camera angle, or an input state followed by the same final sign does NOT count. Each counted result must visibly be a finished Product, preserve the same Product/SKU silhouette, orientation, geometry, layout architecture, and proportions, and vary only fields explicitly allowed by personalizationVisualAuthority. Preserve mounting configuration unless an exact configuration is listed in personalizationVisualAuthority.authorizedProductConfigurations and independently supported by a current verified Product claim. Authorized Product configurations are not personalization fields: use only the named configurations and do not invent or combine structural features. If repeated finished variations are not required, return zero and an empty array.";
const strategyTerritoryInstructions="\nThe selected Strategy defines the EXCLUSIVE advertising territory. Do not introduce another purchase occasion, emotional territory, or marketing angle unless it is explicitly present in selectedStrategy. Product description, creative notes, reference imagery, and historical Winner context may mention other possible uses; they do NOT authorize Strategy territory. In every scene, narration line, overlay, strategyExecutionSummary, musicCategory, and mood, exclude gifting, gift boxes, pet-lover gifts, holiday, Christmas, festive occasions, housewarming, moving, memorial, sympathy, birthdays, Mother's Day, Father's Day, and generic curb appeal unless selectedStrategy explicitly contains that territory. Use neutral Strategy-compatible music and mood derived from selectedStrategy; do not use festive, Christmas, holiday, gift-opening, or memorial cues without explicit Strategy authority. When selected Winner DNA requires an installed finished-Product opening, Scene 1 must show the finished Product visibly mounted or installed from frame one in its normal home-entry exterior use context, such as beside a front door, on an exterior entry wall, or near a porch/entryway. Product visibility alone is insufficient. Do not substitute a gift box, wrapped gift, tabletop display, unboxing, loose décor placement, holiday arrangement, creator-held Product, or other non-installed context.";

const variantPackageSchema = {
  type: "object", additionalProperties: false, required: ["packages"],
  properties: { packages: { type: "array", minItems: 4, maxItems: 4, items: { type: "object", additionalProperties: false,
    required: ["slot", "angleName", "hook", "narrationText", "cta", "secondaryOverlay"],
    properties: { slot: { type: "string", enum: ["A", "B", "C", "D"] }, angleName: { type: "string", minLength: 1, maxLength: 160 }, hook: { type: "string", minLength: 1, maxLength: 160 }, narrationText: { type: "string", minLength: 1, maxLength: 10000 }, cta: { type: "string", minLength: 1, maxLength: 160 }, secondaryOverlay: { type: "string", maxLength: 160 } }
  } } }
} as const;
const narrationRewriteSchema = {
  type: "object", additionalProperties: false, required: ["script"],
  properties: { script: { type: "string", minLength: 1, maxLength: 10_000 } }
} as const;
const strategyConceptSchema = { type:"object", additionalProperties:false, required:["ordinal","conceptName","conceptFamily","buyerPersona","customerDesireOrProblem","awarenessLevel","coreAngle","emotionalTerritory","primaryPromise","hook","openingVisualPattern","creativeFormat","primaryProductionMethod","supportingProductionMethods","proofMechanism","offerFraming","ctaStrategy","differentiationSummary","creativeVisualExecutionNotes","ugcRepresentation"], properties:{
  ordinal:{type:"integer",minimum:1,maximum:12}, conceptName:{type:"string",minLength:1,maxLength:120}, conceptFamily:{type:"string",minLength:1,maxLength:80}, buyerPersona:{type:"string",minLength:1,maxLength:160}, customerDesireOrProblem:{type:"string",minLength:1,maxLength:500}, awarenessLevel:{type:"string",minLength:1,maxLength:80}, coreAngle:{type:"string",minLength:1,maxLength:600}, emotionalTerritory:{type:"string",minLength:1,maxLength:160}, primaryPromise:{type:"string",minLength:1,maxLength:500}, hook:{type:"string",minLength:1,maxLength:200}, openingVisualPattern:{type:"string",minLength:1,maxLength:500}, creativeFormat:{type:"string",minLength:1,maxLength:120}, primaryProductionMethod:{type:"string",enum:["AI_LIFESTYLE","AI_UGC_STYLE","PRODUCT_IMAGE_MOTION","PERSONALIZATION_DEMO","AI_BEFORE_AFTER","AI_CINEMATIC","MOTION_GRAPHICS","SEASONAL_AI"]}, supportingProductionMethods:{type:"array",maxItems:3,items:{type:"string",enum:["AI_LIFESTYLE","AI_UGC_STYLE","PRODUCT_IMAGE_MOTION","PERSONALIZATION_DEMO","AI_BEFORE_AFTER","AI_CINEMATIC","MOTION_GRAPHICS","SEASONAL_AI"]}}, proofMechanism:{type:"string",minLength:1,maxLength:500}, offerFraming:{type:"string",minLength:1,maxLength:400}, ctaStrategy:{type:"string",minLength:1,maxLength:300}, differentiationSummary:{type:"string",minLength:1,maxLength:700}, creativeVisualExecutionNotes:{type:"string",minLength:1,maxLength:700}, ugcRepresentation:{type:"string",enum:["NOT_APPLICABLE","AI_STYLE_NON_CUSTOMER","REAL_SUPPLIED_TESTIMONIAL"]}
} } as const;
const strategySchema = { type:"object", additionalProperties:false, required:["concepts"], properties:{ concepts:{type:"array",minItems:1,maxItems:12,items:strategyConceptSchema} } } as const;
const strategySchemaFor = (count: number) => ({
  ...strategySchema,
  properties: { concepts: { ...strategySchema.properties.concepts, minItems: count, maxItems: count } }
});
const evidenceSchema={type:"object",additionalProperties:false,required:["kind","observation","timestampMs","endTimestampMs","frameSha256"],properties:{kind:{type:"string",enum:["VISUAL_FRAME","MEDIA_METADATA","VISIBLE_TEXT","OPERATOR_TRANSCRIPT","OPERATOR_NOTE"]},observation:{type:"string",minLength:1,maxLength:500},timestampMs:{type:["integer","null"],minimum:0},endTimestampMs:{type:["integer","null"],minimum:0},frameSha256:{type:["string","null"],maxLength:64}}} as const;
const dnaSchema={type:"object",additionalProperties:false,required:["openingPattern","openingProductVisible","approximateProductRevealMs","visualHookMechanism","productProminence","personalizationVisibility","repeatedExamplePattern","approximateExampleCount","pacingPattern","beatStructure","overlayTextPattern","offerVisibilityPattern","ctaPattern","proofPattern","visualFormat","lifestyleVsProductBalance","soundOffComprehension","directResponsePattern","closingPattern","preserveTraits","safeToVaryTraits","avoidTraits","sourceEvidence"],properties:{openingPattern:{type:"string",maxLength:500},openingProductVisible:{type:"boolean"},approximateProductRevealMs:{type:["integer","null"],minimum:0},visualHookMechanism:{type:"string",maxLength:500},productProminence:{type:"string",maxLength:500},personalizationVisibility:{type:"string",maxLength:500},repeatedExamplePattern:{type:"string",maxLength:500},approximateExampleCount:{type:["integer","null"],minimum:0},pacingPattern:{type:"string",maxLength:500},beatStructure:{type:"string",maxLength:700},overlayTextPattern:{type:"string",maxLength:500},offerVisibilityPattern:{type:"string",maxLength:500},ctaPattern:{type:"string",maxLength:500},proofPattern:{type:"string",maxLength:500},visualFormat:{type:"string",maxLength:300},lifestyleVsProductBalance:{type:"string",maxLength:500},soundOffComprehension:{type:"string",maxLength:500},directResponsePattern:{type:"string",maxLength:500},closingPattern:{type:"string",maxLength:500},preserveTraits:{type:"array",maxItems:12,items:{type:"string",maxLength:300}},safeToVaryTraits:{type:"array",maxItems:12,items:{type:"string",maxLength:300}},avoidTraits:{type:"array",maxItems:12,items:{type:"string",maxLength:300}},sourceEvidence:{type:"array",maxItems:30,items:evidenceSchema}}} as const;
const strategyModeInstructions = {
  3: "Prioritize maximum separation across three major advertising territories; do not spend a slot on a small variation.",
  6: "Produce a broad, practical set of six territories that differ across motivation, awareness, emotion, opening, format, production, proof, occasion, and offer framing.",
  12: "Explore twelve broad and deeper sub-territories while rejecting wording-only variations of the same emotional message."
} as const;
export class OpenAICreativeProvider implements CreativeProvider {
  private readonly client: OpenAI;
  constructor(private readonly config: Readonly<{ apiKey: string; model: string; resolveReferenceUrl?: (assetId: string) => Promise<string>; strategyTransportTimeoutMs?: number; conceptTransportTimeoutMs?: number }>, client?: OpenAI) {
    if (!config.apiKey) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_API_KEY is required when CREATIVE_PROVIDER=openai.");
    if (!config.model) throw new DomainError("OPENAI_CONFIGURATION_MISSING", "OPENAI_CREATIVE_MODEL is required when CREATIVE_PROVIDER=openai.");
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: 30_000 });
  }

  async generateConcept(input: CreativeInputSnapshot, context: ProviderOperationContext): Promise<Readonly<{ concept: CreativeConceptProviderDraft; submission: ProviderSubmission }>> {
    try {
      const referenceImages = this.config.resolveReferenceUrl
        ? await Promise.all(input.selectedAssets
            .filter((asset) => asset.kind === "IMAGE")
            .map(async (asset) => ({ type: "input_image" as const, image_url: await this.config.resolveReferenceUrl!(asset.id), detail: "auto" as const })))
        : [];
      const references=referenceCatalog(input);
      const requestInput = { promptVersion: OPENAI_CREATIVE_PROMPT_VERSION, operationKey: context.operationKey,
        projectId: context.projectId, targetId: context.targetId, product: input.selectedStrategy?strategyProviderInput(input):input };

      const response = await this.client.responses.create({
        model: this.config.model,
        store: false,
        instructions: `${OPENAI_CREATIVE_INSTRUCTIONS}${input.selectedStrategy ? "\nThe selectedStrategy object is read-only authority. Do not return or rewrite its core angle, strategic hook, or CTA strategy. Return only execution decisions and a strategyExecutionSummary explaining how the scenes implement it. Scene overlays and narration may paraphrase the strategic hook but must preserve its proposition. The application injects canonical angle, hook, and current CTA after validation. Visual personalization MAY-VARY permissions authorize generated visual differences only; they do not authorize consumer-facing claims about selection, upload, submission, breed catalogs, or pet-photo artwork. Do not describe personalization options or capabilities unless exact authoritative Product claims support them." : ""}${input.selectedWinnerDna ? "\nThe selected Strategy remains authoritative for buyer context, reason to buy, angle, emotion, promise, proof strategy, offer framing, hook, and CTA intent. Current Product claims remain the only factual authority and selected Product references remain the only visual authority. Use selectedWinnerDna only for execution tendencies such as opening, reveal timing, product prominence, pacing, repeated examples, overlay simplicity, personalization demonstration, and closing. Preserve approved preserveTraits where compatible, vary safeToVaryTraits, and do not copy the historical ad scene-for-scene. Historical offer text, price, claims, and performance are never current Product truth." : ""}${input.selectedStrategy?strategyTerritoryInstructions+finishedVariationInstructions:""}`,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(requestInput) }, ...referenceImages] }],
        text: { format: { type: "json_schema", name: input.selectedStrategy ? "koolezt_creative_execution" : "koolezt_creative_concept", strict: true, schema: input.selectedStrategy ? strategyExecutionSchemaFor(references.map(item=>item.role)) : legacyConceptSchema } }
      });
      if (response.status !== "completed" || !response.output_text) throw new DomainError("OPENAI_STRUCTURED_RESPONSE_INVALID", "OpenAI did not return a completed structured creative concept.");
      let concept: CreativeConceptProviderDraft;
      try { concept = JSON.parse(response.output_text) as CreativeConceptProviderDraft; } catch { throw new DomainError("OPENAI_STRUCTURED_RESPONSE_INVALID", "OpenAI returned malformed structured concept data."); }
      return { concept, submission: { provider: "openai", model: response.model, providerTaskId: response.id, requestId: response.id, metadata: { promptVersion: OPENAI_CREATIVE_PROMPT_VERSION, operationKey: context.operationKey, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } } };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 401 || status === 403) throw new DomainError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication was rejected.");
      if (status === 429) throw new DomainError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached; retry later.");
      if (status >= 500) throw new DomainError("OPENAI_UNAVAILABLE", "OpenAI is temporarily unavailable.");
      throw new DomainError("OPENAI_REQUEST_FAILED", "OpenAI concept generation failed.");
    }
  }

  private conceptResponse(response: Readonly<{ id:string; status?:string; model:unknown; output_text?:string; usage?:{input_tokens?:number;output_tokens?:number;total_tokens?:number}|null; error?:{code?:string|null;message?:string}|null; incomplete_details?:{reason?:string}|null }>):ConceptProviderResponse {
    const status=response.status;
    if(!status||!["queued","in_progress","completed","failed","cancelled","incomplete"].includes(status))throw new DomainError("OPENAI_CONCEPT_STATUS_INVALID","OpenAI returned an unknown Creative Concept response status.");
    const safeMessage=response.error?.message??response.incomplete_details?.reason;
    return {responseId:response.id,status:status as ConceptProviderResponse["status"],provider:"openai",model:String(response.model),...(response.output_text?{outputText:response.output_text}:{}),...(response.usage?{usage:{...(response.usage.input_tokens!==undefined?{inputTokens:response.usage.input_tokens}:{}),...(response.usage.output_tokens!==undefined?{outputTokens:response.usage.output_tokens}:{}),...(response.usage.total_tokens!==undefined?{totalTokens:response.usage.total_tokens}:{})}}:{}),...(safeMessage?{safeError:{...(response.error?.code?{code:response.error.code}:{}),message:safeMessage.slice(0,500)}}:{})};
  }

  async submitConceptExecution(input:CreativeInputSnapshot,context:ProviderOperationContext,feasibilityPlan?:ExecutionFeasibilityPlan):Promise<ConceptProviderResponse>{
    if(!input.selectedStrategy)throw new DomainError("BACKGROUND_CONCEPT_REQUIRES_STRATEGY","Background Creative Concept execution is limited to Strategy-linked projects.");
    try{
      const referenceImages=this.config.resolveReferenceUrl?await Promise.all(input.selectedAssets.filter(asset=>asset.kind==="IMAGE").map(async asset=>({type:"input_image" as const,image_url:await this.config.resolveReferenceUrl!(asset.id),detail:"auto" as const}))):[];
      const references=referenceCatalog(input);
      const response=await this.client.responses.create({
        model:this.config.model,store:false,background:true,
        instructions:`${OPENAI_CREATIVE_INSTRUCTIONS}\nThe selectedStrategy object is read-only authority. Do not return or rewrite its core angle, strategic hook, or CTA strategy. Return only execution decisions and a strategyExecutionSummary explaining how the scenes implement it. Scene overlays and narration may paraphrase the strategic hook but must preserve its proposition. The application injects canonical angle, hook, and current CTA after validation. Visual references are application-owned: select only from the supplied reference role catalog and return referenceRoles, never asset IDs, UUIDs, URLs, or other canonical identifiers. The application resolves each role to the immutable snapshot asset after generation. Visual personalization MAY-VARY permissions authorize generated visual differences only; they do not authorize consumer-facing claims about selection, upload, submission, breed catalogs, or pet-photo artwork. Do not describe personalization options or capabilities unless exact authoritative Product claims support them.${input.selectedWinnerDna?"\nThe selected Strategy remains authoritative for buyer context, reason to buy, angle, emotion, promise, proof strategy, offer framing, hook, and CTA intent. Current Product claims remain the only factual authority and selected Product references remain the only visual authority. Use selectedWinnerDna only for execution tendencies such as opening, reveal timing, product prominence, pacing, repeated examples, overlay simplicity, personalization demonstration, and closing. Preserve approved preserveTraits where compatible, vary safeToVaryTraits, and do not copy the historical ad scene-for-scene. Historical offer text, price, claims, and performance are never current Product truth.":""}${strategyTerritoryInstructions}${finishedVariationInstructions}`,
        input:[{role:"user",content:[{type:"input_text",text:JSON.stringify({promptVersion:OPENAI_CREATIVE_PROMPT_VERSION,product:strategyProviderInput(input),executionFeasibilityPlan:feasibilityPlan})},...referenceImages]}],
        text:{format:{type:"json_schema",name:"koolezt_creative_execution",strict:true,schema:strategyExecutionSchemaFor(references.map(item=>item.role))}}
      },{timeout:this.config.conceptTransportTimeoutMs??30_000});
      return this.conceptResponse(response);
    }catch(error){
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===400)throw new DomainError("OPENAI_CONCEPT_INVALID","OpenAI rejected the bounded Creative Concept request.");
      if(status===401||status===403)throw new DomainError("OPENAI_AUTHENTICATION_FAILED","OpenAI authentication was rejected.");
      if(status===429)throw new DomainError("OPENAI_RATE_LIMITED","OpenAI rate limit reached; retry only by explicit operator action.");
      throw new DomainError("OPENAI_CONCEPT_SUBMISSION_UNKNOWN","OpenAI Creative Concept submission outcome is unknown; do not retry automatically.");
    }
  }

  async retrieveConceptExecution(responseId:string):Promise<ConceptProviderResponse>{
    try{return this.conceptResponse(await this.client.responses.retrieve(responseId,{}, {timeout:this.config.conceptTransportTimeoutMs??30_000}));}
    catch(error){
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===404||status===410)throw new DomainError("OPENAI_CONCEPT_RESULT_UNAVAILABLE","The known OpenAI Creative Concept response is no longer retrievable; it will not be resubmitted.");
      if(status===401||status===403)throw new DomainError("OPENAI_AUTHENTICATION_FAILED","OpenAI authentication was rejected while retrieving the known Creative Concept response.");
      throw new Error("OpenAI Creative Concept response retrieval temporarily failed.");
    }
  }

  private strategyResponse(response: Readonly<{ id: string; status?: string; model: unknown; output_text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null; error?: { code?: string | null; message?: string } | null; incomplete_details?: { reason?: string } | null }>): StrategyProviderResponse {
    const status = response.status;
    if (!status || !["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"].includes(status)) {
      throw new DomainError("OPENAI_STRATEGY_STATUS_INVALID", "OpenAI returned an unknown Strategy response status.");
    }
    const safeMessage = response.error?.message ?? response.incomplete_details?.reason;
    return {
      responseId: response.id,
      status: status as StrategyProviderResponse["status"],
      provider: "openai",
      model: String(response.model),
      ...(response.output_text ? { outputText: response.output_text } : {}),
      ...(response.usage ? { usage: {
        ...(response.usage.input_tokens !== undefined ? { inputTokens: response.usage.input_tokens } : {}),
        ...(response.usage.output_tokens !== undefined ? { outputTokens: response.usage.output_tokens } : {}),
        ...(response.usage.total_tokens !== undefined ? { totalTokens: response.usage.total_tokens } : {})
      } } : {}),
      ...(safeMessage ? { safeError: { ...(response.error?.code ? { code: response.error.code } : {}), message: safeMessage.slice(0, 500) } } : {})
    };
  }

  async submitStrategyConcepts(input: StrategyGenerationInput, context: ProviderOperationContext): Promise<StrategyProviderResponse> {
    try {
      const referenceImages = this.config.resolveReferenceUrl
        ? await Promise.all(input.selectedAssets.filter((asset) => asset.kind === "IMAGE").map(async (asset) => ({ type: "input_image" as const, image_url: await this.config.resolveReferenceUrl!(asset.id), detail: "auto" as const })))
        : [];
      const expectedCount = input.replacementOrdinals?.length ?? input.requestedCount;
      const mode = input.requestedCount === 3 ? "Quick" : input.requestedCount === 6 ? "Standard" : "Explore";
      const response = await this.client.responses.create({ model:this.config.model, store:false, background:true,
        instructions:`Generate exactly ${expectedCount} requested Creative Strategy slots for a ${mode} short-form advertising exploration. ${strategyModeInstructions[input.requestedCount]} Strategy dimensions must be meaningfully different, not wording variants. buyerPersona means purchase context or motivation, never inferred age, gender, income, ethnicity, or other demographics. Verified claims, authority-tagged constraints, reference-visual boundaries, production capabilities, and prior same-Product creative history in the input are read-only context controlled by the application. Do not output, rewrite, classify, or invent product-truth constraints, visual-fidelity requirements, or real-asset capability requirements. Put non-authoritative visual ideas only in creativeVisualExecutionNotes. Reference images establish visual evidence only and never material, durability, manufacturing, packaging, shipping, discount, or customer-review claims. Use AI-executable production. Do not require real filming unless a supplied capability supports it. AI UGC may use creator-style language but cannot fabricate a customer testimonial. When replacementOrdinals are supplied, return exactly those ordinals and preserve the supplied good concepts. Return structured data only.`,
        input:[{role:"user",content:[{type:"input_text",text:JSON.stringify({operationKey:context.operationKey,projectId:context.projectId,targetId:context.targetId,strategy:input})},...referenceImages]}],
        text:{format:{type:"json_schema",name:"koolezt_creative_strategy",strict:true,schema:strategySchemaFor(expectedCount)}}
      }, { timeout: this.config.strategyTransportTimeoutMs ?? 30_000 });
      return this.strategyResponse(response);
    } catch(error) {
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===400)throw new DomainError("OPENAI_STRATEGY_INVALID","OpenAI rejected the bounded strategy request.");
      if(status===401||status===403)throw new DomainError("OPENAI_AUTHENTICATION_FAILED","OpenAI authentication was rejected.");
      if(status===429)throw new DomainError("OPENAI_RATE_LIMITED","OpenAI rate limit reached; retry only by explicit operator action.");
      throw new DomainError("OPENAI_STRATEGY_SUBMISSION_UNKNOWN","OpenAI strategy generation outcome is unknown; do not retry automatically.");
    }
  }

  async retrieveStrategyConcepts(responseId: string): Promise<StrategyProviderResponse> {
    try {
      const response = await this.client.responses.retrieve(responseId, {}, { timeout: this.config.strategyTransportTimeoutMs ?? 30_000 });
      return this.strategyResponse(response);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 404 || status === 410) throw new DomainError("OPENAI_STRATEGY_RESULT_UNAVAILABLE", "The known OpenAI Strategy response is no longer retrievable; it will not be submitted again automatically.");
      if (status === 401 || status === 403) throw new DomainError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication was rejected while retrieving the known Strategy response.");
      throw new Error("OpenAI Strategy response retrieval temporarily failed.");
    }
  }

  async submitCreativeDnaAnalysis(input:CreativeDnaAnalysisInput,context:ProviderOperationContext):Promise<StrategyProviderResponse>{
    try {
      const safeInput={
        ...input,
        frames:input.frames.map((frame)=>({timestampMs:frame.timestampMs,mimeType:frame.mimeType,sha256:frame.sha256})),
        ...(input.performance?{performance:{...input.performance,historicalContextOnly:true}}:{}),
        ...(input.currentProduct?{currentProduct:{...input.currentProduct,authority:"CURRENT_PRODUCT_TRUTH_READ_ONLY"}}:{})
      };
      const images=input.frames.map(frame=>({type:"input_image" as const,image_url:`data:${frame.mimeType};base64,${frame.bytesBase64}`,detail:"high" as const}));
      const response=await this.client.responses.create({
        model:this.config.model,store:false,background:true,
        instructions:"Analyze only observable execution characteristics of this historical advertisement. Return Creative DNA, not Product truth and not a quality score. Historical prices, discounts, claims, offers, reviews, packaging, materials, shipping, and performance are historical context only and must never be declared current. Cite supplied frame timestamps/hashes where practical. Do not infer speech when no operator transcript is supplied. Preserve candidates are execution principles; safe-to-vary traits include strategic territory where appropriate. Do not recommend copying scenes verbatim. Return structured data only.",
        input:[{role:"user",content:[{type:"input_text",text:JSON.stringify({operationKey:context.operationKey,reference:safeInput})},...images]}],
        text:{format:{type:"json_schema",name:"koolezt_creative_dna",strict:true,schema:dnaSchema}}
      },{timeout:this.config.strategyTransportTimeoutMs??30000});
      return this.strategyResponse(response);
    } catch(error) {
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===401||status===403)throw new DomainError("OPENAI_AUTHENTICATION_FAILED","OpenAI authentication was rejected.");
      if(status===429)throw new DomainError("OPENAI_RATE_LIMITED","OpenAI rate limit reached; retry only by explicit operator action.");
      throw new DomainError("OPENAI_DNA_SUBMISSION_UNKNOWN","Creative DNA submission outcome is unknown; do not retry automatically.");
    }
  }
  async retrieveCreativeDnaAnalysis(responseId:string):Promise<StrategyProviderResponse>{
    try{return this.strategyResponse(await this.client.responses.retrieve(responseId,{}, {timeout:this.config.strategyTransportTimeoutMs??30000}));}
    catch(error){
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===404||status===410)throw new DomainError("OPENAI_DNA_RESULT_UNAVAILABLE","The known Creative DNA response is no longer retrievable; it will not be resubmitted.");
      throw new Error("OpenAI Creative DNA response retrieval temporarily failed.");
    }
  }

  async generateVariantPackages(input: VariantPackageGenerationInput, context: ProviderOperationContext): Promise<Readonly<{ packages: readonly VariantCreativePackageDraft[]; submission: ProviderSubmission }>> {
    try {
      const response = await this.client.responses.create({
        model: this.config.model, store: false,
        instructions: "Create exactly four substantively different, truthful Meta-ad creative packages. Each package must use a distinct relevant advertising angle. Hooks must be concise 3–8 word overlay copy, narration must be natural spoken copy fitted to the requested duration, CTA must be short. Use an empty string for secondaryOverlay when no secondary overlay is needed. Do not invent prices, discounts, guarantees, shipping, or unsupported product claims. Return structured data only.",
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, context: input }) }] }],
        text: { format: { type: "json_schema", name: "koolezt_variant_packages", strict: true, schema: variantPackageSchema } }
      });
      if (response.status !== "completed" || !response.output_text) throw new DomainError("OPENAI_VARIANT_COPY_INVALID", "OpenAI did not return four creative packages.");
      const parsed = JSON.parse(response.output_text) as { packages?: VariantCreativePackageDraft[] };
      const packages = (parsed.packages ?? []).map(({ secondaryOverlay, ...item }) => ({ ...item, ...(secondaryOverlay?.trim() ? { secondaryOverlay: secondaryOverlay.trim() } : {}) }));
      const slots = packages.map(item => item.slot).sort().join("");
      if (packages.length !== 4 || slots !== "ABCD" || packages.some(item => !item.angleName.trim() || !item.hook.trim() || !item.narrationText.trim() || !item.cta.trim())) throw new DomainError("OPENAI_VARIANT_COPY_INVALID", "OpenAI returned incomplete creative packages.");
      return { packages, submission: { provider: "openai", model: response.model, providerTaskId: response.id, requestId: response.id, metadata: { promptVersion: "variant-copy/v2", operationKey: context.operationKey, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } } };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 400) throw new DomainError("OPENAI_VARIANT_COPY_REQUEST_INVALID", "OpenAI rejected the creative-package request; no packages were created.");
      if (status === 401 || status === 403) throw new DomainError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication was rejected.");
      if (status === 429) throw new DomainError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached; retry later.");
      if (status >= 500) throw new DomainError("OPENAI_UNAVAILABLE", "OpenAI is temporarily unavailable.");
      throw new DomainError("OPENAI_VARIANT_COPY_SUBMISSION_UNKNOWN", "OpenAI creative-package generation outcome is unknown; do not retry automatically.");
    }
  }  async rewriteNarration(input: NarrationRewriteInput, context: ProviderOperationContext): Promise<Readonly<{ script: string; submission: ProviderSubmission }>> {
    try {
      const response = await this.client.responses.create({
        model: this.config.model,
        store: false,
        instructions: OPENAI_NARRATION_REWRITE_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ operationKey: context.operationKey, projectId: context.projectId, targetId: context.targetId, narration: input }) }] }],
        text: { format: { type: "json_schema", name: "koolezt_narration_rewrite", strict: true, schema: narrationRewriteSchema } }
      });
      if (response.status !== "completed" || !response.output_text) throw new DomainError("OPENAI_NARRATION_REWRITE_INVALID", "OpenAI did not return a completed narration rewrite.");
      let parsed: { script?: unknown };
      try { parsed = JSON.parse(response.output_text) as { script?: unknown }; } catch { throw new DomainError("OPENAI_NARRATION_REWRITE_INVALID", "OpenAI returned malformed narration rewrite data."); }
      const script = typeof parsed.script === "string" ? parsed.script.trim() : "";
      if (!script) throw new DomainError("OPENAI_NARRATION_REWRITE_INVALID", "OpenAI returned an empty narration rewrite.");
      return { script, submission: { provider: "openai", model: response.model, providerTaskId: response.id, requestId: response.id, metadata: { promptVersion: "narration-rewrite/v1", operationKey: context.operationKey, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } } };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 401 || status === 403) throw new DomainError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication was rejected.");
      if (status === 429) throw new DomainError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached; retry later.");
      if (status >= 500) throw new DomainError("OPENAI_UNAVAILABLE", "OpenAI is temporarily unavailable.");
      // This explicit text action is billable; an ambiguous transport result is never retried here.
      throw new DomainError("OPENAI_NARRATION_REWRITE_SUBMISSION_UNKNOWN", "OpenAI narration rewrite outcome is unknown; do not retry automatically.");
    }
  }
}

export { legacyConceptSchema as openAiCreativeConceptSchema, strategyExecutionSchemaFor as openAiCreativeExecutionSchemaFor };
