import { createHash } from "node:crypto";
import { DomainError } from "@koolezt/domain";
import type { CreativeConceptDraft, CreativeConceptProviderDraft, CreativeInputSnapshot } from "@koolezt/domain";

const stopWords = new Set(["about","after","again","their","there","these","this","those","through","with","your","into","from","that","what","when","where","which","while","will","product","display","single","strategy","visual","show","using"]);
const factualRiskTerms = /\b(material|steel|aluminum|wood|gauge|thick|durab\w*|outdoor\w*|weather\w*|waterproof|manufactur\w*|factory|shipping|delivery|discount|packag\w*|guarantee|lifetime)\b/gi;
const firstPersonTestimony = /\b(i bought|i ordered|i received|mine arrived|i love mine|we bought|we ordered|this lasted)\b/i;
const historicalOffer = /(?:[$€£]\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d+)?\s*%\s*off\b)/gi;
const territoryGroups = [
  { name: "gifting", expression: /\b(gift|gifting|present|recipient)\b/i },
  { name: "housewarming/moving", expression: /\b(housewarming|moving (?:home|gift)|new homeowner)\b/i },
  { name: "memorial", expression: /\b(memorial|in memory of|remembrance)\b/i },
  { name: "curb appeal", expression: /\bcurb appeal\b/i },
  { name: "durability-led", expression: /\b(durability|built to last|weatherproof)\b/i }
] as const;
const configurationTerms = ["garden stake","yard stake","lawn stake","ground stake","freestanding sign"];
const multipleExamples = /\b(multiple|several|gallery|carousel|variant|variation|examples?|different designs?|personalized signs?)\b/i;
const personalization = /\b(personali[sz]|customi[sz]|pet\s*\+\s*(?:number|address)|(?:number|address)\s*\+\s*pet|assemble|combine)\w*/i;
const immediateProduct = /\b(immediate(?:ly)?|first frame|open(?:ing)?(?: on| with)?|start(?:s|ing)?(?: on| with)?|already visible|finished product|finished sign|product visible|sign visible)\b/i;
const lateProduct = /\b(product appears late|late reveal|reveal later|not visible until later|appears? (?:at|after) (?:second )?\d+|empty exterior|establishing shot before|before showing the product)\b/i;
const installedProduct = /\b(installed|mounted|home[- ]?entry|entryway|front door|exterior wall)\b/i;
const giftBoxOpening = /\b(gift box|gift-box|unbox|unboxing|wrapped present)\b/i;
const prohibition = /\b(?:no\b|do not\b|don't\b|never\b|must not\b|without\b|avoid\b|prohibit\w*\b|forbid\w*\b)/i;
const breedSelectionCapability = /\b(?:(?:choose|select|pick)(?:\s+from)?\s+(?:\d+\+?\s+)?breed(?:\s+(?:designs?|options?|artwork))?|breed\s+(?:selection|designs?|options?))\b/i;
const petPhotoCapability = /\b(?:(?:request|submit|upload|send|provide|use|turn)\b[^.!?;\n]{0,80}\bpet\s+photo|pet[- ]photo\s+(?:artwork|submission|upload|option))\b/i;

function normalize(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9$%]+/g," ").trim(); }
function executionText(draft: CreativeConceptProviderDraft) {
  return [draft.strategyExecutionSummary,draft.voiceScript,...draft.scenes.flatMap((scene)=>[scene.purpose,scene.generationPrompt,scene.overlayText])].filter(Boolean).join("\n");
}
function assertionText(fields: readonly string[]) {
  return fields.flatMap((value)=>value
    .split(/(?:[.!?;]\s+|\n+)/)
    .map((clause)=>clause.trim())
    .map((clause)=>{
      const prohibited=clause.match(prohibition);
      return prohibited?.index===undefined?clause:clause.slice(0,prohibited.index).trim();
    })
    .filter(Boolean)
  ).join("\n");
}
function consumerAssertionText(draft: CreativeConceptProviderDraft) {
  return assertionText([
    draft.strategyExecutionSummary,
    draft.voiceScript,
    ...draft.scenes.flatMap((scene)=>[scene.purpose,scene.generationPrompt,scene.overlayText])
  ].filter((value): value is string => Boolean(value)));
}
function claimAuthorityText(input: CreativeInputSnapshot) {
  return [
    input.productName,
    input.defaultCta,
    ...input.claims.filter((claim)=>claim.kind!=="RESTRICTION").map((claim)=>claim.text),
    ...(input.selectedStrategy?.productTruthConstraints
      .filter((item)=>item.authority==="FACTUAL_CLAIM")
      .map((item)=>item.text)??[])
  ].join("\n");
}
function meaningfulTokens(value: string) {
  return [...new Set(normalize(value).split(/\s+/).filter((token)=>token.length>=4&&!stopWords.has(token)))];
}

function canonicalReferenceRoles(input: CreativeInputSnapshot) {
  return new Map(input.selectedAssets.map((asset,index)=>[index===0?"PRIMARY_PRODUCT_REFERENCE":`PRODUCT_REFERENCE_${index+1}`,asset.id]));
}

/** Resolves provider execution roles to immutable snapshot-owned asset IDs. */
export function bindCanonicalVisualReferences(input: CreativeInputSnapshot, provider: CreativeConceptProviderDraft) {
  if(!input.selectedStrategy)return {draft:provider,findings:[] as string[]};
  const catalog=canonicalReferenceRoles(input);
  const findings:string[]=[];
  const scenes=provider.scenes.map((scene)=>{
    if((scene.referenceAssetIds?.length??0)>0)findings.push(`VISUAL_AUTHORITY_VIOLATION: scene ${scene.sceneNumber} returned provider-owned asset IDs.`);
    const roles=scene.referenceRoles??[];
    if(scene.sourceType==="PRODUCT_IMAGE"&&roles.length===0)findings.push(`VISUAL_AUTHORITY_VIOLATION: scene ${scene.sceneNumber} is missing an authoritative reference role.`);
    const referenceAssetIds=roles.flatMap((role)=>{
      const assetId=catalog.get(role);
      if(!assetId){findings.push(`VISUAL_AUTHORITY_VIOLATION: scene ${scene.sceneNumber} uses unknown reference role '${role}'.`);return [];}
      return [assetId];
    });
    return {...scene,referenceAssetIds};
  });
  return {draft:{...provider,scenes},findings:[...new Set(findings)]};
}

function hasDistinctFinishedPersonalizedVariants(input: CreativeInputSnapshot, draft: CreativeConceptProviderDraft) {
  const authorizedFields=(input.personalizationVisualAuthority?.authorizedPersonalizationFields??[]).map(normalize);
  const examples=draft.completedVariantExamples??[];
  if((draft.completedPersonalizedVariantCount??0)<2||examples.length<2||draft.completedPersonalizedVariantCount!==examples.length)return false;
  if(examples.some((example)=>!example.finishedProductVisible||!example.productStructurePreserved||!example.label.trim()||example.personalizationValues.length===0))return false;
  const normalizedExamples=examples.map((example)=>new Map(example.personalizationValues.map(({field,value})=>[normalize(field),normalize(value)])));
  if(normalizedExamples.some((example)=>[...example.keys()].some((field)=>!authorizedFields.includes(field))||[...example.values()].some((value)=>!value)))return false;
  return authorizedFields.some((field)=>new Set(normalizedExamples.map((example)=>example.get(field)).filter((value):value is string=>Boolean(value))).size>=2);
}

/** Provider-result checksum used for rejected-result audit evidence. */
export function conceptProviderResultSha256(result: CreativeConceptProviderDraft) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

/** Bounded sanitized structured evidence; credentials and transport metadata never enter this function. */
export function boundedConceptProviderResult(result: CreativeConceptProviderDraft): Readonly<Record<string, unknown>> {
  const serialized=JSON.stringify(result);
  if(Buffer.byteLength(serialized,"utf8")<=65_536)return JSON.parse(serialized) as Readonly<Record<string,unknown>>;
  return {truncated:true,byteLength:Buffer.byteLength(serialized,"utf8"),sceneCount:result.scenes.length,resultSha256:conceptProviderResultSha256(result)};
}

/**
 * Validates provider-owned execution semantics. It deliberately does not compare
 * generative copy byte-for-byte with canonical Strategy fields.
 */
export function validateConceptExecution(input: CreativeInputSnapshot, provider: CreativeConceptProviderDraft): readonly string[] {
  const strategy=input.selectedStrategy;
  if(!strategy)return [];
  const bound=bindCanonicalVisualReferences(input,provider);
  const draft=bound.draft;
  const findings:string[]=[...bound.findings];
  if(!draft.strategyExecutionSummary?.trim())findings.push("INVALID_EXECUTION_STRUCTURE: strategyExecutionSummary is required.");
  if(!draft.voiceScript?.trim()||!draft.editingStyleKey?.trim()||!draft.musicCategory?.trim()||draft.targetDurationMs<=0)findings.push("INVALID_EXECUTION_STRUCTURE: narration, duration, editing style, and music direction are required.");
  if(!Array.isArray(draft.scenes)||draft.scenes.length!==3){findings.push("INVALID_EXECUTION_STRUCTURE: exactly three execution scenes are required.");return findings;}
  for(const scene of draft.scenes)if(scene.intendedDurationMs<=0||!scene.purpose?.trim()||!scene.generationPrompt?.trim())findings.push(`INVALID_EXECUTION_STRUCTURE: scene ${scene.sceneNumber} is incomplete.`);
  const execution=executionText(draft);
  const normalizedExecution=normalize(execution);
  const assertions=consumerAssertionText(draft);
  const normalizedAssertions=normalize(assertions);
  const authority=normalize(claimAuthorityText(input));
  const authorizedConfigurations=normalize((input.personalizationVisualAuthority?.authorizedProductConfigurations??[]).join("\n"));
  const strategyTokens=meaningfulTokens([strategy.conceptName,strategy.coreAngle,strategy.hook,strategy.primaryPromise,strategy.proofMechanism].join(" "));
  const matched=strategyTokens.filter((token)=>normalizedExecution.includes(token));
  if(matched.length<Math.min(2,strategyTokens.length))findings.push("STRATEGY_SEMANTIC_DRIFT: execution does not preserve enough of the selected Strategy proposition.");
  const strategyTerritory=[strategy.conceptFamily,strategy.buyerPersona,strategy.coreAngle,strategy.customerDesireOrProblem,strategy.emotionalTerritory,strategy.offerFraming,strategy.differentiationSummary].join(" ");
  for(const territory of territoryGroups)if(territory.expression.test(assertions)&&!territory.expression.test(strategyTerritory))findings.push(`STRATEGY_TERRITORY_CHANGED: execution introduces '${territory.name}'.`);
  if(strategy.primaryProductionMethod==="PERSONALIZATION_DEMO"&&!personalization.test(execution))findings.push("PERSONALIZATION_MISSING: execution does not visibly demonstrate personalization.");

  for(const offer of assertions.match(historicalOffer)??[])if(!authority.includes(normalize(offer)))findings.push(`UNAUTHORIZED_OFFER: execution introduces '${offer}' without current Product authority.`);
  for(const term of assertions.match(factualRiskTerms)??[])if(!authority.includes(normalize(term)))findings.push(`UNSUPPORTED_PRODUCT_CLAIM: execution introduces '${term}' without Product authority.`);
  if(breedSelectionCapability.test(assertions)&&!breedSelectionCapability.test(claimAuthorityText(input)))findings.push("UNSUPPORTED_PRODUCT_CLAIM: execution introduces breed-selection capability without Product authority.");
  if(petPhotoCapability.test(assertions)&&!petPhotoCapability.test(claimAuthorityText(input)))findings.push("UNSUPPORTED_PRODUCT_CLAIM: execution introduces pet-photo submission capability without Product authority.");
  if(firstPersonTestimony.test(assertions))findings.push("FABRICATED_TESTIMONIAL: execution implies unsupported first-person customer experience.");
  for(const term of configurationTerms)if(normalizedAssertions.includes(term)){
    if(!authority.includes(term))findings.push(`UNSUPPORTED_PRODUCT_CLAIM: execution introduces Product configuration '${term}' without verified Product truth.`);
    if(!authorizedConfigurations.includes(term))findings.push(`PRODUCT_CONFIGURATION_CHANGED: execution introduces '${term}' without explicit visual configuration authority.`);
  }

  const selectedAssetIds=new Set(input.selectedAssets.map((asset)=>asset.id));
  for(const scene of draft.scenes)for(const assetId of scene.referenceAssetIds??[])if(!selectedAssetIds.has(assetId))findings.push(`VISUAL_AUTHORITY_VIOLATION: scene ${scene.sceneNumber} references unselected asset '${assetId}'.`);

  const winner=input.selectedWinnerDna;
  const opening=draft.scenes[0];
  const first=assertionText([opening?.purpose,opening?.generationPrompt,opening?.overlayText,...(opening?.accuracyRequirements??[])].filter((value):value is string=>Boolean(value)));
  if(winner?.openingProductVisible&&(!immediateProduct.test(first)||lateProduct.test(first)))findings.push("WINNER_DNA_OPENING_IGNORED: approved DNA requires the Product immediately visible.");
  const winnerText=winner?[winner.openingPattern,...winner.preserveTraits].join(" "):"";
  if(winner&&installedProduct.test(winnerText)&&(!installedProduct.test(first)||!immediateProduct.test(first)||lateProduct.test(first)||giftBoxOpening.test(first)))findings.push("WINNER_DNA_INSTALLATION_OPENING_IGNORED: approved DNA requires opening on the installed finished Product.");
  const requiresVariations=Boolean(winner&&((winner.approximateExampleCount??0)>1||multipleExamples.test(winner.repeatedExamplePattern)||multipleExamples.test(winner.preserveTraits.join(" "))));
  const variationAuthority=(input.personalizationVisualAuthority?.authorizedPersonalizationFields.length??0)>0;
  if(requiresVariations&&(!variationAuthority||!hasDistinctFinishedPersonalizedVariants(input,draft)))findings.push("WINNER_DNA_VARIATION_IGNORED: approved DNA requires at least two visibly distinct completed Products using only authorized personalization differences while preserving Product structure.");
  if(winner?.soundOffComprehension.toLowerCase().includes("strong")&&draft.scenes.every((scene)=>!scene.overlayText.trim()))findings.push("WINNER_DNA_SOUND_OFF_IGNORED: approved DNA requires meaningful sound-off communication.");
  return [...new Set(findings)];
}

/** Canonical application assembly. Strategy fields are copied, never echoed by the provider. */
export function assembleCreativeConcept(input: CreativeInputSnapshot, provider: CreativeConceptProviderDraft): CreativeConceptDraft {
  const strategy=input.selectedStrategy;
  if(!strategy){
    if(!provider.angle?.trim()||!provider.hook?.trim()||!provider.cta?.trim())throw new DomainError("INVALID_CONCEPT","Legacy direct Video Maker output requires angle, hook, and CTA.");
    return {...provider,angle:provider.angle,hook:provider.hook,cta:provider.cta,scenes:provider.scenes.map((scene)=>({...scene,referenceAssetIds:scene.referenceAssetIds??[]}))};
  }
  const findings=validateConceptExecution(input,provider);
  if(findings.length)throw new DomainError("CONCEPT_STRATEGY_MISMATCH",findings.join(" "));
  const bound=bindCanonicalVisualReferences(input,provider).draft;
  return {
    angle:strategy.coreAngle,
    hook:strategy.hook,
    ...(provider.strategyExecutionSummary?{strategyExecutionSummary:provider.strategyExecutionSummary}:{}),
    ...(provider.completedPersonalizedVariantCount!==undefined?{completedPersonalizedVariantCount:provider.completedPersonalizedVariantCount}:{}),
    ...(provider.completedVariantExamples?{completedVariantExamples:provider.completedVariantExamples}:{}),
    targetDurationMs:input.targetDurationMs??provider.targetDurationMs,
    voiceScript:provider.voiceScript,
    cta:input.defaultCta,
    editingStyleKey:provider.editingStyleKey,
    musicCategory:provider.musicCategory,
    scenes:bound.scenes.map((scene)=>({sceneNumber:scene.sceneNumber,intendedDurationMs:scene.intendedDurationMs,purpose:scene.purpose,sourceType:scene.sourceType,generationPrompt:scene.generationPrompt,overlayText:scene.overlayText,referenceAssetIds:scene.referenceAssetIds??[],accuracyRequirements:[...new Set([...scene.accuracyRequirements,...strategy.productTruthConstraints.map((item)=>item.text),...strategy.visualFidelityRequirements.map((item)=>item.text)])]}))
  };
}
