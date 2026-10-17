import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { z, ZodError } from "zod";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import * as archiver from "archiver";
import { compositionRenderInput, conceptEditInput, createProjectFromBriefInput, createProjectInput, durableUploadAuthorizationInput, durableUploadCompletionInput, productInput, productReferenceUploadAuthorizationInput, productReferenceUploadCompletionInput, renderWorkerEnrollmentCreateInput, renderWorkerEnrollmentInput, renderWorkerFailureInput, renderWorkerIdentityInput, renderWorkerLeaseInput, renderWorkerOutputAuthorizationInput, renderWorkerOutputCompletionInput, renderWorkerProgressInput, narrationRewriteInput, narrationScriptInput, sceneContextImageUploadAuthorizationInput, sceneContextImageUploadCompletionInput, sceneGenerationMethodInput, sceneManualUploadInput, sceneRegenerationInput, sceneVideoProviderInput, strategyHandoffInput, strategyOperationInput, strategyReplacementInput, voiceGenerationInput } from "@koolezt/contracts";
import { assessVoiceTiming, calculateSceneTimeline, DEFAULT_SCENE_TRANSITION, DEFAULT_SCENE_TRANSITION_DURATION_MS, DomainError, VARIANT_DIVERSITY_MATRIX, type VariantPackageSlot, type VariantRecipe, type VariantTreatment } from "@koolezt/domain";
import { createRuntime } from "./runtime.js";
import type { BrowserIdentity } from "./browser-auth.js";

type Runtime = ReturnType<typeof createRuntime>;
type AuthenticatedRequest = { headers: Record<string, unknown>; kooleztIdentity?: BrowserIdentity };
const actor = (request: AuthenticatedRequest) => request.kooleztIdentity?.email ?? String(request.headers["x-koolezt-actor"] ?? "development-user");
const role = (request: AuthenticatedRequest) => request.kooleztIdentity?.role;
const ownerOnly = (request: AuthenticatedRequest) => {
  if (request.kooleztIdentity && role(request) !== "OWNER") throw new DomainError("BROWSER_ROLE_FORBIDDEN", "Owner access is required for this action.");
};
const productImageLimit = Number(process.env.PRODUCT_REFERENCE_MAX_BYTES ?? 20 * 1024 * 1024);
const body = <T>(schema: { parse(value: unknown): T }, value: unknown): T => schema.parse(value);
const uploadLimit = Math.max(Number(process.env.PRODUCT_ASSET_MAX_BYTES ?? 100 * 1024 * 1024), Number(process.env.RENDER_WORKER_MAX_OUTPUT_BYTES ?? 500 * 1024 * 1024));
const workerToken = (request: { headers: Record<string, unknown> }) => typeof request.headers.authorization === "string" && request.headers.authorization.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
const legacyWorkerAuthorized = (supplied: string, token: string) => {
  if (!token || !supplied) return false;
  return timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(supplied).digest());
};
const workerAuthorized = async (request: { headers: Record<string, unknown>; body?: unknown }, runtime: Runtime, claimedWorkerId?: string) => {
  const supplied = workerToken(request);
  if (legacyWorkerAuthorized(supplied, runtime.renderWorkerToken)) return true;
  const bodyWorkerId = request.body && typeof request.body === "object" && "workerId" in request.body ? String((request.body as { workerId?: unknown }).workerId ?? "") : "";
  const headerWorkerId = String(request.headers["x-render-worker-id"] ?? "");
  const expectedWorkerId = claimedWorkerId ?? (bodyWorkerId || headerWorkerId || undefined);
  return Boolean(await runtime.renderWorkerIdentities?.authenticate(supplied, expectedWorkerId));
};
const mediaTypes = new Map([
  ["image/png", { kind: "IMAGE" as const, extension: "png", signature: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) }],
  ["image/jpeg", { kind: "IMAGE" as const, extension: "jpg", signature: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([255,216,255])) }],
  ["image/webp", { kind: "IMAGE" as const, extension: "webp", signature: (b: Buffer) => b.subarray(0, 4).equals(Buffer.from("RIFF")) && b.subarray(8, 12).equals(Buffer.from("WEBP")) }],
  ["video/mp4", { kind: "VIDEO" as const, extension: "mp4", signature: (b: Buffer) => b.subarray(4, 8).equals(Buffer.from("ftyp")) }],
  ["video/webm", { kind: "VIDEO" as const, extension: "webm", signature: (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([26,69,223,163])) }]
]);

const supportsManualExternalVideo = (sourceType: string) => ["AI_VIDEO", "KLING_VIDEO", "PRODUCT_IMAGE"].includes(sourceType);
const normalizeHostname = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");
const isWorkerApiPath = (url: string) => url === "/api/render-worker/v1" || url.startsWith("/api/render-worker/v1/");
export function buildServer(runtime: Runtime = createRuntime()) {
  const app = Fastify({ logger: true });
  const browserHostname = normalizeHostname(process.env.CREATIVE_BROWSER_HOST ?? "creative.printwlove.com");
  const renderWorkerHostname = normalizeHostname(process.env.RENDER_WORKER_HOST ?? "worker.printwlove.com");
  const internalHostnames = new Set(["127.0.0.1", "localhost", "::1"]);
  app.addHook("onRequest", async (request, reply) => {
    const hostname = normalizeHostname(request.hostname);
    const workerPath = isWorkerApiPath(request.url);
    const externalHostname = hostname === browserHostname || hostname === renderWorkerHostname;
    const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0]?.trim().toLowerCase();
    if (externalHostname && forwardedProtocol !== "https") return reply.code(426).send({ error: "HTTPS_REQUIRED", message: "HTTPS is required." });
    if (hostname === renderWorkerHostname && !workerPath) return reply.code(404).send({ error: "NOT_FOUND", message: "Not found." });
    if (hostname === browserHostname && workerPath) return reply.code(404).send({ error: "NOT_FOUND", message: "Not found." });
    if (!internalHostnames.has(hostname) && hostname !== browserHostname && hostname !== renderWorkerHostname) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "Not found." });
    }
  });
  const allowedBrowserOrigins = new Set((process.env.CREATIVE_BROWSER_ORIGINS ?? "https://creative.printwlove.com,http://127.0.0.1:3100,http://localhost:3100").split(",").map((value) => value.trim()).filter(Boolean));
  app.register(cors, { origin: (origin, callback) => callback(null, !origin || allowedBrowserOrigins.has(origin)) });
  app.register(multipart, { limits: { files: 1, fileSize: uploadLimit }, attachFieldsToBody: false });
  app.register(staticPlugin, { root: resolve(process.cwd(), "dist/web"), prefix: "/" });
  app.addHook("preHandler", async (request, reply) => {
    if (!runtime.browserAuth || request.url === "/health" || request.url.startsWith("/api/render-worker/v1/")) return;
    const assertion = String(request.headers["cf-access-jwt-assertion"] ?? "");
    if (!assertion) return reply.code(401).send({ error: "BROWSER_AUTH_REQUIRED", message: "Sign in through the Creative Factory access page." });
    try { (request as unknown as AuthenticatedRequest).kooleztIdentity = await runtime.browserAuth.verify(assertion); }
    catch (error) { const code = error instanceof DomainError ? error.code : "BROWSER_AUTH_INVALID"; return reply.code(code === "BROWSER_ACCESS_DENIED" ? 403 : 401).send({ error: code, message: error instanceof Error ? error.message : "Browser authentication failed." }); }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Strict-Transport-Security", "max-age=31536000"); reply.header("X-Content-Type-Options", "nosniff"); reply.header("Referrer-Policy", "strict-origin-when-cross-origin"); reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://*.amazonaws.com https://*.s3.amazonaws.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_INPUT", details: error.issues });
    if (error instanceof DomainError) return reply.code(error.code.endsWith("NOT_FOUND") ? 404 : error.code.includes("FORBIDDEN") || error.code.includes("ACCESS_DENIED") ? 403 : 409).send({ error: error.code, message: error.message });
    request.log.error({
      errorCode: "INTERNAL_ERROR",
      errorName: error instanceof Error ? error.name : "UnknownError",
      frameworkErrorCode: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined,
      frameworkStatusCode: typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined,
      method: request.method,
      requestId: request.id,
      route: request.routeOptions.url ?? "unmatched"
    }, "Unhandled API request error");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "The operation could not be completed." });
  });
  app.get("/health", async () => ({ ok: true, providers: "server-configured" }));
  app.get("/api/session", async (request) => ({ email: actor(request as unknown as AuthenticatedRequest), role: role(request as unknown as AuthenticatedRequest) ?? "DEVELOPMENT" }));
  app.get("/api/products", async () => runtime.service.listProducts());
  const normalizeProduct = (input: ReturnType<typeof productInput.parse>) => ({ name: input.name, slug: input.slug, description: input.description, claims: input.claims, defaultCta: input.defaultCta, ...(input.creativeNotes ? { creativeNotes: input.creativeNotes } : {}), ...(input.personalizationVisualAuthority ? { personalizationVisualAuthority: { status: input.personalizationVisualAuthority.status, immutableStructure: input.personalizationVisualAuthority.immutableStructure, authorizedPersonalizationFields: input.personalizationVisualAuthority.authorizedPersonalizationFields, ...(input.personalizationVisualAuthority.authorizedProductConfigurations ? { authorizedProductConfigurations: input.personalizationVisualAuthority.authorizedProductConfigurations } : {}) } } : {}), assets: input.assets.map((asset) => ({ ...asset, id: asset.id ?? randomUUID() })) });
  app.post("/api/products", async (request) => runtime.service.createProduct(normalizeProduct(body(productInput, request.body))));
  app.put("/api/products/:id", async (request) => runtime.service.updateProduct((request.params as { id: string }).id, normalizeProduct(body(productInput, request.body))));
  app.post("/api/products/:id/assets", async (request) => {
    const productId = (request.params as { id: string }).id;
    const part = await request.file();
    if (!part) throw new DomainError("UPLOAD_REQUIRED", "Provide one image or source-video file.");
    const policy = mediaTypes.get(part.mimetype.toLowerCase());
    if (!policy) throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Allowed formats: PNG, JPEG, WebP, MP4, and WebM.");
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.byteLength === 0) throw new DomainError("INVALID_UPLOAD", "Upload is empty or exceeds the configured size limit.");
    if (!policy.signature(bytes)) throw new DomainError("INVALID_MEDIA_SIGNATURE", "File content does not match its declared media type.");
    const assetId = randomUUID();
    const asset = await runtime.storage.put(`products/${productId}/${assetId}.${policy.extension}`, {
      bytes, mimeType: part.mimetype.toLowerCase(), extension: policy.extension,
      metadata: { projectId: productId, purpose: "PRODUCT_ASSET", originalFilename: part.filename.slice(0, 255), uploadedBy: actor(request) }
    });
    const product = await runtime.service.getProduct(productId);
    await runtime.service.updateProduct(productId, { name: product.name, slug: product.slug, description: product.description, claims: product.claims, defaultCta: product.defaultCta, ...(product.creativeNotes ? { creativeNotes: product.creativeNotes } : {}), ...(product.personalizationVisualAuthority ? { personalizationVisualAuthority: product.personalizationVisualAuthority } : {}), assets: [...product.assets, { id: asset.id, kind: policy.kind, label: part.filename.slice(0, 160) || `${policy.kind} asset`, storageKey: asset.storageKey, mimeType: asset.mimeType }] });
    return runtime.service.getProduct(productId);
  });
  app.get("/api/projects", async () => Promise.all((await runtime.service.listProjects()).map(async (project) => ({
    ...project,
    campaignStrategyBatchIds: (await runtime.strategyService.list(project.id)).map(({ batch }) => batch.id)
  }))));
  app.get("/api/projects/:id", async (request) => {
    const project = await runtime.service.getProjectWithConceptStatus((request.params as { id: string }).id);
    return { ...project, campaignStrategyBatchIds: (await runtime.strategyService.list(project.id)).map(({ batch }) => batch.id) };
  });
  const performanceInput=z.object({spend:z.number().nonnegative().optional(),purchases:z.number().nonnegative().optional(),purchaseCpa:z.number().nonnegative().optional(),revenue:z.number().nonnegative().optional(),roas:z.number().nonnegative().optional(),linkCtr:z.number().nonnegative().optional(),cpc:z.number().nonnegative().optional(),cpm:z.number().nonnegative().optional(),currency:z.string().trim().max(8).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),metricSource:z.string().trim().max(160).optional()});
  const creativeReferenceMetadataInput=z.object({displayName:z.string().trim().min(1).max(160),operatorStatus:z.enum(["WINNER","CONTROL","REFERENCE","LOSER"]),operatorNotes:z.string().max(4000).optional(),operatorTranscript:z.string().max(20000).optional(),platform:z.string().max(80).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),performance:performanceInput.optional()});
  const creativeReferenceUploadAuthorizationInput=z.object({filename:z.string().trim().min(1).max(255),mimeType:z.enum(["video/mp4","video/webm"]),byteSize:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
  const creativeReferenceUploadCompletionInput=creativeReferenceMetadataInput.extend({assetId:z.string().uuid()});
  const dnaDraftInput=z.object({openingPattern:z.string().min(1).max(500),openingProductVisible:z.boolean(),approximateProductRevealMs:z.number().int().nonnegative().optional(),visualHookMechanism:z.string().min(1).max(500),productProminence:z.string().min(1).max(500),personalizationVisibility:z.string().min(1).max(500),repeatedExamplePattern:z.string().min(1).max(500),approximateExampleCount:z.number().int().nonnegative().optional(),pacingPattern:z.string().min(1).max(500),beatStructure:z.string().min(1).max(700),overlayTextPattern:z.string().min(1).max(500),offerVisibilityPattern:z.string().min(1).max(500),ctaPattern:z.string().min(1).max(500),proofPattern:z.string().min(1).max(500),visualFormat:z.string().min(1).max(300),lifestyleVsProductBalance:z.string().min(1).max(500),soundOffComprehension:z.string().min(1).max(500),directResponsePattern:z.string().min(1).max(500),closingPattern:z.string().min(1).max(500),preserveTraits:z.array(z.string().min(1).max(300)).max(12),safeToVaryTraits:z.array(z.string().min(1).max(300)).max(12),avoidTraits:z.array(z.string().min(1).max(300)).max(12),sourceEvidence:z.array(z.object({kind:z.enum(["VISUAL_FRAME","MEDIA_METADATA","VISIBLE_TEXT","OPERATOR_TRANSCRIPT","OPERATOR_NOTE"]),observation:z.string().min(1).max(500),timestampMs:z.number().int().nonnegative().optional(),endTimestampMs:z.number().int().nonnegative().optional(),frameSha256:z.string().length(64).optional()})).max(30)});
  app.get("/api/creative-references",async(request)=>{const query=request.query as{projectId?:unknown};const projectId=typeof query.projectId==="string"?query.projectId:undefined;if(projectId)await runtime.service.getProject(projectId);return Promise.all((await runtime.creativeDnaService.list(projectId)).map(async(entry)=>{const asset=await runtime.storage.getAsset(entry.reference.sourceAssetId);const durationMs=Number(asset.metadata.durationMs);return{...entry,sourceMedia:{filename:String(asset.metadata.originalFilename??"Historical source video"),status:asset.lifecycleStatus??"AVAILABLE",mimeType:asset.mimeType,byteSize:asset.byteSize,...(Number.isFinite(durationMs)&&durationMs>0?{durationMs}:{})}};}));});
  app.get("/api/creative-references/approved",async(request)=>{const query=request.query as{projectId?:unknown;productId?:unknown};const projectId=typeof query.projectId==="string"?query.projectId:undefined;const project=projectId?await runtime.service.getProject(projectId):undefined;const productId=project?.productId??(typeof query.productId==="string"?query.productId:undefined);return runtime.creativeDnaService.listApproved(productId,projectId);});
  app.post("/api/projects/:id/creative-references/upload",async(request)=>{if(!runtime.durableMediaStore)throw new DomainError("DIRECT_UPLOAD_DISABLED","Direct durable upload is not enabled.");const projectId=(request.params as{id:string}).id;await runtime.service.getProject(projectId);const input=body(creativeReferenceUploadAuthorizationInput,request.body);if(input.byteSize>uploadLimit)throw new DomainError("INVALID_UPLOAD","Creative Reference video exceeds the configured size limit.");const policy=mediaTypes.get(input.mimeType);const extension=input.filename.split(".").at(-1)?.toLowerCase();if(!policy||policy.kind!=="VIDEO"||extension!==policy.extension)throw new DomainError("UNSUPPORTED_MEDIA_TYPE","Creative References accept MP4 or WebM video only.");const target=await runtime.durableMediaStore.createUpload({projectId,purpose:"CREATIVE_REFERENCE",kind:"VIDEO",mimeType:input.mimeType,extension:policy.extension,byteSize:input.byteSize,sha256:input.sha256,originalFilename:input.filename,metadata:{uploadedBy:actor(request)}});return{assetId:target.asset.id,method:target.method,url:target.url,headers:target.headers,expiresAt:target.expiresAt};});
  app.post("/api/projects/:id/creative-references/complete",async(request)=>{if(!runtime.durableMediaStore)throw new DomainError("DIRECT_UPLOAD_DISABLED","Direct durable upload is not enabled.");const projectId=(request.params as{id:string}).id;const input=body(creativeReferenceUploadCompletionInput,request.body);let ownedAsset=false;try{const asset=await runtime.durableMediaStore.completeUpload(input.assetId);if(asset.projectId!==projectId||asset.purpose!=="CREATIVE_REFERENCE"||asset.kind!=="VIDEO")throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH","Uploaded asset does not belong to this Creative Reference.");ownedAsset=true;const policy=mediaTypes.get(asset.mimeType);const bytes=Buffer.from(await runtime.storage.read(asset.storageKey));if(!policy||policy.kind!=="VIDEO"||!policy.signature(bytes)){await runtime.durableMediaStore.rejectUpload(asset.id,"Video signature verification failed.");throw new DomainError("INVALID_MEDIA_SIGNATURE","File content does not match its declared video type.");}const{assetId,...metadata}=input;return await runtime.creativeDnaService.register({projectId,assetId,...metadata,actor:actor(request)});}catch(error){if(ownedAsset)await runtime.durableMediaStore.deleteAsset(input.assetId).catch(()=>undefined);throw error;}});
  app.post("/api/projects/:id/creative-references",async(request)=>{const projectId=(request.params as{id:string}).id;const part=await request.file();if(!part)throw new DomainError("UPLOAD_REQUIRED","Provide one historical ad video.");const mimeType=part.mimetype.toLowerCase();const policy=mediaTypes.get(mimeType);const extension=part.filename.split(".").at(-1)?.toLowerCase();if(!policy||policy.kind!=="VIDEO"||extension!==policy.extension)throw new DomainError("UNSUPPORTED_MEDIA_TYPE","Creative References accept MP4 or WebM video only.");const bytes=await part.toBuffer();if(part.file.truncated||!bytes.byteLength||!policy.signature(bytes))throw new DomainError("INVALID_MEDIA_SIGNATURE","Historical ad content does not match its declared video type.");const fields=part.fields as Record<string,{value?:unknown}>;const metadata=body(z.object({displayName:z.string().trim().min(1).max(160),operatorStatus:z.enum(["WINNER","CONTROL","REFERENCE","LOSER"]),operatorNotes:z.string().max(4000).optional(),operatorTranscript:z.string().max(20000).optional(),platform:z.string().max(80).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),performance:performanceInput.optional()}),{displayName:fields.displayName?.value,operatorStatus:fields.operatorStatus?.value,operatorNotes:fields.operatorNotes?.value,operatorTranscript:fields.operatorTranscript?.value,platform:fields.platform?.value,dateStart:fields.dateStart?.value,dateEnd:fields.dateEnd?.value,...(typeof fields.performance?.value==="string"?{performance:JSON.parse(fields.performance.value)}:{})});await runtime.service.getProject(projectId);const asset=await runtime.storage.put(`projects/${projectId}/creative-references/${randomUUID()}.${policy.extension}`,{bytes,mimeType,extension:policy.extension,metadata:{projectId,purpose:"CREATIVE_REFERENCE",originalFilename:part.filename.slice(0,255),uploadedBy:actor(request)}});try{return await runtime.creativeDnaService.register({projectId,assetId:asset.id,...metadata,actor:actor(request)});}catch(error){await runtime.durableMediaStore?.deleteAsset(asset.id).catch(()=>undefined);throw error;}});
  app.post("/api/creative-references/:id/analyze",async(request,reply)=>{const input=body(z.object({requestId:z.string().uuid()}),request.body);return reply.code(202).send(await runtime.creativeDnaService.requestAnalysis((request.params as{id:string}).id,input.requestId));});
  app.put("/api/creative-references/:id/dna",async(request)=>runtime.creativeDnaService.edit((request.params as{id:string}).id,body(dnaDraftInput,request.body),actor(request)));
  app.post("/api/creative-references/:id/dna/:revisionId/approve",async(request)=>runtime.creativeDnaService.approve((request.params as{id:string;revisionId:string}).id,(request.params as{id:string;revisionId:string}).revisionId,actor(request)));
  app.delete("/api/projects/:id", async (request) => { ownerOnly(request as unknown as AuthenticatedRequest); const projectId=(request.params as { id: string }).id; const confirmation=String((request.body as { confirmation?: unknown } | undefined)?.confirmation ?? ""); const project=await runtime.service.getProject(projectId); if(confirmation!==project.publicId) throw new DomainError("PROJECT_DELETE_CONFIRMATION_REQUIRED", "Type the exact project ID to delete it."); await runtime.projectArchive.archive(projectId,actor(request as unknown as AuthenticatedRequest)); return { id: projectId, archived: true }; });
  const packageInput = z.object({ angleName: z.string().trim().min(1).max(160), hook: z.string().trim().min(1).max(160), narrationText: z.string().trim().min(1).max(10_000), cta: z.string().trim().min(1).max(160), secondaryOverlay: z.string().trim().max(160).optional() });
  const packageSlots = ["A", "B", "C", "D"] as const;
  // These OpenAI TTS voices are deliberately chosen per package so a
  // Creative Diversity batch has four distinct performances.
  const variantVoicePresets = ["marin", "cedar", "coral", "alloy"] as const;
  const variantVoicePresetBySlot: Record<VariantPackageSlot, (typeof variantVoicePresets)[number]> = { A: "marin", B: "cedar", C: "coral", D: "alloy" };
  const variantVoiceInput = z.object({ voicePreset: z.enum(variantVoicePresets).optional() });
  const currentPackage = async (projectId: string, slot: VariantPackageSlot) => {
    const item = (await runtime.variantPackages.list(projectId)).find((candidate) => candidate.slot === slot);
    if (!item) throw new DomainError("VARIANT_PACKAGE_NOT_READY", `Creative Package ${slot} has not been created.`);
    return item;
  };
  const generatePackageVoice = async (projectId: string, slot: VariantPackageSlot, requestActor: string, voicePreset = variantVoicePresetBySlot[slot], force = false) => {
    const item = await currentPackage(projectId, slot); const revision = item.currentRevision;
    const inFlight = item.voices.find((voice) => ["PENDING", "REVIEW"].includes(voice.status));
    if (inFlight) return inFlight;
    const accepted = item.voices.find((voice) => voice.status === "ACCEPTED");
    if (!force && accepted?.voicePreset === voicePreset) return accepted;
    const voice = await runtime.variantPackages.createVoice({ packageRevisionId: revision.id, provider: process.env.VOICE_PROVIDER === "openai" ? "openai" : "fake", model: process.env.OPENAI_VOICE_MODEL ?? "configured", voicePreset, actor: requestActor });
    try {
      const submission = await runtime.voiceProvider.submit({ voiceProfileId: voicePreset, script: revision.narrationText, instructions: "Warm, natural and engaging social-media ad voice. Friendly and conversational, with confident pacing. Avoid exaggerated announcer delivery." }, { operationKey: `variant-voice:${voice.id}`, projectId, targetId: voice.id });
      const status = await runtime.voiceProvider.getStatus(submission.providerTaskId);
      if (status.state !== "SUCCEEDED") throw new DomainError("VARIANT_VOICE_GENERATION_FAILED", status.state === "FAILED" ? status.message : "Variant voice is still processing; retry only after checking the provider state.");
      const asset = await runtime.storage.put(`projects/${projectId}/variant-voices/${voice.id}.${status.result.extension}`, { ...status.result, metadata: { ...status.result.metadata, projectId, purpose: "VARIANT_VOICE", creativePackageRevisionId: revision.id, variantVoiceId: voice.id } });
      const inspection = await runtime.mediaInspector.inspectAudio(asset, { maxDurationMs: 120_000 });
      if (!inspection.passed) throw new DomainError("VARIANT_VOICE_QA_FAILED", "Generated package voice failed audio QA.");
      return runtime.variantPackages.completeVoice(voice.id, { providerTaskId: submission.providerTaskId, providerMetadata: submission.metadata, audioAssetId: asset.id, checksum: asset.sha256, durationMs: inspection.durationMs });
    } catch (error) { await runtime.variantPackages.failVoice(voice.id, error instanceof Error ? error.message : "Voice generation failed."); throw error; }
  };
  app.get("/api/projects/:id/variant-packages", async (request) => runtime.variantPackages.list((request.params as { id: string }).id));
  app.post("/api/projects/:id/variant-packages/:slot", async (request) => {
    const slot = (request.params as { slot: string }).slot as VariantPackageSlot; if (!packageSlots.includes(slot)) throw new DomainError("VARIANT_PACKAGE_SLOT_INVALID", "Creative package slot must be A, B, C, or D.");
    const input = packageInput.parse(request.body); return runtime.variantPackages.saveRevision({ projectId: (request.params as { id: string }).id, slot, angleName: input.angleName, hook: input.hook, narrationText: input.narrationText, cta: input.cta, ...(input.secondaryOverlay ? { secondaryOverlay: input.secondaryOverlay } : {}), source: "MANUAL", actor: actor(request as unknown as AuthenticatedRequest) });
  });
  app.post("/api/projects/:id/variant-packages/:slot/rewrite", async (request) => {
    const projectId = (request.params as { id: string }).id;
    const slot = (request.params as { slot: string }).slot as VariantPackageSlot;
    if (!packageSlots.includes(slot)) throw new DomainError("VARIANT_PACKAGE_SLOT_INVALID", "Creative package slot must be A, B, C, or D.");
    const item = await currentPackage(projectId, slot);
    const project = await runtime.service.getProject(projectId);
    const product = await runtime.service.getProduct(project.productId);
    const concept = project.concepts.find((candidate) => candidate.id === project.currentConceptId);
    const targetDurationMs = concept?.targetDurationMs ?? (project.creativeBrief?.targetDurationSeconds ?? 15) * 1_000;
    const rewrite = runtime.creativeProvider.rewriteNarration;
    if (!rewrite) throw new DomainError("NARRATION_REWRITE_UNAVAILABLE", "Narration rewrite is not configured for this Creative Provider.");
    const timing = assessVoiceTiming(targetDurationMs);
    const operationKey = `variant-package-rewrite:${projectId}:${slot}:${item.currentRevision.id}:${randomUUID()}`;
    const result = await rewrite.call(runtime.creativeProvider, {
      script: item.currentRevision.narrationText, targetDurationMs,
      recommendedMinimumMs: timing.minimumMs, recommendedMaximumMs: timing.maximumMs,
      productName: product.name, ...(project.creativeBrief?.creativeTopic ? { creativeTopic: project.creativeBrief.creativeTopic } : {}),
      ...(project.creativeBrief?.productDetails ? { productDetails: project.creativeBrief.productDetails } : {}), cta: item.currentRevision.cta
    }, { operationKey, projectId, targetId: item.currentRevision.id });
    const narrationText = result.script.trim();
    if (!narrationText) throw new DomainError("OPENAI_NARRATION_REWRITE_INVALID", "OpenAI returned an empty package narration rewrite.");
    return runtime.variantPackages.saveRevision({ projectId, slot, angleName: item.currentRevision.angleName, hook: item.currentRevision.hook, narrationText, cta: item.currentRevision.cta, ...(item.currentRevision.secondaryOverlay ? { secondaryOverlay: item.currentRevision.secondaryOverlay } : {}), source: "OPENAI", providerMetadata: { provider: result.submission.provider, model: result.submission.model, requestId: result.submission.requestId, operationKey, promptVersion: "variant-narration-rewrite/v1" }, actor: actor(request as unknown as AuthenticatedRequest) });
  });  app.post("/api/projects/:id/variant-packages/generate", async (request) => {
    const projectId = (request.params as { id: string }).id; const project = await runtime.service.getProject(projectId); const concept = project.concepts.find((item) => item.id === project.currentConceptId);
    const product = await runtime.service.getProduct(project.productId); const generator = runtime.creativeProvider.generateVariantPackages;
    if (!concept || !generator) throw new DomainError("VARIANT_COPY_GENERATION_UNAVAILABLE", "Configured creative provider cannot generate variant copy.");
    const result = await generator.call(runtime.creativeProvider, { productName: product.name, ...(product.description ? { productDetails: product.description } : {}), ...(project.creativeBrief?.creativeTopic ? { creativeTopic: project.creativeBrief.creativeTopic } : {}), approvedConcept: { angle: concept.angle, hook: concept.hook, voiceScript: concept.voiceScript, cta: concept.cta }, scenes: concept.scenes.map((scene) => ({ purpose: scene.purpose, generationPrompt: scene.generationPrompt })), targetDurationMs: concept.targetDurationMs }, { operationKey: `variant-copy:${projectId}:${randomUUID()}`, projectId, targetId: "creative-packages" });
    const slots = result.packages.map((item) => item.slot).sort().join(""); if (result.packages.length !== 4 || slots !== "ABCD") throw new DomainError("VARIANT_COPY_GENERATION_INVALID", "Exactly four complete creative packages are required.");
    for (const item of result.packages) await runtime.variantPackages.saveRevision({ ...item, projectId, source: "OPENAI", providerMetadata: { provider: result.submission.provider, model: result.submission.model, requestId: result.submission.requestId, operationKey: result.submission.metadata.operationKey }, actor: actor(request as unknown as AuthenticatedRequest) });
    return runtime.variantPackages.list(projectId);
  });
  app.post("/api/projects/:id/variant-packages/:slot/voice/generate", async (request) => {
    const slot = (request.params as { slot: string }).slot as VariantPackageSlot;
    if (!packageSlots.includes(slot)) throw new DomainError("VARIANT_PACKAGE_SLOT_INVALID", "Creative package slot must be A, B, C, or D.");
    const input = variantVoiceInput.parse(request.body ?? {});
    return generatePackageVoice((request.params as { id: string }).id, slot, actor(request as unknown as AuthenticatedRequest), input.voicePreset ?? variantVoicePresetBySlot[slot], true);
  });
  app.post("/api/projects/:id/variant-packages/voices/generate", async (request) => {
    const input = z.object({ voicePresets: z.record(z.enum(packageSlots), z.enum(variantVoicePresets)).optional() }).parse(request.body ?? {});
    const projectId = (request.params as { id: string }).id; const results=[]; for (const slot of packageSlots) results.push(await generatePackageVoice(projectId, slot, actor(request as unknown as AuthenticatedRequest), input.voicePresets?.[slot] ?? variantVoicePresetBySlot[slot])); return results;
  });
  app.post("/api/variant-package-voices/:id/accept", async (request) => runtime.variantPackages.acceptVoice((request.params as { id: string }).id));
  app.delete("/api/variant-batches/:id", async (request) => {
    ownerOnly(request as unknown as AuthenticatedRequest);
    const batch=await runtime.variantFactory.getBatch((request.params as { id: string }).id);
    if(!batch) throw new DomainError("VARIANT_BATCH_NOT_FOUND","Variant batch was not found.");
    const label=`B${String(batch.batchSequence).padStart(2,"0")}`;
    const confirmation=String((request.body as { confirmation?: unknown } | undefined)?.confirmation??"");
    if(confirmation!==label) throw new DomainError("VARIANT_BATCH_DELETE_CONFIRMATION_REQUIRED",`Type ${label} to delete this batch.`);
    try { await runtime.variantFactory.archive(batch.id,actor(request as unknown as AuthenticatedRequest)); }
    catch(error) {
      if(error instanceof Error&&error.message==="VARIANT_BATCH_DELETE_IN_PROGRESS") throw new DomainError("VARIANT_BATCH_DELETE_IN_PROGRESS","A render in this batch is still active. Wait for it to finish before deleting.");
      if(error instanceof Error&&error.message==="VARIANT_BATCH_NOT_FOUND") throw new DomainError("VARIANT_BATCH_NOT_FOUND","Variant batch was not found.");
      throw error;
    }
    return {id:batch.id,archived:true};
  });  app.get("/api/projects/:id/variants", async (request) => runtime.variantFactory.list((request.params as { id: string }).id));
  app.post("/api/projects/:id/variants", async (request) => {
    const projectId = (request.params as { id: string }).id; const input = z.object({ requestId: z.string().uuid() }).parse(request.body);
    const project = await runtime.service.getProject(projectId); const concept = project.concepts.find((item) => item.id === project.currentConceptId);
    const accepted = project.scenes.slice().sort((a,b)=>a.sceneNumber-b.sceneNumber).map((scene) => scene.attempts.find((attempt) => attempt.id === scene.approvedAttemptId));
    if (!concept || accepted.length !== 3 || accepted.some((attempt) => !attempt?.outputAssetId || attempt.status !== "ACCEPTED" || !attempt.inspection?.passed)) throw new DomainError("VARIANT_INPUTS_NOT_READY", "Three accepted QA-passed scenes are required.");
    const packages=await runtime.variantPackages.list(projectId); if(packages.length!==4 || packageSlots.some(slot=>!packages.some(item=>item.slot===slot))) throw new DomainError("VARIANT_PACKAGES_NOT_READY","Create all four current creative packages before rendering.");
    const packageBySlot=new Map(packages.map(item=>[item.slot,item])); const voiceBySlot=new Map<VariantPackageSlot, NonNullable<Awaited<ReturnType<typeof runtime.variantPackages.getCurrentAcceptedVoice>>>>();
    for(const slot of packageSlots){ const packageItem=packageBySlot.get(slot)!; const voice=await runtime.variantPackages.getCurrentAcceptedVoice(packageItem.currentRevision.id); if(!voice?.audioAssetId||!voice.checksum||!voice.durationMs) throw new DomainError("VARIANT_VOICES_NOT_READY",`Creative Package ${slot} needs a current accepted voice.`); voiceBySlot.set(slot,voice); }
    const sceneAssets=await Promise.all(accepted.map((attempt)=>runtime.storage.getAsset(attempt!.outputAssetId!))); const voiceAssets=new Map<VariantPackageSlot, Awaited<ReturnType<typeof runtime.storage.getAsset>>>(); for(const [slot,voice] of voiceBySlot) voiceAssets.set(slot,await runtime.storage.getAsset(voice.audioAssetId!));
    // Deliberately distinct, bounded motion families. These values are copied into each immutable B02+ recipe.
    const transforms=(treatment:VariantTreatment,index:number)=> treatment==="PUSH_IN" ? {treatment,startScale:index===0?1:1.03,endScale:index===0?1.16:1.13,panX:0.5,panY:0.5,endPanX:0.5,endPanY:0.5} : treatment==="REFRAME_PAN" ? {treatment,startScale:1.16,endScale:1.16,panX:index%2?0.92:0.08,panY:0.5,endPanX:index%2?0.08:0.92,endPanY:0.5} : treatment==="ALTERNATE_ZOOM" ? {treatment,startScale:index===0?1.18:1.13,endScale:index===0?1:1.02,panX:0.5,panY:0.5,endPanX:index%2?0.7:0.3,endPanY:0.5} : {treatment,startScale:index===0?1.18:1.12,endScale:index===0?1.04:1.03,panX:0.5,panY:0.5,endPanX:0.5,endPanY:0.5,startOffsetMs:index===0?600:250};
    const snapshot={projectId,recipeVersion:"variant-v2",sourceAttemptIds:accepted.map(item=>item!.id),sourceChecksums:sceneAssets.map(item=>item.sha256),packages:packages.map(item=>({slot:item.slot,revisionId:item.currentRevision.id,voiceId:voiceBySlot.get(item.slot)!.id,voiceChecksum:voiceBySlot.get(item.slot)!.checksum})),targetDurationMs:concept.targetDurationMs}; const sourceHash=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"); const provisionalBatchId=randomUUID();
    const variants=VARIANT_DIVERSITY_MATRIX.map((matrix,index)=>{const item=packageBySlot.get(matrix.slot)!;const packageVoice=voiceBySlot.get(matrix.slot)!;const recipe:VariantRecipe={recipeVersion:"variant-v2",projectId,batchId:provisionalBatchId,variantId:randomUUID(),targetDurationMs:concept.targetDurationMs,sceneOrder:matrix.sceneOrder,scenes:matrix.sceneOrder.map((sceneNumber,position)=>({sourceAttemptId:accepted[sceneNumber-1]!.id,sourceChecksum:sceneAssets[sceneNumber-1]!.sha256,transform:transforms(matrix.treatment,position)})),hook:item.currentRevision.hook,cta:item.currentRevision.cta,voice:{attemptId:packageVoice.id,checksum:packageVoice.checksum!,durationMs:packageVoice.durationMs!},package:{slot:matrix.slot,packageRevisionId:item.currentRevision.id,angle:item.currentRevision.angleName,narration:item.currentRevision.narrationText,...(item.currentRevision.secondaryOverlay?{secondaryOverlay:item.currentRevision.secondaryOverlay}:{}),variantVoiceId:packageVoice.id},transition:{type:"SOFT_DISSOLVE",durationMs:500}};return{id:recipe.variantId,ordinal:index+1,publicId:`${project.publicId}-BXX-V${String(index+1).padStart(2,"0")}`,recipe,recipeHash:createHash("sha256").update(JSON.stringify(recipe)).digest("hex"),openingScene:matrix.openingScene,treatmentFamily:matrix.treatment,hook:recipe.hook,cta:recipe.cta};});
    const created=await runtime.variantFactory.create({projectId,projectPublicId:project.publicId,batchId:provisionalBatchId,operationKey:`variant-batch:${projectId}:${input.requestId}`,createdBy:actor(request as unknown as AuthenticatedRequest),sourceSnapshot:snapshot,sourceSnapshotSha256:sourceHash,recipeVersion:"variant-v2",variants});
    for(const item of created.variants){const recipe=item.recipe; const packageVoice=voiceBySlot.get(recipe.package!.slot)!; const voiceAsset=voiceAssets.get(recipe.package!.slot)!; const inputSnapshot={templateVersion:"variant-v2",sceneInputs:recipe.scenes.map((scene,position)=>({attemptId:scene.sourceAttemptId,assetId:accepted.find(a=>a!.id===scene.sourceAttemptId)!.outputAssetId!,sha256:scene.sourceChecksum,intendedDurationMs:calculateSceneTimeline(recipe.targetDurationMs,3,500)[position]!,sourceDurationMs:accepted.find(a=>a!.id===scene.sourceAttemptId)!.inspection?.durationMs})),narration:{voiceGenerationId:packageVoice.id,assetId:packageVoice.audioAssetId!,sha256:voiceAsset.sha256,captionTimings:[],durationMs:packageVoice.durationMs!},timeline:{transition:"SOFT_DISSOLVE" as const,transitionDurationMs:500,narrationLeadInMs:assessVoiceTiming(recipe.targetDurationMs,packageVoice.durationMs!).leadInMs},marketingOverlays:[recipe.hook,...(recipe.package?.secondaryOverlay?[recipe.package.secondaryOverlay]:[])],cta:recipe.cta,target:{width:1080,height:1920,durationMs:recipe.targetDurationMs}};const job=await runtime.desktopRenderJobs.ensure({projectId,variantId:item.id,requiredCapability:"variant-effects-v1",operationKey:`variant:${item.id}:render`,snapshot:inputSnapshot});await runtime.variantFactory.setJob(item.id,job.id);}
    return runtime.variantFactory.list(projectId);
  });  app.post("/api/variants/:id/retry", async (request) => {
    const variantId=(request.params as {id:string}).id; const original=await runtime.variantFactory.getVariant(variantId); if(!original) throw new DomainError("VARIANT_NOT_FOUND","Variant was not found.");
    const retry=await runtime.variantFactory.beginRetry(variantId); if(!retry) throw new DomainError("VARIANT_RETRY_NOT_AVAILABLE","Only failed variants can be retried.");
    const batch=await runtime.variantFactory.getBatch(retry.batchId); if(!batch) throw new DomainError("VARIANT_BATCH_NOT_FOUND","Variant batch was not found."); const project=await runtime.service.getProject(batch.projectId);
    const attempts=project.scenes.flatMap((scene)=>scene.attempts);
    const sourceAttempts=retry.recipe.scenes.map((scene)=>attempts.find((attempt)=>attempt.id===scene.sourceAttemptId));
    const packageVoice=retry.recipe.package ? await runtime.variantPackages.getVoice(retry.recipe.package.variantVoiceId) : undefined;
    const projectVoice=packageVoice ? undefined : project.voiceGenerations.find((item)=>item.id===retry.recipe.voice.attemptId);
    const voiceAssetId=packageVoice?.audioAssetId ?? projectVoice?.outputAssetId;
    if(sourceAttempts.some((attempt)=>!attempt?.outputAssetId)||!voiceAssetId) throw new DomainError("VARIANT_INPUTS_UNAVAILABLE","The immutable variant inputs are no longer available.");
    const inputSnapshot={templateVersion:retry.recipe.recipeVersion,sceneInputs:retry.recipe.scenes.map((scene,position)=>({attemptId:scene.sourceAttemptId,assetId:sourceAttempts[position]!.outputAssetId!,sha256:scene.sourceChecksum,intendedDurationMs:calculateSceneTimeline(retry.recipe.targetDurationMs,3,500)[position]!,sourceDurationMs:sourceAttempts[position]!.inspection?.durationMs})),narration:{voiceGenerationId:packageVoice?.id ?? projectVoice!.id,assetId:voiceAssetId,sha256:retry.recipe.voice.checksum,captionTimings:[],durationMs:retry.recipe.voice.durationMs ?? 0},timeline:{transition:"SOFT_DISSOLVE" as const,transitionDurationMs:500,narrationLeadInMs:assessVoiceTiming(retry.recipe.targetDurationMs,retry.recipe.voice.durationMs ?? 0).leadInMs},marketingOverlays:[retry.recipe.hook,...(retry.recipe.package?.secondaryOverlay?[retry.recipe.package.secondaryOverlay]:[])],cta:retry.recipe.cta,target:{width:1080,height:1920,durationMs:retry.recipe.targetDurationMs}};    const job=await runtime.desktopRenderJobs.ensure({projectId:batch.projectId,variantId:retry.id,requiredCapability:"variant-effects-v1",operationKey:`variant:${retry.id}:retry:${retry.retryCount}`,snapshot:inputSnapshot}); await runtime.variantFactory.setJob(retry.id,job.id); return runtime.variantFactory.getVariant(retry.id);
  });
  app.post("/api/projects", async (request) => { const input = body(createProjectInput, request.body); return runtime.service.createProject({ productId: input.productId, selectedProductAssetIds: input.selectedProductAssetIds, preferredVoiceProfileId: input.preferredVoiceProfileId, ...(input.additionalInstructions ? { additionalInstructions: input.additionalInstructions } : {}), actor: actor(request) }); });
  app.post("/api/projects/from-brief", async (request) => {
    const input = body(createProjectFromBriefInput, request.body);
    return runtime.service.createProjectFromBrief({ ...input, actor: actor(request) });
  });
  app.get("/api/projects/:id/strategy-batches", async (request) => runtime.strategyService.list((request.params as {id:string}).id));
  app.post("/api/projects/:id/strategy-batches", async (request, reply) => {
    const input=body(strategyOperationInput,request.body); const batch=await runtime.strategyService.createBatch((request.params as {id:string}).id,input.requestId,actor(request),input.requestedCount); return reply.code(202).send(batch);
  });
  app.post("/api/strategy-batches/:id/replace-flagged", async (request, reply) => {
    const input=body(strategyReplacementInput,request.body); const batch=await runtime.strategyService.requestReplacement((request.params as {id:string}).id,input.requestId,actor(request)); return reply.code(202).send(batch);
  });
  app.post("/api/strategy-batches/:id/handoff", async (request) => {
    const input=body(strategyHandoffInput,request.body); return runtime.strategyService.handoff((request.params as {id:string}).id,input.revisionIds,input.requestId,actor(request),input.winnerDnaRevisionId);
  });
  app.post("/api/projects/:id/product-references/upload", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const projectId = (request.params as { id: string }).id;
    const project = await runtime.service.getProject(projectId);
    if (project.state !== "DRAFT" || project.concepts.length > 0) {
      throw new DomainError("PRODUCT_REFERENCE_LOCKED", "Product references cannot change after concept generation begins.");
    }
    const input = body(productReferenceUploadAuthorizationInput, request.body);
    if (input.byteSize > productImageLimit) throw new DomainError("INVALID_UPLOAD", "Product reference exceeds the configured image size limit.");
    const policy = mediaTypes.get(input.mimeType);
    if (!policy || policy.kind !== "IMAGE") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Product references accept PNG, JPEG, or WebP images only.");
    for (const assetId of project.selectedProductAssetIds) {
      const existing = await runtime.storage.getAsset(assetId).catch(() => undefined);
      if (existing?.purpose === "PRODUCT_REFERENCE" && existing.sha256 === input.sha256 && Number(existing.metadata.referenceOrder) === input.order) {
        return { assetId: existing.id, uploaded: true };
      }
    }
    const target = await runtime.durableMediaStore.createUpload({
      projectId,
      purpose: "PRODUCT_REFERENCE",
      kind: "IMAGE",
      mimeType: input.mimeType,
      extension: policy.extension,
      byteSize: input.byteSize,
      sha256: input.sha256,
      originalFilename: input.filename,
      metadata: { referenceOrder: input.order, uploadedBy: actor(request) }
    });
    return { assetId: target.asset.id, method: target.method, url: target.url, headers: target.headers, expiresAt: target.expiresAt };
  });
  app.post("/api/projects/:id/product-references/complete", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const projectId = (request.params as { id: string }).id;
    const input = body(productReferenceUploadCompletionInput, request.body);
    const asset = await runtime.durableMediaStore.completeUpload(input.assetId);
    if (asset.projectId !== projectId || asset.purpose !== "PRODUCT_REFERENCE" || asset.kind !== "IMAGE" || Number(asset.metadata.referenceOrder) !== input.order) {
      throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH", "Product reference does not belong to this project.");
    }
    const policy = mediaTypes.get(asset.mimeType);
    const bytes = Buffer.from(await runtime.storage.read(asset.storageKey));
    if (!policy || policy.kind !== "IMAGE" || !policy.signature(bytes)) {
      await runtime.durableMediaStore.rejectUpload(asset.id, "Image signature verification failed.");
      throw new DomainError("INVALID_MEDIA_SIGNATURE", "File content does not match its declared image type.");
    }
    return runtime.service.attachProductReference({ projectId, asset, label: input.label, order: input.order, actor: actor(request) });
  });
  app.put("/api/projects/:id/product-references/:assetId/primary", async (request) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    return runtime.service.setPrimaryProductReference(id, assetId, actor(request));
  });
  app.post("/api/projects/:id/concept", async (request) => runtime.service.generateConcept((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/concept/reset", async (request) => runtime.service.resetConceptForRegeneration((request.params as { id: string }).id, actor(request)));
  app.put("/api/projects/:id/concept", async (request) => runtime.service.editConcept((request.params as { id: string }).id, Object.fromEntries(Object.entries(body(conceptEditInput, request.body)).filter(([, value]) => value !== undefined)), actor(request)));
  app.post("/api/projects/:id/concept/approve", async (request) => runtime.service.approveConcept((request.params as { id: string }).id, actor(request)));
  app.put("/api/projects/:id/scenes/:sceneId/video-provider", async (request) => {
    const input = body(sceneVideoProviderInput, request.body);
    return runtime.service.setSceneVideoProvider((request.params as { id: string }).id, (request.params as { sceneId: string }).sceneId, input.provider, actor(request), input.model);
  });
  app.put("/api/projects/:id/scenes/:sceneId/generation-method", async (request) => {
    const input = body(sceneGenerationMethodInput, request.body);
    const { id: projectId, sceneId } = request.params as { id: string; sceneId: string };
    if (input.method === "api") {
      const project = await runtime.service.getProject(projectId);
      const attempt = project.scenes.find((item) => item.id === sceneId)?.attempts.at(-1);
      if (attempt && ["AI_VIDEO", "KLING_VIDEO"].includes(attempt.sourceType) && !attempt.inputAssetId) {
        throw new DomainError("SCENE_CONTEXT_IMAGE_REQUIRED", "Create and attach the scene context image before starting AI video generation.");
      }
      if (attempt && ["AI_VIDEO", "KLING_VIDEO"].includes(attempt.sourceType) && attempt.providerMetadata?.contextProductFidelityConfirmed !== true) {
        throw new DomainError("SCENE_CONTEXT_FIDELITY_UNCONFIRMED", "Confirm that the context image uses the exact authoritative finished Product before starting AI video generation.");
      }
    }
    return runtime.service.setSceneGenerationMethod(projectId, sceneId, input.method === "manual" ? "MANUAL" : "API", actor(request));
  });
  const assertContextImageIntent = async (projectId: string, sceneId: string) => {
    const project = await runtime.service.getProject(projectId);
    if (!["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"].includes(project.state)) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_NOT_ALLOWED", "This project is not accepting scene context images.");
    }
    const scene = project.scenes.find((item) => item.id === sceneId);
    const attempt = scene?.attempts.at(-1);
    if (!scene || !attempt || !supportsManualExternalVideo(attempt.sourceType)) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_NOT_APPLICABLE", "Only a video-capable scene accepts a context image.");
    }
    if (attempt.status !== "PENDING") {
      throw new DomainError("SCENE_CONTEXT_IMAGE_LOCKED", "Create a new scene attempt before replacing its context image.");
    }
    const concept = project.concepts.find((item) => item.id === project.currentConceptId);
    const spec = concept?.scenes.find((item) => item.sceneNumber === scene.sceneNumber);
    const sourceReferenceAssetIds = spec?.referenceAssetIds.filter((assetId) => project.selectedProductAssetIds.includes(assetId)) ?? [];
    if (sourceReferenceAssetIds.length === 0) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_SOURCE_MISSING", "This scene has no canonical Product image to anchor the context image.");
    }
    return { project, scene, attempt, sourceReferenceAssetIds };
  };
  app.post("/api/projects/:id/scenes/:sceneId/context-image/upload", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const { id: projectId, sceneId } = request.params as { id: string; sceneId: string };
    const intent = await assertContextImageIntent(projectId, sceneId);
    const input = body(sceneContextImageUploadAuthorizationInput, request.body);
    if (input.byteSize > productImageLimit) throw new DomainError("INVALID_UPLOAD", "Scene context image exceeds the configured image size limit.");
    const policy = mediaTypes.get(input.mimeType);
    if (!policy || policy.kind !== "IMAGE") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Scene context images accept PNG, JPEG, or WebP files only.");
    if (intent.attempt.inputAssetId) {
      const existing = await runtime.storage.getAsset(intent.attempt.inputAssetId).catch(() => undefined);
      if (existing?.purpose === "SCENE_CONTEXT_IMAGE" && existing.sha256 === input.sha256 && existing.metadata.productFidelityConfirmed === true) return { assetId: existing.id, uploaded: true };
    }
    const target = await runtime.durableMediaStore.createUpload({
      projectId,
      purpose: "SCENE_CONTEXT_IMAGE",
      kind: "IMAGE",
      mimeType: input.mimeType,
      extension: policy.extension,
      byteSize: input.byteSize,
      sha256: input.sha256,
      originalFilename: input.filename,
      metadata: { sceneId, attemptId: intent.attempt.id, sourceReferenceAssetIds: intent.sourceReferenceAssetIds, productFidelityConfirmed: input.productFidelityConfirmed, uploadedBy: actor(request) }
    });
    return { assetId: target.asset.id, method: target.method, url: target.url, headers: target.headers, expiresAt: target.expiresAt };
  });
  app.post("/api/projects/:id/scenes/:sceneId/context-image/complete", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const { id: projectId, sceneId } = request.params as { id: string; sceneId: string };
    const intent = await assertContextImageIntent(projectId, sceneId);
    const input = body(sceneContextImageUploadCompletionInput, request.body);
    const asset = await runtime.durableMediaStore.completeUpload(input.assetId);
    if (asset.projectId !== projectId || asset.purpose !== "SCENE_CONTEXT_IMAGE" || asset.kind !== "IMAGE" || asset.metadata.sceneId !== sceneId || asset.metadata.attemptId !== intent.attempt.id || asset.metadata.productFidelityConfirmed !== true) {
      throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH", "Uploaded context image does not belong to this scene attempt.");
    }
    const policy = mediaTypes.get(asset.mimeType);
    const bytes = Buffer.from(await runtime.storage.read(asset.storageKey));
    if (!policy || policy.kind !== "IMAGE" || !policy.signature(bytes)) {
      await runtime.durableMediaStore.rejectUpload(asset.id, "Image signature verification failed.");
      throw new DomainError("INVALID_MEDIA_SIGNATURE", "File content does not match its declared image type.");
    }
    return runtime.service.attachSceneContextImage({ projectId, sceneId, asset, actor: actor(request) });
  });
  const assertManualUploadIntent = async (projectId: string, sceneId: string) => {
    const project = await runtime.service.getProject(projectId);
    if (!["SCENES_GENERATING", "SCENES_REVIEW", "SCENES_APPROVED"].includes(project.state)) {
      throw new DomainError("SCENE_MANUAL_UPLOAD_NOT_ALLOWED", "This project is not accepting scene uploads.");
    }
    const scene = project.scenes.find((item) => item.id === sceneId);
    const attempt = scene?.attempts.at(-1);
    if (!scene || !attempt || !supportsManualExternalVideo(attempt.sourceType)) {
      throw new DomainError("SCENE_MANUAL_UPLOAD_NOT_APPLICABLE", "Only this project's external-video scene accepts a manual upload.");
    }
    if ((attempt.generationMethod ?? "MANUAL") !== "MANUAL") {
      throw new DomainError("SCENE_MANUAL_UPLOAD_DISABLED", "Select Manual / External before uploading.");
    }
    if (!attempt.inputAssetId) {
      throw new DomainError("SCENE_CONTEXT_IMAGE_REQUIRED", "Create and attach the scene context image before uploading generated video.");
    }
    if (attempt.providerMetadata?.contextProductFidelityConfirmed !== true) {
      throw new DomainError("SCENE_CONTEXT_FIDELITY_UNCONFIRMED", "Confirm that the context image uses the exact authoritative finished Product before uploading generated video.");
    }
    if (["SUBMITTED", "PROCESSING", "REVIEW", "ACCEPTED"].includes(attempt.status)) {
      throw new DomainError("SCENE_MANUAL_UPLOAD_LOCKED", "Create a new attempt before replacing reviewed media.");
    }
    return project;
  };
  app.post("/api/projects/:id/scenes/:sceneId/manual-video/upload", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const { id: projectId, sceneId } = request.params as { id: string; sceneId: string };
    await assertManualUploadIntent(projectId, sceneId);
    const input = body(durableUploadAuthorizationInput, request.body);
    if (input.byteSize > uploadLimit) throw new DomainError("INVALID_UPLOAD", "Upload exceeds the configured size limit.");
    const policy = mediaTypes.get(input.mimeType);
    if (!policy || policy.kind !== "VIDEO") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Manual scene upload accepts MP4 or WebM video only.");
    const target = await runtime.durableMediaStore.createUpload({
      projectId,
      purpose: "SCENE_VIDEO",
      kind: "VIDEO",
      mimeType: input.mimeType,
      extension: policy.extension,
      byteSize: input.byteSize,
      sha256: input.sha256,
      originalFilename: input.filename,
      metadata: { sceneId, uploadedBy: actor(request), manualProvider: input.provider, ...(input.model ? { manualModel: input.model } : {}) }
    });
    return { assetId: target.asset.id, method: target.method, url: target.url, headers: target.headers, expiresAt: target.expiresAt };
  });
  app.post("/api/projects/:id/scenes/:sceneId/manual-video/complete", async (request) => {
    if (!runtime.durableMediaStore) throw new DomainError("DIRECT_UPLOAD_DISABLED", "Direct durable upload is not enabled.");
    const { id: projectId, sceneId } = request.params as { id: string; sceneId: string };
    await assertManualUploadIntent(projectId, sceneId);
    const input = body(durableUploadCompletionInput, request.body);
    const asset = await runtime.durableMediaStore.completeUpload(input.assetId);
    if (asset.projectId !== projectId || asset.purpose !== "SCENE_VIDEO" || asset.metadata.sceneId !== sceneId) {
      throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH", "Uploaded asset does not belong to this project scene.");
    }
    return runtime.service.uploadManualSceneVideo({ projectId, sceneId, asset, provider: input.provider, ...(input.model ? { model: input.model } : {}), actor: actor(request) });
  });
  app.post("/api/projects/:id/scenes/:sceneId/manual-video", async (request) => {
    const projectId = (request.params as { id: string }).id;
    const sceneId = (request.params as { sceneId: string }).sceneId;
    const part = await request.file();
    if (!part) throw new DomainError("UPLOAD_REQUIRED", "Provide one manually generated video file.");
    const policy = mediaTypes.get(part.mimetype.toLowerCase());
    if (!policy || policy.kind !== "VIDEO") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Manual scene upload accepts MP4 or WebM video only.");
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.byteLength === 0) throw new DomainError("INVALID_UPLOAD", "Upload is empty or exceeds the configured size limit.");
    if (!policy.signature(bytes)) throw new DomainError("INVALID_MEDIA_SIGNATURE", "File content does not match its declared media type.");
    // Multipart fields are guaranteed to have been parsed after the file stream
    // is consumed. The browser sends provenance first, but this ordering keeps
    // the endpoint safe for a normal multipart client as well.
    const fields = part.fields as Record<string, { value?: unknown }>;
    const input = body(sceneManualUploadInput, { provider: fields.provider?.value, ...(typeof fields.model?.value === "string" && fields.model.value ? { model: fields.model.value } : {}) });
    const assetId = randomUUID();
    const asset = await runtime.storage.put(`projects/${projectId}/scenes/${sceneId}/manual/${assetId}.${policy.extension}`, {
      bytes, mimeType: part.mimetype.toLowerCase(), extension: policy.extension,
      metadata: { projectId, purpose: "SCENE_VIDEO", originalFilename: part.filename.slice(0, 255), uploadedBy: actor(request), manualProvider: input.provider }
    });
    return runtime.service.uploadManualSceneVideo({ projectId, sceneId, asset, provider: input.provider, ...(input.model ? { model: input.model } : {}), actor: actor(request) });
  });
  app.post("/api/projects/:id/scenes/:sceneId/regenerate", async (request) => {
    const input = body(sceneRegenerationInput, request.body);
    return runtime.service.regenerateScene((request.params as { id: string }).id, (request.params as { sceneId: string }).sceneId, input.prompt, actor(request), input.generationMethod === "manual" ? "MANUAL" : input.generationMethod === "api" ? "API" : undefined);
  });
  app.post("/api/projects/:id/scenes/:sceneId/approve", async (request) => runtime.service.approveScene((request.params as { id: string }).id, (request.params as { sceneId: string }).sceneId, String((request.body as { attemptId?: string })?.attemptId ?? ""), actor(request)));
  app.post("/api/projects/:id/scenes/:sceneId/reject", async (request) => runtime.service.rejectSceneAttempt((request.params as { id: string }).id, (request.params as { sceneId: string }).sceneId, String((request.body as { attemptId?: string })?.attemptId ?? ""), actor(request)));
  app.post("/api/projects/:id/voice/generate", async (request) => {
    const input = body(voiceGenerationInput, request.body ?? {});
    return runtime.service.generateVoice((request.params as { id: string }).id, actor(request), { ...(input.voiceProfileId ? { voiceProfileId: input.voiceProfileId } : {}), ...(input.script ? { script: input.script } : {}), ...(input.instructions ? { instructions: input.instructions } : {}) });
  });
  app.post("/api/projects/:id/voice/script", async (request) => {
    const input = body(narrationScriptInput, request.body);
    return runtime.service.saveNarrationScript((request.params as { id: string }).id, input.script, actor(request));
  });
  app.post("/api/projects/:id/voice/rewrite", async (request) => {
    const input = body(narrationRewriteInput, request.body);
    return runtime.service.rewriteNarrationToFit((request.params as { id: string }).id, input.script, actor(request));
  });
  app.post("/api/projects/:id/voice/review", async (request) => runtime.service.beginVoiceReview((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/voice/:voiceId/approve", async (request) => runtime.service.approveVoice((request.params as { id: string }).id, (request.params as { voiceId: string }).voiceId, actor(request)));
  app.post("/api/projects/:id/voice/:voiceId/reject", async (request) => runtime.service.rejectVoice((request.params as { id: string }).id, (request.params as { voiceId: string }).voiceId, actor(request)));
  app.post("/api/projects/:id/editor-complete", async (request) => runtime.service.markEditorWorkComplete((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/voice/regenerate", async (request) => runtime.service.regenerateVoice((request.params as { id: string }).id, String((request.body as { voiceProfileId?: string })?.voiceProfileId ?? "female-ugc"), actor(request)));
  app.post("/api/projects/:id/composition/review", async (request) => runtime.service.beginCompositionReview((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/render", async (request) => runtime.service.renderFinal((request.params as { id: string }).id, actor(request), body(compositionRenderInput, request.body ?? {}).provider));
  app.post("/api/projects/:id/render-again", async (request) => runtime.service.renderAgain((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/render/candidate/discard", async (request) => runtime.service.discardCandidateRender((request.params as { id: string }).id, actor(request)));
  app.post("/api/projects/:id/ready", async (request) => { ownerOnly(request as unknown as AuthenticatedRequest); return runtime.service.approveAndSave((request.params as { id: string }).id, actor(request as unknown as AuthenticatedRequest)); });
  app.post("/api/projects/:id/submit-owner-review", async (request) => runtime.service.submitForOwnerReview((request.params as { id: string }).id, actor(request as unknown as AuthenticatedRequest)));
  app.post("/api/projects/:id/request-another-version", async (request) => { ownerOnly(request as unknown as AuthenticatedRequest); return runtime.service.requestAnotherVersion((request.params as { id: string }).id, actor(request as unknown as AuthenticatedRequest)); });
  app.get("/api/projects/:id/download", async (request, reply) => {
    ownerOnly(request as unknown as AuthenticatedRequest);
    const project = await runtime.service.getProject((request.params as { id: string }).id);
    if (project.state !== "READY" || !project.readyFile?.assetId || !project.currentRenderId) throw new DomainError("READY_DOWNLOAD_UNAVAILABLE", "Only the current published READY video can be downloaded.");
    const render = project.renders.find((candidate) => candidate.id === project.currentRenderId);
    if (!render?.outputAssetId || render.outputAssetId !== project.readyFile.assetId || render.outputSha256 !== project.readyFile.sha256) throw new DomainError("READY_DOWNLOAD_INVALID", "The published final no longer matches its reviewed checksum.");
    const product = await runtime.service.getProduct(project.productId); const filename = `${project.publicId}-${product.name}`.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 170) + ".mp4";
    const asset = await runtime.storage.getAsset(project.readyFile.assetId);
    if (asset.projectId !== project.id || asset.sha256 !== project.readyFile.sha256 || asset.mimeType !== "video/mp4") throw new DomainError("READY_DOWNLOAD_INVALID", "The published final failed download validation.");
    if (asset.storageProvider === "s3" && runtime.durableMediaStore) return reply.redirect((await runtime.durableMediaStore.getDownloadReference(asset.id, { downloadFilename: filename })).url);
    return reply.header("Content-Type", "video/mp4").header("Content-Disposition", `attachment; filename="${filename}"`).send(Buffer.from(await runtime.storage.read(asset.storageKey)));
  });
  app.get("/api/render-worker-installer", async (request, reply) => {
    ownerOnly(request as unknown as AuthenticatedRequest);
    const installerPath = resolve(process.env.RENDER_WORKER_INSTALLER_PATH ?? "dist/KooleztCreativeFactoryRenderWorker-1.2.4-Setup.exe");
    if (!existsSync(installerPath)) throw new DomainError("RENDER_WORKER_INSTALLER_NOT_FOUND", "The Render Worker installer is not staged on this release.");
    return reply.header("Content-Type", "application/vnd.microsoft.portable-executable").header("Content-Length", statSync(installerPath).size).header("Content-Disposition", "attachment; filename=\"KooleztCreativeFactoryRenderWorker-Setup.exe\"").send(createReadStream(installerPath));
  });
  app.get("/api/render-workers/status", async () => (await runtime.renderWorkerIdentities?.list() ?? []).map(({ id, displayName, runtimeState, lastSeenAt, workerVersion, protocolVersion, encoders, capabilities, revokedAt }) => ({ id, displayName, runtimeState, lastSeenAt, workerVersion, protocolVersion, encoders, capabilities, revoked: Boolean(revokedAt) })));
  app.get("/api/render-workers", async (request) => { ownerOnly(request as unknown as AuthenticatedRequest); return runtime.renderWorkerIdentities?.list() ?? []; });
  app.post("/api/render-workers/enrollments", async (request) => { ownerOnly(request as unknown as AuthenticatedRequest); const input=body(renderWorkerEnrollmentCreateInput,request.body); if(!runtime.renderWorkerIdentities) throw new DomainError("WORKER_ENROLLMENT_UNAVAILABLE","Render Worker enrollment is unavailable."); return runtime.renderWorkerIdentities.createEnrollment(input.displayName,actor(request as unknown as AuthenticatedRequest)); });
  app.delete("/api/render-workers/:workerId", async (request,reply) => { ownerOnly(request as unknown as AuthenticatedRequest); if(!runtime.renderWorkerIdentities) throw new DomainError("WORKER_ENROLLMENT_UNAVAILABLE","Render Worker enrollment is unavailable."); await runtime.renderWorkerIdentities.revoke((request.params as {workerId:string}).workerId); return reply.code(204).send(); });
  app.post("/api/render-worker/v1/enroll", async (request) => { const input=body(renderWorkerEnrollmentInput,request.body); if(!runtime.renderWorkerIdentities) throw new DomainError("WORKER_ENROLLMENT_UNAVAILABLE","Render Worker enrollment is unavailable."); const enrolled=await runtime.renderWorkerIdentities.enroll({ setupCode: input.setupCode, workerVersion: input.workerVersion, protocolVersion: input.protocolVersion, ...(input.machineName ? { machineName: input.machineName } : {}) }); return { protocolVersion: "render-worker/v1", workerId: enrolled.worker.id, token: enrolled.token }; });  app.post("/api/render-worker/v1/register", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const input = body(renderWorkerIdentityInput, request.body);
    const enrolled = await runtime.renderWorkerIdentities?.authenticate(workerToken(request), input.workerId);
    if (enrolled) await runtime.renderWorkerIdentities!.heartbeat(input.workerId, { workerVersion: input.workerVersion, protocolVersion: input.protocolVersion, encoders: input.encoders, capabilities: input.capabilities, runtimeState: "IDLE" });
    return { protocolVersion: input.protocolVersion, accepted: true, leaseMs: runtime.renderWorkerLeaseMs };
  });
  app.post("/api/render-worker/v1/jobs/claim", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const input = body(renderWorkerIdentityInput, request.body);
    const enrolled = await runtime.renderWorkerIdentities?.authenticate(workerToken(request), input.workerId);
    if (enrolled) await runtime.renderWorkerIdentities!.heartbeat(input.workerId, { workerVersion: input.workerVersion, protocolVersion: input.protocolVersion, encoders: input.encoders, capabilities: input.capabilities, runtimeState: "IDLE" });
    const claim = await runtime.desktopRenderJobs.claim(input.workerId, runtime.renderWorkerLeaseMs, input.capabilities);
    if (claim && enrolled) await runtime.renderWorkerIdentities!.heartbeat(input.workerId, { workerVersion: input.workerVersion, protocolVersion: input.protocolVersion, encoders: input.encoders, capabilities: input.capabilities, runtimeState: "BUSY" });
    if (!claim) return reply.code(204).send();
    const project = await runtime.service.getProject(claim.job.projectId);
    const snapshot = claim.job.inputSnapshot;
    const workerAsset = async (assetId: string, extra: Readonly<Record<string, unknown>>) => {
      const asset = await runtime.storage.getAsset(assetId);
      const downloadPath = `/api/render-worker/v1/jobs/${claim.job.id}/assets/${assetId}`;
      if (asset.storageProvider === "s3" && runtime.durableMediaStore) {
        const reference = await runtime.durableMediaStore.getDownloadReference(assetId);
        return { ...extra, assetId, downloadPath, downloadUrl: reference.url, downloadExpiresAt: reference.expiresAt };
      }
      return { ...extra, assetId, downloadPath };
    };
    const timeline = snapshot.timeline ?? { transition: DEFAULT_SCENE_TRANSITION, transitionDurationMs: DEFAULT_SCENE_TRANSITION_DURATION_MS, narrationLeadInMs: assessVoiceTiming(snapshot.target.durationMs, snapshot.narration.durationMs).leadInMs };
    const sceneDurations = calculateSceneTimeline(snapshot.target.durationMs, snapshot.sceneInputs.length, timeline.transition === "CUT" ? 0 : timeline.transitionDurationMs);
    const voiceTiming = assessVoiceTiming(snapshot.target.durationMs, snapshot.narration.durationMs);
    const scenes = await Promise.all(snapshot.sceneInputs.map((item, index) => workerAsset(item.assetId, {
      position: index, sha256: item.sha256, durationMs: sceneDurations[index], ...(item.sourceDurationMs ? { sourceDurationMs: item.sourceDurationMs } : {})
    })));
    const narration = await workerAsset(snapshot.narration.assetId, { sha256: snapshot.narration.sha256, ...(snapshot.narration.durationMs ? { durationMs: snapshot.narration.durationMs } : {}), leadInMs: timeline.narrationLeadInMs, atempo: voiceTiming.atempo });
    const music = snapshot.music ? await workerAsset(snapshot.music.assetId, { sha256: snapshot.music.sha256 }) : undefined;
    const variant = claim.job.variantId ? (await runtime.variantFactory.list(claim.job.projectId)).flatMap((item) => item.variants).find((item) => item.id === claim.job.variantId) : undefined;
    return { protocolVersion: claim.job.protocolVersion, jobId: claim.job.id, projectId: claim.job.projectId, projectPublicId: project.publicId, renderAttemptId: claim.job.renderId ?? claim.job.variantId ?? "variant", leaseToken: claim.leaseToken, leaseExpiresAt: claim.job.leaseExpiresAt,
      scenes, narration, ...(music ? { music } : {}),
      overlays: snapshot.marketingOverlays.map((text, index) => ({ text, sceneIndex: index })), cta: snapshot.cta,
      timeline: { transition: timeline.transition, transitionDurationMs: timeline.transitionDurationMs, sourceAudio: false }, output: { width: snapshot.target.width, height: snapshot.target.height, fps: 30, durationMs: snapshot.target.durationMs, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" }, ...(variant ? { variant: { variantId: variant.id, publicId: variant.publicId, recipeHash: variant.recipeHash, recipe: variant.recipe } } : {}) };
  });
  app.post("/api/render-worker/v1/jobs/:jobId/renew", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const input = body(renderWorkerLeaseInput, request.body); const job = await runtime.desktopRenderJobs.renew((request.params as { jobId: string }).jobId, input.workerId, input.leaseToken, runtime.renderWorkerLeaseMs);
    return { state: job.state, leaseExpiresAt: job.leaseExpiresAt };
  });
  app.post("/api/render-worker/v1/jobs/:jobId/progress", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const input = body(renderWorkerProgressInput, request.body); const job = await runtime.desktopRenderJobs.progress((request.params as { jobId: string }).jobId, input.workerId, input.leaseToken, input.stage, input.percent, input.encoder);
    return { state: job.state, stage: job.progressStage, percent: job.progressPercent };
  });
  app.get("/api/render-worker/v1/jobs/:jobId/assets/:assetId/reference", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    if (!runtime.durableMediaStore) return reply.code(404).send({ error: "DIRECT_DOWNLOAD_UNAVAILABLE" });
    const headers = request.headers;
    const workerId = String(headers["x-render-worker-id"] ?? "");
    const leaseToken = String(headers["x-render-lease-token"] ?? "");
    const job = await runtime.desktopRenderJobs.authorize((request.params as { jobId: string }).jobId, workerId, leaseToken);
    const assetId = (request.params as { assetId: string }).assetId;
    const allowed = new Set([...job.inputSnapshot.sceneInputs.map((item) => item.assetId), job.inputSnapshot.narration.assetId, ...(job.inputSnapshot.music ? [job.inputSnapshot.music.assetId] : []), ...(job.inputSnapshot.logo ? [job.inputSnapshot.logo.assetId] : [])]);
    if (!allowed.has(assetId)) return reply.code(403).send({ error: "WORKER_ASSET_FORBIDDEN" });
    const reference = await runtime.durableMediaStore.getDownloadReference(assetId);
    return { url: reference.url, expiresAt: reference.expiresAt };
  });
  app.get("/api/render-worker/v1/jobs/:jobId/assets/:assetId", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const headers = request.headers; const workerId = String(headers["x-render-worker-id"] ?? ""); const leaseToken = String(headers["x-render-lease-token"] ?? "");
    const job = await runtime.desktopRenderJobs.authorize((request.params as { jobId: string }).jobId, workerId, leaseToken); const assetId = (request.params as { assetId: string }).assetId;
    const allowed = new Set([...job.inputSnapshot.sceneInputs.map((item) => item.assetId), job.inputSnapshot.narration.assetId, ...(job.inputSnapshot.music ? [job.inputSnapshot.music.assetId] : []), ...(job.inputSnapshot.logo ? [job.inputSnapshot.logo.assetId] : [])]);
    if (!allowed.has(assetId)) return reply.code(403).send({ error: "WORKER_ASSET_FORBIDDEN" });
    const asset = await runtime.storage.getAsset(assetId); return reply.type(asset.mimeType).send(Buffer.from(await runtime.storage.read(asset.storageKey)));
  });
  app.post("/api/render-worker/v1/jobs/:jobId/output/authorize", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    if (!runtime.durableMediaStore) return reply.code(404).send({ error: "DIRECT_UPLOAD_UNAVAILABLE" });
    const input = body(renderWorkerOutputAuthorizationInput, request.body);
    if (input.byteSize > runtime.renderWorkerMaxOutputBytes) throw new DomainError("DESKTOP_RENDER_OUTPUT_INVALID", "Desktop output exceeds the configured size limit.");
    const jobId = (request.params as { jobId: string }).jobId;
    let job = await runtime.desktopRenderJobs.authorize(jobId, input.workerId, input.leaseToken);
    if (job.state === "SUCCEEDED") {
      if (job.outputSha256 !== input.sha256) throw new DomainError("DESKTOP_RENDER_ALREADY_COMPLETED", "This render job already has a different immutable output.");
      return { state: "SUCCEEDED", sha256: job.outputSha256, reused: true };
    }
    const completedUpload = job.outputUploadAssetId
      ? await runtime.durableMediaStore.getAsset(job.outputUploadAssetId).catch(() => undefined)
      : undefined;
    if (completedUpload) {
      if (completedUpload.sha256 !== input.sha256 || completedUpload.byteSize !== input.byteSize) throw new DomainError("DESKTOP_RENDER_OUTPUT_CHANGED", "The authorized immutable render output does not match this retry.");
      return { assetId: completedUpload.id, uploaded: true };
    }
    let target = job.outputUploadAssetId
      ? await runtime.durableMediaStore.getUploadTarget(job.outputUploadAssetId)
      : await runtime.durableMediaStore.createUpload({
          projectId: job.projectId,
          purpose: job.variantId ? "VARIANT_RENDER" : "FINAL_RENDER",
          kind: "RENDER",
          mimeType: "video/mp4",
          extension: "mp4",
          byteSize: input.byteSize,
          sha256: input.sha256,
          namespace: job.variantId ? "working" : "final",
          metadata: { desktopRenderJobId: job.id, ...(job.renderId ? { renderAttemptId: job.renderId } : {}), ...(job.variantId ? { variantId: job.variantId } : {}) }
        });
    job = await runtime.desktopRenderJobs.attachOutputUpload(job.id, input.workerId, input.leaseToken, target.asset.id);
    if (job.outputUploadAssetId !== target.asset.id) target = await runtime.durableMediaStore.getUploadTarget(job.outputUploadAssetId!);
    return { assetId: target.asset.id, method: target.method, url: target.url, headers: target.headers, expiresAt: target.expiresAt };
  });
  app.post("/api/render-worker/v1/jobs/:jobId/output/complete", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    if (!runtime.durableMediaStore) return reply.code(404).send({ error: "DIRECT_UPLOAD_UNAVAILABLE" });
    const input = body(renderWorkerOutputCompletionInput, request.body);
    const jobId = (request.params as { jobId: string }).jobId;
    const job = await runtime.desktopRenderJobs.authorize(jobId, input.workerId, input.leaseToken);
    if (job.outputUploadAssetId !== input.assetId) throw new DomainError("DESKTOP_RENDER_OUTPUT_FORBIDDEN", "Output asset is not authorized for this render job.");
    const asset = await runtime.durableMediaStore.completeUpload(input.assetId);
    if (asset.projectId !== job.projectId || asset.purpose !== (job.variantId ? "VARIANT_RENDER" : "FINAL_RENDER")) throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH", "Final output asset belongs to another job.");
    const inspection = await runtime.mediaInspector.inspect(asset, { width: job.inputSnapshot.target.width, height: job.inputSnapshot.target.height, durationMs: job.inputSnapshot.target.durationMs, requireAudio: true });
    if (!inspection.passed) throw new DomainError("DESKTOP_RENDER_QA_FAILED", "Uploaded render failed server-side media QA.");
    const succeeded = await runtime.desktopRenderJobs.succeed(jobId, input.workerId, input.leaseToken, asset.id, asset.sha256); if (succeeded.variantId) await runtime.variantFactory.mark(succeeded.variantId, "READY", { assetId: asset.id, sha256: asset.sha256, inspection }); if (succeeded.renderId) await runtime.service.reconcileCompletedDesktopRender(succeeded.projectId, succeeded.renderId); return { state: "SUCCEEDED", sha256: asset.sha256, inspection };
  });
  app.post("/api/render-worker/v1/jobs/:jobId/output", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const part = await request.file(); if (!part || part.mimetype.toLowerCase() !== "video/mp4") throw new DomainError("DESKTOP_RENDER_OUTPUT_INVALID", "Desktop output must be one MP4 file.");
    const bytes = await part.toBuffer(); if (part.file.truncated || bytes.byteLength === 0 || bytes.byteLength > runtime.renderWorkerMaxOutputBytes || !mediaTypes.get("video/mp4")!.signature(bytes)) throw new DomainError("DESKTOP_RENDER_OUTPUT_INVALID", "Desktop output is empty, oversized, or not an MP4 file.");
    const fields = part.fields as Record<string, { value?: unknown }>; const input = body(renderWorkerLeaseInput.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }), { workerId: fields.workerId?.value, leaseToken: fields.leaseToken?.value, sha256: fields.sha256?.value });
    const jobId = (request.params as { jobId: string }).jobId; const authorizedJob = await runtime.desktopRenderJobs.authorize(jobId, input.workerId, input.leaseToken);
    if (authorizedJob.state === "SUCCEEDED") {
      if (authorizedJob.outputSha256 !== input.sha256) throw new DomainError("DESKTOP_RENDER_ALREADY_COMPLETED", "This render job already has a different immutable output.");
      return { state: "SUCCEEDED", sha256: authorizedJob.outputSha256, reused: true };
    }
    const asset = await runtime.storage.put(`desktop-renders/${jobId}/uploaded.mp4`, { bytes, mimeType: "video/mp4", extension: "mp4", metadata: { projectId: authorizedJob.projectId, purpose: "FINAL_RENDER", desktopRenderJobId: jobId } });
    if (asset.sha256 !== input.sha256) throw new DomainError("DESKTOP_RENDER_CHECKSUM_MISMATCH", "Uploaded render checksum does not match the worker manifest.");
    const job = await runtime.desktopRenderJobs.get(jobId); const inspection = await runtime.mediaInspector.inspect(asset, { width: job.inputSnapshot.target.width, height: job.inputSnapshot.target.height, durationMs: job.inputSnapshot.target.durationMs, requireAudio: true });
    if (!inspection.passed) throw new DomainError("DESKTOP_RENDER_QA_FAILED", "Uploaded render failed server-side media QA.");
    const succeeded = await runtime.desktopRenderJobs.succeed(jobId, input.workerId, input.leaseToken, asset.id, asset.sha256); if (succeeded.variantId) await runtime.variantFactory.mark(succeeded.variantId, "READY", { assetId: asset.id, sha256: asset.sha256, inspection }); if (succeeded.renderId) await runtime.service.reconcileCompletedDesktopRender(succeeded.projectId, succeeded.renderId); return { state: "SUCCEEDED", sha256: asset.sha256, inspection };
  });
  app.post("/api/render-worker/v1/jobs/:jobId/fail", async (request, reply) => {
    if (!(await workerAuthorized(request, runtime))) return reply.code(401).send({ error: "WORKER_AUTHENTICATION_FAILED" });
    const input = body(renderWorkerFailureInput, request.body); const job = await runtime.desktopRenderJobs.fail((request.params as { jobId: string }).jobId, input.workerId, input.leaseToken, input.code, input.message); if (job.variantId) await runtime.variantFactory.mark(job.variantId, "FAILED", { failureMessage: input.message }); return { state: job.state };
  });
  app.get("/api/variant-batches/:id/manifest.csv", async (request, reply) => {
    const batch = await runtime.variantFactory.getBatch((request.params as { id: string }).id); if (!batch) throw new DomainError("VARIANT_BATCH_NOT_FOUND", "Variant batch was not found.");
    const variants = await runtime.variantFactory.listVariants(batch.id); const quote = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
    const header = ["project_id","batch_id","variant_id","filename","opening_scene","scene_order","treatment_family","hook","cta","voice_revision","recipe_version","recipe_hash","duration_seconds","output_checksum"];
    const rows = variants.map((item) => [batch.projectId,batch.id,item.publicId,`${item.publicId}.mp4`,item.openingScene,item.recipe.sceneOrder.join("-"),item.treatmentFamily,item.hook,item.cta,item.recipe.voice.attemptId,item.recipe.recipeVersion,item.recipeHash,item.recipe.targetDurationMs / 1000,item.outputSha256].map(quote).join(","));
    return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="variant-batch-${batch.batchSequence}.csv"`).send([header.join(","),...rows].join("\n"));
  });
  app.get("/api/variant-batches/:id/download.zip", async (request, reply) => {
    ownerOnly(request as unknown as AuthenticatedRequest);
    const batch = await runtime.variantFactory.getBatch((request.params as { id: string }).id);
    if (!batch) throw new DomainError("VARIANT_BATCH_NOT_FOUND", "Variant batch was not found.");
    const variants = await runtime.variantFactory.listVariants(batch.id);
    if (variants.length !== 12 || variants.some((variant) => variant.status !== "READY" || !variant.outputAssetId || !variant.outputSha256)) {
      throw new DomainError("VARIANT_BATCH_DOWNLOAD_NOT_READY", "All twelve variants must be READY before downloading the batch ZIP.");
    }
    const outputs = await Promise.all(variants.map(async (variant) => {
      const asset = await runtime.storage.getAsset(variant.outputAssetId!);
      if (asset.projectId !== batch.projectId || asset.mimeType !== "video/mp4" || asset.sha256 !== variant.outputSha256) {
        throw new DomainError("VARIANT_BATCH_DOWNLOAD_INVALID", "A variant output no longer matches its approved immutable record.");
      }
      return { asset, filename: `${variant.publicId.replace(/[^A-Za-z0-9._-]/g, "-")}.mp4` };
    }));
    const zip = new archiver.ZipArchive({ zlib: { level: 0 } });
    zip.on("error", (error: Error) => zip.destroy(error));
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="variant-batch-B${String(batch.batchSequence).padStart(2, "0")}.zip"`);
    for (const output of outputs) {
      if (output.asset.storageProvider === "s3" && runtime.durableMediaStore) {
        const reference = await runtime.durableMediaStore.getDownloadReference(output.asset.id);
        const response = await fetch(reference.url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) throw new DomainError("VARIANT_BATCH_DOWNLOAD_UNAVAILABLE", "A variant output could not be read from durable storage.");
        zip.append(Readable.fromWeb(response.body as never), { name: output.filename, store: true });
      } else {
        zip.append(Buffer.from(await runtime.storage.read(output.asset.storageKey)), { name: output.filename, store: true });
      }
    }
    void zip.finalize();
    return reply.send(zip);
  });
  app.get("/api/variants/:id/download", async (request, reply) => {
    const variant = await runtime.variantFactory.getVariant((request.params as { id: string }).id);
    if (!variant?.outputAssetId || variant.status !== "READY") throw new DomainError("VARIANT_NOT_READY", "This variant is not ready to download.");
    const asset = await runtime.storage.getAsset(variant.outputAssetId); if (asset.mimeType !== "video/mp4") throw new DomainError("VARIANT_DOWNLOAD_INVALID", "Variant output is not an MP4.");
    const filename = `${variant.publicId.replace(/[^A-Za-z0-9._-]/g, "-")}.mp4`;
    if (asset.storageProvider === "s3" && runtime.durableMediaStore) { const reference = await runtime.durableMediaStore.getDownloadReference(asset.id); return reply.header("Content-Disposition", `attachment; filename="${filename}"`).redirect(reference.url); }
    return reply.header("Content-Type", "video/mp4").header("Content-Disposition", `attachment; filename="${filename}"`).send(Buffer.from(await runtime.storage.read(asset.storageKey)));
  });  app.get("/api/assets/:id", async (request, reply) => {
    const asset = await runtime.storage.getAsset((request.params as { id: string }).id);
    if (asset.storageProvider === "s3" && runtime.durableMediaStore) {
      const reference = await runtime.durableMediaStore.getDownloadReference(asset.id);
      return reply.redirect(reference.url);
    }
    return reply.type(asset.mimeType).send(Buffer.from(await runtime.storage.read(asset.storageKey)));
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "The requested API route does not exist." });
    }
    return reply.sendFile("index.html");
  });
  return app;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const runtime = createRuntime();
  const app = buildServer(runtime);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await runtime.pool.end();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  app.listen({ port: Number(process.env.APP_PORT ?? 3000), host: "127.0.0.1" }).catch((error) => { app.log.error(error); process.exit(1); });
}
