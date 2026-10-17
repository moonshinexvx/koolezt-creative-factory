import { describe, expect, it } from "vitest";
import { assertExecutionFeasible, buildExecutionFeasibilityPlan } from "@koolezt/application";
import type { CreativeInputSnapshot } from "@koolezt/domain";

const assetId="11111111-1111-4111-8111-111111111111";
function input(withAuthority=true):CreativeInputSnapshot{
  return {
    productName:"Personalized Address Sign",
    description:"Personalized sign",
    claims:[],
    defaultCta:"Create yours",
    selectedAssets:[{id:assetId,kind:"IMAGE",label:"Product reference",mimeType:"image/png"}],
    additionalInstructions:"",
    productionCapabilities:["PRODUCT_IMAGE","PRODUCT_MOCKUP"],
    ...(withAuthority?{personalizationVisualAuthority:{
      status:"OPERATOR_CONFIRMED" as const,
      immutableStructure:["Wall-sign silhouette","Mounting configuration","Layout proportions"],
      authorizedPersonalizationFields:["Pet artwork","House number","Street text"]
    }}:{}),
    selectedStrategy:{
      id:"strategy-revision",conceptId:"concept",batchId:"batch",ordinal:1,revision:1,source:"OPENAI",
      diversityState:"DISTINCT",productionSafetyState:"PRODUCTION_SAFE",conceptName:"Pet + Number = Yours",
      conceptFamily:"Customization demo",buyerPersona:"Owner personalizing home decor",
      customerDesireOrProblem:"Make the sign specific to their home",awarenessLevel:"Product-aware",
      coreAngle:"Pet design plus address in one personalized display.",emotionalTerritory:"Personal pride",
      primaryPromise:"Pet and address together",hook:"Start with their face. Add your number.",
      openingVisualPattern:"Finished sign first",creativeFormat:"Personalization walkthrough",
      primaryProductionMethod:"PERSONALIZATION_DEMO",supportingProductionMethods:["PRODUCT_IMAGE_MOTION"],
      proofMechanism:"Visible personalization",offerFraming:"Make it yours",ctaStrategy:"Create yours",
      differentiationSummary:"Pet plus number",creativeVisualExecutionNotes:"Use Product reference",
      ugcRepresentation:"NOT_APPLICABLE",productTruthConstraints:[],visualFidelityRequirements:[],
      requiredRealAssetCapabilities:["PRODUCT_IMAGE"],createdBy:"test",createdAt:"2026-01-01T00:00:00.000Z",
      revisionSha256:"strategy-sha"
    },
    selectedWinnerDna:{
      id:"dna",creativeReferenceId:"reference",revision:1,status:"APPROVED",source:"OPENAI",
      mediaMetadata:{durationMs:30_000,width:360,height:640,hasAudio:true,mimeType:"video/mp4"},
      openingPattern:"Open on installed finished Product",openingProductVisible:true,approximateProductRevealMs:0,
      visualHookMechanism:"Product first",productProminence:"High",personalizationVisibility:"High",
      repeatedExamplePattern:"Multiple personalized variants",approximateExampleCount:5,pacingPattern:"Gallery",
      beatStructure:"Product and variants",overlayTextPattern:"Persistent",offerVisibilityPattern:"Historical",
      ctaPattern:"Persistent direct response",proofPattern:"Multiple examples",visualFormat:"9:16",
      lifestyleVsProductBalance:"Product-led",soundOffComprehension:"Strong",
      directResponsePattern:"Persistent direct-response message",closingPattern:"Product and CTA",
      preserveTraits:["Open on installed finished Product","Show multiple personalized variants"],
      safeToVaryTraits:["Setting"],avoidTraits:["Historical offer"],sourceEvidence:[],
      createdBy:"test",createdAt:"2026-01-01T00:00:00.000Z",referenceDisplayName:"Winner B",
      revisionSha256:"dna-sha"
    }
  };
}

describe("pre-generation execution feasibility",()=>{
  it("blocks essential repeated-example DNA without operator-confirmed visual variation authority",()=>{
    const plan=buildExecutionFeasibilityPlan(input(false));
    expect(plan.status).toBe("BLOCKED");
    expect(plan.requirements).toContainEqual(expect.objectContaining({code:"AUTHORIZED_PERSONALIZATION_VARIATIONS",resolution:"UNSUPPORTED_REQUIRED"}));
    expect(()=>assertExecutionFeasible(input(false))).toThrow(/no operator-confirmed personalization fields/i);
  });
  it("allows authorized personalization variation while preserving Product structure",()=>{
    const plan=assertExecutionFeasible(input());
    expect(plan.status).toBe("SUPPORTED");
    expect(plan.preserve).toEqual(["Wall-sign silhouette","Mounting configuration","Layout proportions"]);
    expect(plan.mayVary).toEqual(["Pet artwork","House number","Street text"]);
    expect(plan.requirements).toContainEqual(expect.objectContaining({code:"PRODUCT_VISIBLE_AT_OPEN",resolution:"REQUIRED_AND_SUPPORTED"}));
    expect(plan.requirements).toContainEqual(expect.objectContaining({code:"INSTALLED_PRODUCT_OPENING",resolution:"REQUIRED_AND_SUPPORTED"}));
    expect(plan.requirements).toContainEqual(expect.objectContaining({code:"PERSISTENT_DIRECT_RESPONSE_MESSAGE",resolution:"REQUIRED_AND_SUPPORTED"}));
  });
  it("keeps legacy Strategy execution without Winner DNA compatible",()=>{
    const value=input(false);
    const plan=assertExecutionFeasible({...value,selectedWinnerDna:undefined} as unknown as CreativeInputSnapshot);
    expect(plan.status).toBe("SUPPORTED");
  });
});
