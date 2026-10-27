import OpenAI from "openai";
import { DomainError } from "@koolezt/domain";
import type { ConceptProviderResponse, CreativeConceptProviderDraft, CreativeDnaAnalysisInput, CreativeInputSnapshot, CreativeProvider, ExecutionFeasibilityPlan, NarrationRewriteInput, ProviderOperationContext, ProviderSubmission, StrategyGenerationInput, StrategyProviderResponse, VariantCreativePackageDraft, VariantPackageGenerationInput } from "@koolezt/domain";
import { OPENAI_CREATIVE_INSTRUCTIONS, OPENAI_CREATIVE_PROMPT_VERSION, OPENAI_NARRATION_REWRITE_INSTRUCTIONS } from "./openai-creative-prompt.js";
import { backgroundConceptInstructions, conceptInstructions, DNA_ANALYSIS_INSTRUCTIONS, dnaSchema, legacyConceptSchema, narrationRewriteSchema, referenceCatalog, strategyExecutionSchemaFor, strategyInstructions, strategyProviderInput, strategySchemaFor, VARIANT_PACKAGE_INSTRUCTIONS, variantPackageSchema } from "./creative-contract.js";

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
        instructions: conceptInstructions(OPENAI_CREATIVE_INSTRUCTIONS, input),
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
        instructions:backgroundConceptInstructions(OPENAI_CREATIVE_INSTRUCTIONS,input),
        input:[{role:"user",content:[{type:"input_text",text:JSON.stringify({promptVersion:OPENAI_CREATIVE_PROMPT_VERSION,product:strategyProviderInput(input),executionFeasibilityPlan:feasibilityPlan})},...referenceImages]}],
        text:{format:{type:"json_schema",name:"koolezt_creative_execution",strict:true,schema:strategyExecutionSchemaFor(references.map(item=>item.role))}}
      },{timeout:this.config.conceptTransportTimeoutMs??30_000});
      return this.conceptResponse(response);
    }catch(error){
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===400)throw new DomainError("PROVIDER_CONCEPT_INVALID","OpenAI rejected the bounded Creative Concept request.");
      if(status===401||status===403)throw new DomainError("OPENAI_AUTHENTICATION_FAILED","OpenAI authentication was rejected.");
      if(status===429)throw new DomainError("OPENAI_RATE_LIMITED","OpenAI rate limit reached; retry only by explicit operator action.");
      throw new DomainError("PROVIDER_CONCEPT_SUBMISSION_UNKNOWN","OpenAI Creative Concept submission outcome is unknown; do not retry automatically.");
    }
  }

  async retrieveConceptExecution(responseId:string):Promise<ConceptProviderResponse>{
    try{return this.conceptResponse(await this.client.responses.retrieve(responseId,{}, {timeout:this.config.conceptTransportTimeoutMs??30_000}));}
    catch(error){
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===404||status===410)throw new DomainError("PROVIDER_CONCEPT_RESULT_UNAVAILABLE","The known OpenAI Creative Concept response is no longer retrievable; it will not be resubmitted.");
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
      const response = await this.client.responses.create({ model:this.config.model, store:false, background:true,
        instructions:strategyInstructions(expectedCount,input.requestedCount),
        input:[{role:"user",content:[{type:"input_text",text:JSON.stringify({operationKey:context.operationKey,projectId:context.projectId,targetId:context.targetId,strategy:input})},...referenceImages]}],
        text:{format:{type:"json_schema",name:"koolezt_creative_strategy",strict:true,schema:strategySchemaFor(expectedCount)}}
      }, { timeout: this.config.strategyTransportTimeoutMs ?? 30_000 });
      return this.strategyResponse(response);
    } catch(error) {
      if(error instanceof DomainError)throw error;
      const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
      if(status===400)throw new DomainError("PROVIDER_STRATEGY_INVALID","OpenAI rejected the bounded strategy request.");
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
      if (status === 404 || status === 410) throw new DomainError("PROVIDER_STRATEGY_RESULT_UNAVAILABLE", "The known OpenAI Strategy response is no longer retrievable; it will not be submitted again automatically.");
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
        instructions:DNA_ANALYSIS_INSTRUCTIONS,
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
      if(status===404||status===410)throw new DomainError("PROVIDER_DNA_RESULT_UNAVAILABLE","The known Creative DNA response is no longer retrievable; it will not be resubmitted.");
      throw new Error("OpenAI Creative DNA response retrieval temporarily failed.");
    }
  }

  async generateVariantPackages(input: VariantPackageGenerationInput, context: ProviderOperationContext): Promise<Readonly<{ packages: readonly VariantCreativePackageDraft[]; submission: ProviderSubmission }>> {
    try {
      const response = await this.client.responses.create({
        model: this.config.model, store: false,
        instructions: VARIANT_PACKAGE_INSTRUCTIONS,
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
      if (response.status !== "completed" || !response.output_text) throw new DomainError("PROVIDER_NARRATION_REWRITE_INVALID", "OpenAI did not return a completed narration rewrite.");
      let parsed: { script?: unknown };
      try { parsed = JSON.parse(response.output_text) as { script?: unknown }; } catch { throw new DomainError("PROVIDER_NARRATION_REWRITE_INVALID", "OpenAI returned malformed narration rewrite data."); }
      const script = typeof parsed.script === "string" ? parsed.script.trim() : "";
      if (!script) throw new DomainError("PROVIDER_NARRATION_REWRITE_INVALID", "OpenAI returned an empty narration rewrite.");
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
