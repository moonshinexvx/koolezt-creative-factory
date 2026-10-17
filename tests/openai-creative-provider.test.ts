import { describe, expect, it, vi } from "vitest";
import { FakeCreativeProvider, OpenAICreativeProvider, OPENAI_CREATIVE_INSTRUCTIONS, OPENAI_CREATIVE_PROMPT_VERSION } from "@koolezt/providers";
import type { CreativeDnaAnalysisInput, StrategyGenerationInput } from "@koolezt/domain";

const input = { productName: "Example", description: "Description", defaultCta: "Create yours", creativeNotes: "Keep it accurate", claims: [{ kind: "FEATURE" as const, text: "Feature" }, { kind: "RESTRICTION" as const, text: "Do not invent options" }], selectedAssets: [{ id: "asset-1", kind: "IMAGE" as const, label: "Mockup", mimeType: "image/png" }], additionalInstructions: "Warm UGC" };
const concept = { angle: "Angle", hook: "Hook", targetDurationMs: 15_000, voiceScript: "Script", cta: "CTA", editingStyleKey: "UGC_FAST/v1", musicCategory: "UGC upbeat", scenes: [1, 2, 3].map((sceneNumber) => ({ sceneNumber, intendedDurationMs: 5_000, purpose: `Scene ${sceneNumber}`, sourceType: "PRODUCT_IMAGE" as const, generationPrompt: "Show the exact mockup", overlayText: "LOOK", referenceAssetIds: ["asset-1"], accuracyRequirements: ["Do not invent options"] })) };
const strategyScenes=concept.scenes.map((scene)=>({sceneNumber:scene.sceneNumber,intendedDurationMs:scene.intendedDurationMs,purpose:scene.purpose,sourceType:scene.sourceType,generationPrompt:scene.generationPrompt,overlayText:scene.overlayText,referenceRoles:["PRIMARY_PRODUCT_REFERENCE"],accuracyRequirements:scene.accuracyRequirements}));
const context = { operationKey: "concept:project:revision:1:generate", projectId: "project", targetId: "concept-1" };
const strategyInput={...input,selectedStrategy:{id:"rev",conceptId:"concept",batchId:"batch",ordinal:1,revision:1,source:"OPENAI",conceptName:"Pet + Number = Yours",conceptFamily:"Customization demo",buyerPersona:"pet homeowner",customerDesireOrProblem:"understand personalization",awarenessLevel:"Product-aware",coreAngle:"Pet plus address in one sign",emotionalTerritory:"Pride",primaryPromise:"Personalized sign",hook:"Start with their face. Add your number.",openingVisualPattern:"Product first",creativeFormat:"Demo",primaryProductionMethod:"PERSONALIZATION_DEMO",supportingProductionMethods:["PRODUCT_IMAGE_MOTION"],proofMechanism:"Visual assembly",offerFraming:"Make it yours",ctaStrategy:"Invite customization",differentiationSummary:"Process-led",creativeVisualExecutionNotes:"Use reference",ugcRepresentation:"NOT_APPLICABLE",productTruthConstraints:[],visualFidelityRequirements:[],requiredRealAssetCapabilities:["PRODUCT_IMAGE"],createdBy:"test",createdAt:"now",revisionSha256:"sha"}} as never;

describe("OpenAI creative provider", () => {
  it("uses Responses structured output and records safe metadata", async () => {
    let request: unknown;
    const client = { responses: { create: async (value: unknown) => { request = value; return { id: "resp_1", model: "test-model", status: "completed", output_text: JSON.stringify(concept), usage: { input_tokens: 12, output_tokens: 34 } }; } } } as never;
    const resolveReferenceUrl = vi.fn(async (assetId: string) => `https://private.example/${assetId}?signed=redacted`);
    const provider = new OpenAICreativeProvider({ apiKey: "test", model: "test-model", resolveReferenceUrl }, client);
    const result = await provider.generateConcept(input, context);
    expect(result.concept).toEqual(concept);
    expect(result.submission.metadata).toMatchObject({ promptVersion: OPENAI_CREATIVE_PROMPT_VERSION, inputTokens: 12, outputTokens: 34 });
    expect(JSON.stringify(request)).toContain("Do not invent options");
    expect(resolveReferenceUrl).toHaveBeenCalledWith("asset-1");
    expect(JSON.stringify(request)).toContain('\\"projectId\\":\\"project\\"');
    expect(JSON.stringify(request)).toContain("private.example/asset-1");
    expect(JSON.stringify(request)).not.toContain("other-project-product");
    expect(JSON.stringify(request)).toContain('"minItems":3');
    expect(JSON.stringify(request)).not.toContain("OPENAI_API_KEY");
    expect(OPENAI_CREATIVE_INSTRUCTIONS).toContain("3–7 words");
    expect(OPENAI_CREATIVE_INSTRUCTIONS).toContain("separate from narration");
  });

  it("uses an execution-only schema for an authoritative Strategy snapshot", async () => {
    let request:unknown;
    const execution={strategyExecutionSummary:"Execute pet plus address personalization through immediate Product visibility and multiple examples.",targetDurationMs:15_000,voiceScript:"Your pet. Your number. Your sign.",editingStyleKey:"DIRECT/v1",musicCategory:"Upbeat",scenes:strategyScenes};
    const client={responses:{create:async(value:unknown)=>{request=value;return{id:"resp_execution",model:"test-model",status:"completed",output_text:JSON.stringify(execution),usage:{input_tokens:10,output_tokens:20}};}}} as never;
    const provider=new OpenAICreativeProvider({apiKey:"test",model:"test-model"},client);
    const result=await provider.generateConcept(strategyInput,context);
    expect(result.concept).toEqual(execution);
    const structured=request as {instructions:string;text:{format:{name:string;schema:{required:string[]}}}};
    expect(structured.text.format.name).toBe("koolezt_creative_execution");
    expect(structured.text.format.schema.required).not.toContain("angle");
    expect(structured.text.format.schema.required).not.toContain("hook");
    expect(structured.text.format.schema.required).not.toContain("cta");
    expect(structured.text.format.schema.required).toContain("strategyExecutionSummary");
    expect(structured.text.format.schema.required).toContain("completedPersonalizedVariantCount");
    expect(structured.text.format.schema.required).toContain("completedVariantExamples");
    expect(JSON.stringify(structured.text.format.schema)).toContain("referenceRoles");
    expect(JSON.stringify(structured.text.format.schema)).not.toContain("referenceAssetIds");
    expect(structured.instructions).toContain("read-only authority");
    expect(structured.instructions).toContain("AT LEAST TWO visibly distinct COMPLETED personalized Product results");
  });

  it("submits Strategy-linked Creative Concepts in background stored-false mode and retrieves the same Response ID", async()=>{
    let request:unknown;
    const execution={strategyExecutionSummary:"Execute pet plus address personalization through immediate Product visibility and multiple examples.",targetDurationMs:15_000,voiceScript:"Your pet. Your number. Your sign.",editingStyleKey:"DIRECT/v1",musicCategory:"Upbeat",scenes:strategyScenes};
    const create=vi.fn(async(value:unknown)=>{request=value;return{id:"resp_concept_bg",model:"test-model",status:"queued",output_text:"",usage:null};});
    const retrieve=vi.fn(async(responseId:string)=>({id:responseId,model:"test-model",status:"completed",output_text:JSON.stringify(execution),usage:{input_tokens:10,output_tokens:20,total_tokens:30}}));
    const provider=new OpenAICreativeProvider({apiKey:"test-secret-not-logged",model:"test-model"},{responses:{create,retrieve}} as never);
    const feasibilityPlan={version:1 as const,status:"SUPPORTED" as const,requirements:[],required:["Show Product immediately"],preserve:["Wall-sign silhouette"],mayVary:["House number"],forbidden:["Historical discount"]};
    const submitted=await provider.submitConceptExecution!(strategyInput,context,feasibilityPlan);
    const completed=await provider.retrieveConceptExecution!(submitted.responseId);
    expect(submitted).toMatchObject({responseId:"resp_concept_bg",status:"queued"});
    expect(completed).toMatchObject({responseId:"resp_concept_bg",status:"completed",usage:{totalTokens:30}});
    expect(create).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith("resp_concept_bg",{},expect.objectContaining({timeout:30_000}));
    expect(request).toMatchObject({background:true,store:false,text:{format:{name:"koolezt_creative_execution",strict:true}}});
    const serialized=JSON.stringify(request);
    expect(serialized).toContain("read-only authority");
    expect(serialized).not.toContain("test-secret-not-logged");
    expect(serialized).toContain("executionFeasibilityPlan");
    expect(serialized).toContain("Wall-sign silhouette");
    expect(serialized).toContain("Historical discount");
    expect(serialized).toContain("MAY-VARY permissions authorize generated visual differences only");
    expect(serialized).toContain("Do not describe personalization options or capabilities");
    expect(serialized).toContain("same finished sign in another room/background/camera angle");
    expect(serialized).toContain("selected Strategy defines the EXCLUSIVE advertising territory");
    expect(serialized).toContain("Product description, creative notes, reference imagery, and historical Winner context");
    expect(serialized).toContain("they do NOT authorize Strategy territory");
    expect(serialized).toContain("musicCategory");
    expect(serialized).toContain("festive, Christmas, holiday, gift-opening, or memorial cues");
    expect(serialized).toContain("visibly mounted or installed from frame one");
    expect(serialized).toContain("gift box, wrapped gift, tabletop display, unboxing");
    expect(serialized).toContain("return referenceRoles, never asset IDs");
    const providerText=((request as {input:{content:{type:string;text?:string}[]}[]}).input[0]!.content.find(item=>item.type==="input_text")?.text)??"";
    expect(providerText).toContain("PRIMARY_PRODUCT_REFERENCE");
    expect(providerText).not.toContain("asset-1");
  });

  it("keeps unselected gift and holiday territory forbidden even when Product description suggests gifting",async()=>{
    let request:unknown;
    const create=vi.fn(async(value:unknown)=>{request=value;return{id:"resp_territory",model:"test-model",status:"queued",output_text:"",usage:null};});
    const provider=new OpenAICreativeProvider({apiKey:"test",model:"test-model"},{responses:{create}} as never);
    const giftDescriptionInput={...(strategyInput as unknown as Record<string,unknown>),description:"A personalized sign that can also be marketed as a Christmas or housewarming gift."} as never;
    await provider.submitConceptExecution!(giftDescriptionInput,context,{version:1,status:"SUPPORTED",requirements:[],required:[],preserve:[],mayVary:[],forbidden:[]});
    const serialized=JSON.stringify(request);
    expect(serialized).toContain("Christmas or housewarming gift");
    expect(serialized).toContain("selected Strategy defines the EXCLUSIVE advertising territory");
    expect(serialized).toContain("Do not introduce another purchase occasion");
    expect(serialized).toContain("holiday arrangement");
    expect(serialized).toContain("Use neutral Strategy-compatible music and mood");
  });

  it("rewrites narration only on an explicit provider invocation with structured output", async () => {
    let request: unknown;
    const client = { responses: { create: async (value: unknown) => { request = value; return { id: "resp_rewrite", model: "test-model", status: "completed", output_text: JSON.stringify({ script: "A concise, natural revised narration." }), usage: { input_tokens: 9, output_tokens: 11 } }; } } } as never;
    const provider = new OpenAICreativeProvider({ apiKey: "test", model: "test-model" }, client);
    const result = await provider.rewriteNarration!({ script: "Original narration.", targetDurationMs: 15_000, recommendedMinimumMs: 13_001, recommendedMaximumMs: 14_201, productName: "Example", creativeTopic: "Gift", productDetails: "Personalized", cta: "Create yours" }, { operationKey: "rewrite:project:1", projectId: "project", targetId: "narration-1" });
    expect(result).toMatchObject({ script: "A concise, natural revised narration.", submission: { provider: "openai", model: "test-model", requestId: "resp_rewrite" } });
    expect(JSON.stringify(request)).toContain('\\"targetDurationMs\\":15000');
    expect(JSON.stringify(request)).toContain('"name":"koolezt_narration_rewrite"');
    expect(JSON.stringify(request)).not.toContain("OPENAI_API_KEY");
  });

  it("rejects malformed structured output and missing config", async () => {
    expect(() => new OpenAICreativeProvider({ apiKey: "", model: "model" })).toThrow(/OPENAI_API_KEY/);
    const client = { responses: { create: async () => ({ id: "resp_1", model: "test", status: "completed", output_text: "not-json" }) } } as never;
    await expect(new OpenAICreativeProvider({ apiKey: "test", model: "test" }, client).generateConcept(input, context)).rejects.toThrow(/malformed/);
  });
});

  it("uses an OpenAI-compatible strict schema for the explicit four-angle action", async () => {
    let request: unknown;
    const packages = ["A", "B", "C", "D"].map((slot) => ({ slot, angleName: `Angle ${slot}`, hook: `Hook for ${slot}`, narrationText: `Narration ${slot}`, cta: `CTA ${slot}`, secondaryOverlay: "" }));
    const client = { responses: { create: async (value: unknown) => { request = value; return { id: "resp_variants", model: "test-model", status: "completed", output_text: JSON.stringify({ packages }), usage: { input_tokens: 4, output_tokens: 8 } }; } } } as never;
    const provider = new OpenAICreativeProvider({ apiKey: "test", model: "test-model" }, client);
    const result = await provider.generateVariantPackages!({ productName: "Example", scenes: [], targetDurationMs: 15_000 }, { operationKey: "variants:project", projectId: "project", targetId: "creative-packages" });
    expect(result.packages).toHaveLength(4);
    expect(result.packages.every((item) => item.secondaryOverlay === undefined)).toBe(true);
    const schema = (request as { text: { format: { schema: { properties: { packages: { items: { required: readonly string[] } } } } } } }).text.format.schema;
    expect(schema.properties.packages.items.required).toContain("secondaryOverlay");
    expect(JSON.stringify(request)).toContain("empty string for secondaryOverlay");
  });

  it("reports an explicit invalid variant request without retrying", async () => {
    const client = { responses: { create: async () => { const error = new Error("invalid schema") as Error & { status: number }; error.status = 400; throw error; } } } as never;
    const provider = new OpenAICreativeProvider({ apiKey: "test", model: "test-model" }, client);
    await expect(provider.generateVariantPackages!({ productName: "Example", scenes: [], targetDurationMs: 15_000 }, { operationKey: "variants:project", projectId: "project", targetId: "creative-packages" })).rejects.toMatchObject({ code: "OPENAI_VARIANT_COPY_REQUEST_INVALID" });
  });

  it("makes exactly one mocked structured request for a bounded strategy generation operation", async () => {
    const strategyInput: StrategyGenerationInput = { productName: "Example", productDescription: "Personalized product", verifiedClaims: [{ kind: "FEATURE", text: "Uses the supplied pet image" }], selectedAssets: [{ id: "asset-1", kind: "IMAGE", label: "Reference", mimeType: "image/png" }], additionalInstructions: "Find distinct purchase motivations", targetDurationMs: 15_000, availableAssetCapabilities: ["PRODUCT_IMAGE"], authoritativeConstraints: [{ text: "Uses the supplied pet image", sourceType: "VERIFIED_PRODUCT_CLAIM", authority: "FACTUAL_CLAIM", sourceId: "FEATURE:0" }, { text: "Preserve visible layout", sourceType: "REFERENCE_VISUAL", authority: "VISUAL_EVIDENCE", sourceId: "asset-1" }], creativeHistory: [], requestedCount: 12 };
    const fake = new FakeCreativeProvider();
    const fakeResult = await fake.submitStrategyConcepts!(strategyInput, { operationKey: "fixture", projectId: "project", targetId: "batch" });
    const create = vi.fn(async (request: unknown) => { void request; return { id: "resp_strategy", model: "test-model", status: "queued", output_text: "", usage: null }; });
    const retrieve = vi.fn(async (responseId: string) => ({ id: responseId, model: "test-model", status: "completed", output_text: fakeResult.outputText, usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } }));
    const resolveStrategyReference = vi.fn(async (assetId: string) => `https://private.example/${assetId}?signed=redacted`);
    const provider = new OpenAICreativeProvider({ apiKey: "test-secret-not-logged", model: "test-model", resolveReferenceUrl: resolveStrategyReference }, { responses: { create, retrieve } } as never);
    const submitted = await provider.submitStrategyConcepts!(strategyInput, { operationKey: "strategy:project:initial", projectId: "project", targetId: "batch" });
    const result = await provider.retrieveStrategyConcepts!(submitted.responseId);
    expect(JSON.parse(result.outputText!).concepts).toHaveLength(12);
    expect(create).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(create.mock.calls[0]![0]);
    expect(serialized).toContain('"background":true');
    expect(serialized).toContain('"store":false');
    expect(serialized).toContain("purchase context or motivation");
    expect(serialized).toContain("Reference images establish visual evidence only");
    const schema = (create.mock.calls[0]![0] as { text: { format: { schema: { properties: { concepts: { items: { required: string[]; properties: { supportingProductionMethods: { maxItems: number } } } } } } } } }).text.format.schema.properties.concepts.items;
    expect(schema.required).toContain("creativeVisualExecutionNotes");
    expect(schema.required).not.toContain("productTruthConstraints");
    expect(schema.required).not.toContain("visualFidelityRequirements");
    expect(schema.required).not.toContain("requiredRealAssetCapabilities");
    expect(schema.properties.supportingProductionMethods.maxItems).toBe(3);
    expect(serialized).toContain("private.example/asset-1");
    expect(resolveStrategyReference).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledWith("resp_strategy", {}, expect.objectContaining({ timeout: 30000 }));
    expect(serialized).not.toContain("test-secret-not-logged");
    expect(OPENAI_CREATIVE_INSTRUCTIONS).toContain("authoritative immutable execution contract");
  });

  it("submits Creative DNA as a background stored-false structured response with bounded frame evidence", async () => {
    let request: unknown;
    const create = vi.fn(async (value: unknown) => { request = value; return { id: "resp_dna", model: "test-model", status: "queued", output_text: "", usage: null }; });
    const retrieve = vi.fn(async (responseId: string) => ({ id: responseId, model: "test-model", status: "in_progress", output_text: "", usage: null }));
    const provider = new OpenAICreativeProvider({ apiKey: "test-secret-not-logged", model: "test-model" }, { responses: { create, retrieve } } as never);
    const dnaInput: CreativeDnaAnalysisInput = {
      referenceId: "reference-1", displayName: "Old Meta winner",
      mediaMetadata: { durationMs: 15_000, width: 720, height: 1280, frameRate: 30, hasAudio: true, mimeType: "video/mp4" },
      frames: [
        { timestampMs: 0, mimeType: "image/jpeg", bytesBase64: "ZmFrZQ==", sha256: "a".repeat(64) },
        { timestampMs: 14_900, mimeType: "image/jpeg", bytesBase64: "ZmFrZTI=", sha256: "b".repeat(64) }
      ],
      operatorTranscript: "Optional operator-supplied transcript",
      performance: { purchaseCpa: 32, currency: "USD", metricSource: "operator supplied" },
      currentProduct: { name: "Current sign", description: "Current authoritative description", verifiedClaims: [] }
    };
    const submitted = await provider.submitCreativeDnaAnalysis!(dnaInput, { operationKey: "dna:reference-1", projectId: "project", targetId: "reference-1" });
    await provider.retrieveCreativeDnaAnalysis!(submitted.responseId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({ background: true, store: false, text: { format: { type: "json_schema", name: "koolezt_creative_dna", strict: true } } });
    const serialized = JSON.stringify(request);
    expect(serialized).toContain("historicalContextOnly");
    expect(serialized).toContain("CURRENT_PRODUCT_TRUTH_READ_ONLY");
    expect(serialized).toContain("Historical prices");
    expect(serialized).toContain("data:image/jpeg;base64,ZmFrZQ==");
    expect(serialized).not.toContain("test-secret-not-logged");
  });
