import { describe, expect, it } from "vitest";
import { assembleCreativeConcept, bindCanonicalVisualReferences, boundedConceptProviderResult, conceptProviderResultSha256, validateConceptExecution } from "@koolezt/application";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import type { ConceptProviderOperationEvidence, CreativeConceptProviderDraft, CreativeInputSnapshot } from "@koolezt/domain";

const assetId="11111111-1111-4111-8111-111111111111";
function snapshot():CreativeInputSnapshot{return {productName:"Personalized Metal Address Sign",description:"A wall address sign personalized with pet artwork and address text.",claims:[],defaultCta:"Create yours today",selectedAssets:[{id:assetId,kind:"IMAGE",label:"Primary Product Reference",mimeType:"image/jpeg"}],additionalInstructions:"Use the immutable strategy.",targetDurationMs:15_000,productionCapabilities:["PRODUCT_IMAGE","PRODUCT_MOCKUP","CUSTOMER_REFERENCE_IMAGE"],personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED",immutableStructure:["Wall-sign silhouette","Mounting configuration","Pet-to-number layout"],authorizedPersonalizationFields:["Pet artwork","House number","Street text"]},selectedStrategy:{id:"strategy-rev",conceptId:"strategy",batchId:"batch",ordinal:1,revision:1,source:"OPENAI",diversityState:"DISTINCT",productionSafetyState:"PRODUCTION_SAFE",conceptName:"Pet + Number = Yours",conceptFamily:"Customization demo",buyerPersona:"buyer seeking custom home decor reflecting their pet",customerDesireOrProblem:"quickly understand what makes the sign specific to their home",awarenessLevel:"Product-aware",coreAngle:"Pet design plus address in one personalized display.",emotionalTerritory:"Affectionate pride",primaryPromise:"Your pet and address together in one design.",hook:"Start with their face. Add your number.",openingVisualPattern:"Pet plus number resolves into the finished sign.",creativeFormat:"Personalization walkthrough",primaryProductionMethod:"PERSONALIZATION_DEMO",supportingProductionMethods:["PRODUCT_IMAGE_MOTION"],proofMechanism:"Animated assembly of pet and address into the final sign.",offerFraming:"Make the home detail yours.",ctaStrategy:"Invite the viewer to create their personalized sign.",differentiationSummary:"Personalization process is the narrative.",creativeVisualExecutionNotes:"Use supplied Product imagery.",ugcRepresentation:"NOT_APPLICABLE",productTruthConstraints:[],visualFidelityRequirements:[{text:"Preserve silhouette and layout.",sourceType:"REFERENCE_VISUAL",authority:"VISUAL_EVIDENCE",sourceId:assetId}],requiredRealAssetCapabilities:["PRODUCT_IMAGE"],createdBy:"test",createdAt:"2026-01-01T00:00:00.000Z",revisionSha256:"strategy-sha"},selectedWinnerDna:{id:"dna",creativeReferenceId:"ref",revision:1,status:"APPROVED",source:"OPENAI",mediaMetadata:{durationMs:30_000,width:360,height:640,hasAudio:true,mimeType:"video/mp4"},openingPattern:"Installed finished product immediately visible",openingProductVisible:true,approximateProductRevealMs:0,visualHookMechanism:"Product first",productProminence:"High",personalizationVisibility:"High",repeatedExamplePattern:"Several consistent personalized variants",approximateExampleCount:5,pacingPattern:"Gallery",beatStructure:"Product then variants",overlayTextPattern:"Persistent",offerVisibilityPattern:"Historical $31.49 / 10% OFF evidence only",ctaPattern:"Persistent CTA",proofPattern:"Multiple examples",visualFormat:"9:16",lifestyleVsProductBalance:"Product-led",soundOffComprehension:"Strong",directResponsePattern:"Persistent messaging",closingPattern:"Product and CTA",preserveTraits:["Open on installed finished Product","Multiple examples"],safeToVaryTraits:["Setting"],avoidTraits:["Historical offer"],sourceEvidence:[],createdBy:"test",createdAt:"2026-01-01T00:00:00.000Z",referenceDisplayName:"Winner B",revisionSha256:"dna-sha"}};}
const finishedVariants=[
  {sceneNumber:2,label:"Finished sign A",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Retriever portrait"},{field:"House number",value:"102"},{field:"Street text",value:"Oak Street"}],productStructurePreserved:true},
  {sceneNumber:3,label:"Finished sign B",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Terrier portrait"},{field:"House number",value:"245"},{field:"Street text",value:"Pine Avenue"}],productStructurePreserved:true},
  {sceneNumber:3,label:"Finished sign C",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Spaniel portrait"},{field:"House number",value:"318"},{field:"Street text",value:"Maple Road"}],productStructurePreserved:true}
] as const;
function execution(overrides:Partial<CreativeConceptProviderDraft>={}):CreativeConceptProviderDraft{return {strategyExecutionSummary:"Show pet plus house number assembling into the finished personalized sign, then multiple personalized examples.",completedPersonalizedVariantCount:finishedVariants.length,completedVariantExamples:finishedVariants,targetDurationMs:15_000,voiceScript:"Your pet. Your number. One sign that's yours. See multiple personalized examples, then create yours today.",editingStyleKey:"DIRECT_RESPONSE/v1",musicCategory:"Upbeat",scenes:[1,2,3].map((sceneNumber)=>({sceneNumber,intendedDurationMs:5_000,purpose:sceneNumber===1?"Open with the installed finished sign immediately visible":sceneNumber===2?"Assemble pet plus address personalization":"Show multiple finished personalized sign variations",sourceType:"PRODUCT_IMAGE",generationPrompt:sceneNumber===1?"First frame: finished product mounted at the home entry using the selected reference.":sceneNumber===2?"Animate pet artwork plus house number into a completed changed personalized sign.":"Gallery of three visibly distinct completed personalized signs with consistent wall-sign structure.",overlayText:sceneNumber===1?"YOUR PET + YOUR NUMBER":sceneNumber===2?"MADE PERSONAL":"CREATE YOURS TODAY",referenceRoles:["PRIMARY_PRODUCT_REFERENCE"],accuracyRequirements:[]})),...overrides};}

const storedCf000012RejectedResult:CreativeConceptProviderDraft={
  strategyExecutionSummary:"A mobile-first personalization walkthrough opens on the finished sign in a home-entry setting, then visually assembles pet artwork and house number before resolving into a short gallery of authorized personalized variants. Clean lower-safe-area messaging stays readable while the product remains central, ending with the approved direct CTA.",
  targetDurationMs:15_000,
  voiceScript:"Start with their face, then add your house number. Together, they become a custom address sign made for your home. Choose from breed designs, or request artwork from a pet photo. Create yours today.",
  editingStyleKey:"Warm personalization-demo UGC polish; slow product-led carousel, crisp UI assembly animation, bold black text on white, ",
  musicCategory:"Warm uplifting acoustic holiday-home instrumental",
  scenes:[
    {sceneNumber:1,intendedDurationMs:5_000,purpose:"Immediately show the finished personalized product in a believable home-entry context and establish the hook.",sourceType:"PRODUCT_IMAGE",generationPrompt:"9:16 vertical, open on the supplied Custom Pet Vertical Address Sign already mounted beside a realistic front door in a warm, high-contrast home-entry setting. Use the supplied product reference exactly for the sign silhouette, orientation, geometry, layout, pet/address relationship, mounting configuration, structural proportions, colors, and all visible product details. Slow, subtle push-in; keep the sign centered and its pet artwork and house numbers unobstructed. Add a persistent small white lower-safe-area banner treatment for readable direct-response messaging, without price or discount claims.",overlayText:"Their Pet. Your Number.",referenceRoles:["PRIMARY_PRODUCT_REFERENCE"],accuracyRequirements:["Show the finished product in the opening frame.","Preserve the supplied sign’s silhouette, layout, visible text, proportions, colors, and details.","Do not cover the pet artwork or address numerals with overlays.","Do not show price, discount, delivery, or unsupported offer claims."]},
    {sceneNumber:2,intendedDurationMs:5_000,purpose:"Make the two personalization elements visually legible and prove configurable appearance through examples.",sourceType:"PRODUCT_IMAGE",generationPrompt:"9:16 vertical UI-style personalization animation. Start with a simple illustrated selection card labeled visually as a pet portrait, then animate a house-number selection card joining it. The two elements smoothly assemble into the supplied finished Custom Pet Vertical Address Sign, preserving its exact product structure. Resolve into a brief carousel of two or three installed home-entry examples that retain the identical sign architecture while varying only operator-authorized pet artwork, house number, and street text. Keep the sign large, central, and unobstructed; use clean white lower-safe-area banners for persistent readable messaging.",overlayText:"Pet + Number = Yours",referenceRoles:["PRIMARY_PRODUCT_REFERENCE"],accuracyRequirements:["Only pet artwork, house number, and street text may vary between examples.","Keep the same product family, silhouette, orientation, geometry, layout structure, and mounting configuration.","Resolve to the supplied product image without altering visible product details.","Do not imply options beyond supplied product data."]},
    {sceneNumber:3,intendedDurationMs:5_000,purpose:"Reinforce the personalized-home result and close with a direct action.",sourceType:"PRODUCT_IMAGE",generationPrompt:"9:16 vertical closing gallery of three warm, realistic entryway installations. Feature the supplied sign prominently first, followed by authorized personalized examples with the same vertical address-panel architecture and varied pet artwork, house number, and street text only. End on the supplied finished sign centered against a clear exterior wall, with room in the lower safe area for one bold white-banner CTA. Slow carousel pacing, affectionate home-pride mood, product remains fully readable and never obscured.",overlayText:"Create Yours Today",referenceRoles:["PRIMARY_PRODUCT_REFERENCE"],accuracyRequirements:["Keep the product central and its address numerals and pet artwork readable.","Use only authorized personalization variations.","Do not use historical price, discount, or promotional copy.","Do not add unsupported material, shipping, availability, or guarantee claims."]}
  ]
};

describe("canonical Creative Concept authority",()=>{
  it("accepts paraphrased execution copy and injects exact canonical Strategy fields",()=>{const input=snapshot();const draft=execution({voiceScript:"Your pet. Your number. One sign that's yours. Multiple examples make personalization visible."});expect(validateConceptExecution(input,draft)).toEqual([]);const result=assembleCreativeConcept(input,draft);expect(result).toMatchObject({angle:input.selectedStrategy!.coreAngle,hook:input.selectedStrategy!.hook,cta:"Create yours today",strategyExecutionSummary:draft.strategyExecutionSummary});expect(result.scenes[0]!.accuracyRequirements).toContain("Preserve silhouette and layout.");});
  it("binds PRIMARY_PRODUCT_REFERENCE to the exact immutable snapshot UUID",()=>{
    const canonical="c2596f01-a2d9-4410-96c8-2946c4c84c2f";
    const input={...snapshot(),selectedAssets:[{...snapshot().selectedAssets[0]!,id:canonical}]};
    const result=assembleCreativeConcept(input,execution());
    expect(result.scenes.every((scene)=>scene.referenceAssetIds[0]===canonical)).toBe(true);
    expect(JSON.stringify(result)).toContain(canonical);
  });
  it("rejects provider-owned arbitrary or truncated asset UUIDs",()=>{
    for(const providerId of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","c2596f01-a2d9-4410-96c8-4c84c2f"]){
      const draft=execution({scenes:execution().scenes.map((scene)=>{const providerOwned={...scene};delete providerOwned.referenceRoles;return {...providerOwned,referenceAssetIds:[providerId]};})});
      expect(validateConceptExecution(snapshot(),draft).join(" ")).toContain("returned provider-owned asset IDs");
    }
  });
  it("resolves an intended secondary reference by application-owned ordinal role",()=>{
    const secondary="22222222-2222-4222-8222-222222222222";
    const input={...snapshot(),selectedAssets:[...snapshot().selectedAssets,{id:secondary,kind:"IMAGE" as const,label:"Secondary angle",mimeType:"image/jpeg"}]};
    const draft=execution({scenes:execution().scenes.map((scene,index)=>({...scene,referenceRoles:[index===1?"PRODUCT_REFERENCE_2":"PRIMARY_PRODUCT_REFERENCE"]}))});
    const bound=bindCanonicalVisualReferences(input,draft);
    expect(bound.findings).toEqual([]);
    expect(bound.draft.scenes[1]!.referenceAssetIds).toEqual([secondary]);
    expect(assembleCreativeConcept(input,draft).scenes[1]!.referenceAssetIds).toEqual([secondary]);
  });
  it("fails safely for missing or unknown Product reference roles",()=>{
    const missing=execution({scenes:execution().scenes.map((scene,index)=>index===0?{...scene,referenceRoles:[]}:scene)});
    expect(validateConceptExecution(snapshot(),missing).join(" ")).toContain("missing an authoritative reference role");
    const unknown=execution({scenes:execution().scenes.map((scene,index)=>index===0?{...scene,referenceRoles:["UNSELECTED_REFERENCE"]}:scene)});
    expect(validateConceptExecution(snapshot(),unknown).join(" ")).toContain("unknown reference role 'UNSELECTED_REFERENCE'");
  });
  it("accepts the latest CF-000012 execution after replacing its malformed UUID with the canonical role",()=>{
    const latest=execution({
      strategyExecutionSummary:"A mobile-first personalization walkthrough opens on the installed finished sign, assembles pet artwork plus house number, and closes on three completed installed variants with persistent direct-response messaging.",
      voiceScript:"Start with their face. Add your number. Watch pet artwork and address come together in one design made for your home. See each finished sign stay consistent, just uniquely yours. Create yours today.",
      musicCategory:"Warm, modern, light instrumental",
      completedPersonalizedVariantCount:3,
      completedVariantExamples:finishedVariants,
      scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Immediate installed-product hook",generationPrompt:"From frame one, show the supplied finished sign mounted beside a front door on a neutral exterior home-entry wall."}:scene)
    });
    expect(validateConceptExecution(snapshot(),latest)).toEqual([]);
    expect(assembleCreativeConcept(snapshot(),latest).scenes.every((scene)=>scene.referenceAssetIds[0]===assetId)).toBe(true);
  });
  it("rejects a genuine housewarming-gift territory change",()=>{const draft=execution({strategyExecutionSummary:"Moving into a new home? Send the perfect housewarming gift.",voiceScript:"Moving into a new home? Send the perfect moving gift.",scenes:execution().scenes.map((scene)=>({...scene,purpose:"Housewarming gift story",generationPrompt:"Gift box and new homeowner before a generic present."}))});expect(validateConceptExecution(snapshot(),draft).join(" ")).toMatch(/STRATEGY_(SEMANTIC_DRIFT|TERRITORY_CHANGED)/);});
  it("rejects historical price and discount copy",()=>{const findings=validateConceptExecution(snapshot(),execution({voiceScript:"Buy now for $31.49 and get 10% OFF."}));expect(findings.filter((item)=>item.startsWith("UNAUTHORIZED_OFFER"))).toHaveLength(2);});
  it("rejects a wall-sign to garden-stake configuration change",()=>{expect(validateConceptExecution(snapshot(),execution({strategyExecutionSummary:"Turn the pet and number into a personalized garden stake."})).join(" ")).toContain("PRODUCT_CONFIGURATION_CHANGED");});
  it("requires both verified Product truth and explicit visual authority for a garden-stake configuration",()=>{
    const stake=execution({strategyExecutionSummary:`${execution().strategyExecutionSummary} End on a completed garden stake example.`});
    const factOnly:CreativeInputSnapshot={...snapshot(),claims:[{kind:"FEATURE",text:"An optional garden stake mounting configuration is available."}]};
    const visualOnly:CreativeInputSnapshot={...snapshot(),personalizationVisualAuthority:{...snapshot().personalizationVisualAuthority!,immutableStructure:["Wall-sign silhouette","Pet-to-number layout"],authorizedProductConfigurations:["Garden-stake mounted"]}};
    const fullyAuthorized:CreativeInputSnapshot={...visualOnly,claims:factOnly.claims};
    expect(validateConceptExecution(factOnly,stake).join(" ")).toContain("PRODUCT_CONFIGURATION_CHANGED");
    expect(validateConceptExecution(factOnly,stake).join(" ")).not.toContain("without verified Product truth");
    expect(validateConceptExecution(visualOnly,stake).join(" ")).toContain("without verified Product truth");
    expect(validateConceptExecution(visualOnly,stake).join(" ")).not.toContain("PRODUCT_CONFIGURATION_CHANGED");
    expect(validateConceptExecution(fullyAuthorized,stake)).toEqual([]);
  });
  it("rejects execution that ignores approved Product-first repeated-example DNA",()=>{const slow=execution({strategyExecutionSummary:"A slow lifestyle story eventually reveals one sign.",completedPersonalizedVariantCount:0,completedVariantExamples:[],voiceScript:"A quiet walk home ends with decor.",scenes:execution().scenes.map((scene,index)=>({...scene,purpose:index===0?"Empty exterior mood":"Lifestyle continuation",generationPrompt:index===0?"Empty exterior establishing shot before showing the product":"Slow cinematic lifestyle footage",overlayText:""}))});const findings=validateConceptExecution(snapshot(),slow).join(" ");expect(findings).toContain("WINNER_DNA_OPENING_IGNORED");expect(findings).toContain("WINNER_DNA_VARIATION_IGNORED");expect(findings).toContain("WINNER_DNA_SOUND_OFF_IGNORED");});
  it("accepts Product-first personalization proof and variation gallery",()=>expect(validateConceptExecution(snapshot(),execution())).toEqual([]));
  it("does not convert explicit offer or durability prohibitions into positive claims",()=>{const findings=validateConceptExecution(snapshot(),execution({strategyExecutionSummary:"Show pet plus number personalization. Do not show 10% OFF. Do not claim outdoor durability.",voiceScript:"Your pet. Your number. Create yours today.",scenes:execution().scenes.map((scene)=>({...scene,generationPrompt:`${scene.generationPrompt} No price, discount, shipping detail, or guarantee.`}))}));expect(findings.join(" ")).not.toMatch(/UNAUTHORIZED_OFFER|UNSUPPORTED_PRODUCT_CLAIM/);});
  it("treats embedded negative constraints as internal while retaining positive claim detection",()=>{
    const prohibited=execution({voiceScript:"Your pet. Your number. Create yours today.",scenes:execution().scenes.map((scene)=>({...scene,generationPrompt:`${scene.generationPrompt} Keep Product readable without $31.49, 10% OFF, discount, or durability claims.`,accuracyRequirements:["Do not show $31.49.","Do not claim outdoor durability."]}))});
    expect(validateConceptExecution(snapshot(),prohibited).join(" ")).not.toMatch(/UNAUTHORIZED_OFFER|UNSUPPORTED_PRODUCT_CLAIM/);
    expect(validateConceptExecution(snapshot(),execution({voiceScript:"Create yours today for $31.49 and 10% OFF."})).filter((item)=>item.startsWith("UNAUTHORIZED_OFFER"))).toHaveLength(2);
    expect(validateConceptExecution(snapshot(),execution({scenes:execution().scenes.map((scene,index)=>({...scene,overlayText:index===0?"BUILT TO LAST OUTDOORS":scene.overlayText}))})).join(" ")).toContain("UNSUPPORTED_PRODUCT_CLAIM");
  });
  it("still rejects positive durability assertions",()=>{expect(validateConceptExecution(snapshot(),execution({voiceScript:"Built to last outdoors. Your pet and number, made personal."})).join(" ")).toContain("UNSUPPORTED_PRODUCT_CLAIM");});
  it("keeps historical Winner offer evidence non-authoritative",()=>{expect(validateConceptExecution(snapshot(),execution())).toEqual([]);});
  it("rejects a gift-box opening and gifting territory drift for Winner B",()=>{const draft=execution({voiceScript:"Create a meaningful gift for the pet lover in your life.",scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Open a gift box",generationPrompt:"First frame shows the sign inside an open gift box."}:scene)});const findings=validateConceptExecution(snapshot(),draft).join(" ");expect(findings).toContain("STRATEGY_TERRITORY_CHANGED");expect(findings).toContain("WINNER_DNA_INSTALLATION_OPENING_IGNORED");});
  it("recognizes mounted Product-first execution across structured opening fields and still rejects a late reveal",()=>{
    const mounted=execution({scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Establish the personalization proposition",generationPrompt:"9:16 vertical, open on the supplied sign already mounted beside a realistic front door.",overlayText:"THEIR PET. YOUR NUMBER."}:scene)});
    expect(validateConceptExecution(snapshot(),mounted).join(" ")).not.toMatch(/WINNER_DNA_(OPENING|INSTALLATION_OPENING)_IGNORED/);
    const late=execution({scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Lifestyle introduction",generationPrompt:"Empty exterior establishing shot before showing the product later.",overlayText:"WELCOME HOME"}:scene)});
    expect(validateConceptExecution(snapshot(),late).join(" ")).toContain("WINNER_DNA_OPENING_IGNORED");
  });
  it("evaluates installed-opening evidence across Scene 1 fields without treating prohibitions as positive opening content",()=>{
    const opening=(purpose:string,generationPrompt:string,accuracyRequirements:string[]=[])=>execution({scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose,generationPrompt,accuracyRequirements}:scene)});
    expect(validateConceptExecution(snapshot(),opening("Immediate installed result","Mounted beside a front door from frame one.",["Finished Product must be visibly installed in the opening frame."]))).toEqual([]);
    expect(validateConceptExecution(snapshot(),opening("Immediate real-use result","Finished sign installed on an exterior entry wall and visible immediately."))).toEqual([]);
    expect(validateConceptExecution(snapshot(),opening("Immediate installed result","Finished sign mounted next to a porch entrance from the first frame. No gift box, tabletop display, creator-held Product, or unboxing imagery."))).toEqual([]);
    for(const [purpose,prompt] of [
      ["Gift opening","First frame shows the Product inside a gift box."],
      ["Tabletop display","Finished Product immediately visible lying loose on a tabletop."],
      ["Creator introduction","Creator holds the finished Product from the first frame."],
      ["Delayed Product","Product appears at second 3 after an exterior introduction."],
      ["Delayed installed Product","The sign is mounted beside a front door but not visible until later."],
      ["Isolated Product","Finished Product immediately visible floating on an isolated studio background."]
    ]) expect(validateConceptExecution(snapshot(),opening(purpose!,prompt!)).join(" ")).toContain("WINNER_DNA_INSTALLATION_OPENING_IGNORED");
  });
  it("accepts the latest stored CF-000012 attempt after installed-opening polarity correction",()=>{
    const variants=[
      {sceneNumber:1,label:"Installed hero result",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Golden-retriever-style pet artwork"},{field:"House number",value:"Supplied reference house number"},{field:"Street text",value:"Supplied reference street text"}],productStructurePreserved:true},
      {sceneNumber:2,label:"Installed Maple Avenue result",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Distinct alternate pet artwork"},{field:"House number",value:"148"},{field:"Street text",value:"MAPLE AVE"}],productStructurePreserved:true},
      {sceneNumber:3,label:"Installed Oak Lane result",finishedProductVisible:true,personalizationValues:[{field:"Pet artwork",value:"Third distinct pet artwork"},{field:"House number",value:"62"},{field:"Street text",value:"OAK LANE"}],productStructurePreserved:true}
    ];
    const latest=execution({
      strategyExecutionSummary:"A mobile-first personalization walkthrough opens on an installed finished sign, then layers a simple pet to number assembly cue over repeated installed examples. Each example retains the same vertical sign structure while only authorized personalization varies.",
      voiceScript:"Start with their face. Add your number. Together, they become a home detail that feels unmistakably yours. Watch the pet artwork and address come together in one vertical design. Create yours today.",
      musicCategory:"Warm, understated upbeat instrumental",
      completedPersonalizedVariantCount:3,
      completedVariantExamples:variants,
      scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Immediate installed-product hook and clear visual introduction to the two personalization elements.",generationPrompt:"From the first frame, show the supplied finished address sign visibly mounted beside a front door on a high-contrast exterior wall. No price, discount, holiday, gift, packaging, or unboxing imagery.",accuracyRequirements:["Finished product must be installed and visible from frame one in a realistic exterior home-entry context.","Preserve the authoritative product structure."]}:scene)
    });
    expect(validateConceptExecution(snapshot(),latest)).toEqual([]);
  });
  it("keeps the stored CF-000012 result rejected because it lacks completed-variant evidence",()=>{
    expect(validateConceptExecution(snapshot(),storedCf000012RejectedResult)).toEqual([
      "UNSUPPORTED_PRODUCT_CLAIM: execution introduces breed-selection capability without Product authority.",
      "UNSUPPORTED_PRODUCT_CLAIM: execution introduces pet-photo submission capability without Product authority.",
      "WINNER_DNA_VARIATION_IGNORED: approved DNA requires at least two visibly distinct completed Products using only authorized personalization differences while preserving Product structure."
    ]);
  });
  it("rejects the same completed sign repeated three times",()=>{
    const repeated=finishedVariants.map((example)=>({...example,personalizationValues:finishedVariants[0].personalizationValues}));
    expect(validateConceptExecution(snapshot(),execution({completedVariantExamples:repeated})).join(" ")).toContain("WINNER_DNA_VARIATION_IGNORED");
  });
  it("rejects selection/input states followed by only the same completed sign",()=>{
    expect(validateConceptExecution(snapshot(),execution({completedPersonalizedVariantCount:1,completedVariantExamples:[finishedVariants[0]]})).join(" ")).toContain("WINNER_DNA_VARIATION_IGNORED");
  });
  it("rejects background-only changes to the same personalization",()=>{
    const backgrounds=finishedVariants.map((example,index)=>({...example,label:`Room ${index+1}`,personalizationValues:finishedVariants[0].personalizationValues}));
    expect(validateConceptExecution(snapshot(),execution({completedVariantExamples:backgrounds})).join(" ")).toContain("WINNER_DNA_VARIATION_IGNORED");
  });
  it("accepts two visibly distinct completed authorized personalized Products",()=>{
    expect(validateConceptExecution(snapshot(),execution({completedPersonalizedVariantCount:2,completedVariantExamples:finishedVariants.slice(0,2)}))).toEqual([]);
  });
  it("accepts three visibly distinct completed authorized personalized Products",()=>expect(validateConceptExecution(snapshot(),execution())).toEqual([]));
  it("rejects variant evidence that changes an unauthorized Product/SKU structure field",()=>{
    const crossSku=[...finishedVariants.slice(0,2),{...finishedVariants[2],productStructurePreserved:false,personalizationValues:[{field:"Product family/SKU",value:"Garden stake"}]}];
    expect(validateConceptExecution(snapshot(),execution({completedVariantExamples:crossSku})).join(" ")).toContain("WINNER_DNA_VARIATION_IGNORED");
  });
  it("accepts finished variants together with an installed Product-first opening",()=>expect(validateConceptExecution(snapshot(),execution())).toEqual([]));
  it("rejects the 7C.15G-2 gift-setting execution and accepts its neutral installed correction",()=>{
    const rejected=execution({
      strategyExecutionSummary:"Open the finished sign in a real gift/home setting, then show two personalized variants.",
      musicCategory:"Warm festive acoustic instrumental",
      scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Immediate finished-product gift hook",generationPrompt:"Open on the supplied finished sign in a cozy real-life gift setting; Product visible from frame one."}:scene)
    });
    const rejectedFindings=validateConceptExecution(snapshot(),rejected).join(" ");
    expect(rejectedFindings).toContain("STRATEGY_TERRITORY_CHANGED");
    expect(rejectedFindings).toContain("WINNER_DNA_INSTALLATION_OPENING_IGNORED");
    const corrected=execution({
      strategyExecutionSummary:"Open on the installed finished sign at a home entry, then show two personalized variants.",
      musicCategory:"Warm modern lifestyle instrumental",
      scenes:execution().scenes.map((scene,index)=>index===0?{...scene,purpose:"Immediate installed finished-Product hook",generationPrompt:"Open on the supplied finished sign visibly mounted beside a front door at a neutral home entry; Product visible from frame one."}:scene)
    });
    expect(validateConceptExecution(snapshot(),corrected)).toEqual([]);
  });
  it("accepts a corrected synthetic CF-000012 result with three completed variants after removing unsupported capability copy",()=>{
    const corrected={...storedCf000012RejectedResult,voiceScript:"Start with their face, then add your house number. Together, they become a personalized address sign. Create yours today.",completedPersonalizedVariantCount:3,completedVariantExamples:finishedVariants};
    expect(validateConceptExecution(snapshot(),corrected)).toEqual([]);
  });
  it("does not treat visual MAY-VARY permission as consumer capability authority",()=>{
    expect(validateConceptExecution(snapshot(),execution({voiceScript:"Choose from breed designs or upload a pet photo. Create yours today."})).join(" ")).toMatch(/breed-selection capability.*pet-photo submission capability/);
    const authorized:CreativeInputSnapshot={...snapshot(),claims:[{kind:"FEATURE",text:"Customers may choose from breed designs or request artwork from a pet photo."}]};
    expect(validateConceptExecution(authorized,execution({voiceScript:"Choose from breed designs or request artwork from a pet photo. Create yours today."}))).toEqual([]);
  });
  it("bounds safe rejected-result evidence and persists no secrets",async()=>{const repository=new InMemoryFactoryRepository();const draft=execution();const evidence:ConceptProviderOperationEvidence={operationKey:"concept:p:revision:1:generate",projectId:"p",state:"REJECTED",provider:"fake-openai",model:"fake",submittedAt:"2026-01-01T00:00:00.000Z",completedAt:"2026-01-01T00:00:01.000Z",durationMs:1000,usage:{inputTokens:10,outputTokens:20},resultSha256:conceptProviderResultSha256(draft),safeResult:boundedConceptProviderResult(draft),validationFindings:["STRATEGY_SEMANTIC_DRIFT"],rejectionCode:"CONCEPT_STRATEGY_MISMATCH"};await repository.saveConceptProviderOperation(evidence);const stored=await repository.getConceptProviderOperation(evidence.operationKey);expect(stored).toEqual(evidence);expect(JSON.stringify(stored)).not.toMatch(/authorization|api[_-]?key|cookie/i);});
});
