import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { z, ZodError } from "zod";
import {  randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {  productInput } from "@koolezt/contracts";
import { DomainError, VIDEO_PLAN_MOTIONS, VIDEO_PLAN_STYLES } from "@koolezt/domain";
import { createRuntime } from "./runtime.js";
import type { BrowserIdentity } from "./browser-auth.js";

type Runtime = ReturnType<typeof createRuntime>;
type AuthenticatedRequest = { headers: Record<string, unknown>; kooleztIdentity?: BrowserIdentity };
const actor = (request: AuthenticatedRequest) => request.kooleztIdentity?.email ?? String(request.headers["x-koolezt-actor"] ?? "development-user");
const role = (request: AuthenticatedRequest) => request.kooleztIdentity?.role;
const ownerOnly = (request: AuthenticatedRequest) => {
  if (request.kooleztIdentity && role(request) !== "OWNER") throw new DomainError("BROWSER_ROLE_FORBIDDEN", "Owner access is required for this action.");
};
const body = <T>(schema: { parse(value: unknown): T }, value: unknown): T => schema.parse(value);
const uploadLimit = Math.max(Number(process.env.PRODUCT_ASSET_MAX_BYTES ?? 100 * 1024 * 1024), Number(process.env.RENDER_WORKER_MAX_OUTPUT_BYTES ?? 500 * 1024 * 1024));
const mediaTypes = new Map([
  ["image/png", { kind: "IMAGE" as const, extension: "png", signature: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) }],
  ["image/jpeg", { kind: "IMAGE" as const, extension: "jpg", signature: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([255,216,255])) }],
  ["image/webp", { kind: "IMAGE" as const, extension: "webp", signature: (b: Buffer) => b.subarray(0, 4).equals(Buffer.from("RIFF")) && b.subarray(8, 12).equals(Buffer.from("WEBP")) }],
  ["video/mp4", { kind: "VIDEO" as const, extension: "mp4", signature: (b: Buffer) => b.subarray(4, 8).equals(Buffer.from("ftyp")) }],
  ["video/webm", { kind: "VIDEO" as const, extension: "webm", signature: (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([26,69,223,163])) }]
]);

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
  const performanceInput=z.object({spend:z.number().nonnegative().optional(),purchases:z.number().nonnegative().optional(),purchaseCpa:z.number().nonnegative().optional(),revenue:z.number().nonnegative().optional(),roas:z.number().nonnegative().optional(),linkCtr:z.number().nonnegative().optional(),cpc:z.number().nonnegative().optional(),cpm:z.number().nonnegative().optional(),currency:z.string().trim().max(8).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),metricSource:z.string().trim().max(160).optional()});
  const metaAdLinkInput={metaAccountId:z.string().regex(/^(act_)?[0-9]{5,25}$/).optional(),metaAdId:z.string().regex(/^[0-9]{5,25}$/).optional()};
  const creativeReferenceMetadataInput=z.object({...metaAdLinkInput,displayName:z.string().trim().min(1).max(160),operatorStatus:z.enum(["WINNER","CONTROL","REFERENCE","LOSER"]),operatorNotes:z.string().max(4000).optional(),operatorTranscript:z.string().max(20000).optional(),platform:z.string().max(80).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),performance:performanceInput.optional()});
  const creativeReferenceUploadAuthorizationInput=z.object({filename:z.string().trim().min(1).max(255),mimeType:z.enum(["video/mp4","video/webm"]),byteSize:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
  const creativeReferenceUploadCompletionInput=creativeReferenceMetadataInput.extend({assetId:z.string().uuid()});
  const dnaDraftInput=z.object({openingPattern:z.string().min(1).max(500),openingProductVisible:z.boolean(),approximateProductRevealMs:z.number().int().nonnegative().optional(),visualHookMechanism:z.string().min(1).max(500),productProminence:z.string().min(1).max(500),personalizationVisibility:z.string().min(1).max(500),repeatedExamplePattern:z.string().min(1).max(500),approximateExampleCount:z.number().int().nonnegative().optional(),pacingPattern:z.string().min(1).max(500),beatStructure:z.string().min(1).max(700),overlayTextPattern:z.string().min(1).max(500),offerVisibilityPattern:z.string().min(1).max(500),ctaPattern:z.string().min(1).max(500),proofPattern:z.string().min(1).max(500),visualFormat:z.string().min(1).max(300),lifestyleVsProductBalance:z.string().min(1).max(500),soundOffComprehension:z.string().min(1).max(500),directResponsePattern:z.string().min(1).max(500),closingPattern:z.string().min(1).max(500),preserveTraits:z.array(z.string().min(1).max(300)).max(12),safeToVaryTraits:z.array(z.string().min(1).max(300)).max(12),avoidTraits:z.array(z.string().min(1).max(300)).max(12),sourceEvidence:z.array(z.object({kind:z.enum(["VISUAL_FRAME","MEDIA_METADATA","VISIBLE_TEXT","OPERATOR_TRANSCRIPT","OPERATOR_NOTE"]),observation:z.string().min(1).max(500),timestampMs:z.number().int().nonnegative().optional(),endTimestampMs:z.number().int().nonnegative().optional(),frameSha256:z.string().length(64).optional()})).max(30)});
  app.get("/api/creative-references",async()=>{const[entries,reports,products,metaLinks]=await Promise.all([runtime.creativeDnaService.list(),runtime.creativeDnaService.listWinnerReports(),runtime.service.listProducts(),runtime.creativeDnaService.listMetaLinks()]);const metaLinkFor=new Map(metaLinks.map(link=>[link.creativeReferenceId,link]));const reportFor=new Map(reports.map(report=>[report.creativeReferenceId,report]));const productNameFor=new Map(products.map(product=>[product.id,product.name]));return Promise.all(entries.map(async(entry)=>{const asset=await runtime.storage.getAsset(entry.reference.sourceAssetId);const winnerReport=reportFor.get(entry.reference.id);const productName=entry.reference.productId?productNameFor.get(entry.reference.productId):undefined;const durationMs=Number(asset.metadata.durationMs);const metaLink=metaLinkFor.get(entry.reference.id);return{...entry,...(winnerReport?{winnerReport}:{}),...(metaLink?{metaLink}:{}),...(productName?{productName}:{}),sourceMedia:{filename:String(asset.metadata.originalFilename??"Historical source video"),status:asset.lifecycleStatus??"AVAILABLE",mimeType:asset.mimeType,byteSize:asset.byteSize,...(Number.isFinite(durationMs)&&durationMs>0?{durationMs}:{})}};}));});
  const authorizeReferenceUpload=async(request:FastifyRequest,productId:string)=>{if(!runtime.durableMediaStore)throw new DomainError("DIRECT_UPLOAD_DISABLED","Direct durable upload is not enabled.");await runtime.service.getProduct(productId);const input=body(creativeReferenceUploadAuthorizationInput,request.body);if(input.byteSize>uploadLimit)throw new DomainError("INVALID_UPLOAD","Creative Reference video exceeds the configured size limit.");const policy=mediaTypes.get(input.mimeType);const extension=input.filename.split(".").at(-1)?.toLowerCase();if(!policy||policy.kind!=="VIDEO"||extension!==policy.extension)throw new DomainError("UNSUPPORTED_MEDIA_TYPE","Creative References accept MP4 or WebM video only.");const target=await runtime.durableMediaStore.createUpload({projectId:productId,purpose:"WINNER_SOURCE_VIDEO",kind:"VIDEO",mimeType:input.mimeType,extension:policy.extension,byteSize:input.byteSize,sha256:input.sha256,originalFilename:input.filename,metadata:{uploadedBy:actor(request)}});return{assetId:target.asset.id,method:target.method,url:target.url,headers:target.headers,expiresAt:target.expiresAt};};
  const completeReferenceUpload=async(request:FastifyRequest,productId:string)=>{if(!runtime.durableMediaStore)throw new DomainError("DIRECT_UPLOAD_DISABLED","Direct durable upload is not enabled.");const input=body(creativeReferenceUploadCompletionInput,request.body);let ownedAsset=false;try{const asset=await runtime.durableMediaStore.completeUpload(input.assetId);if(asset.purpose!=="WINNER_SOURCE_VIDEO"||!asset.storageKey.includes(`/${productId}/`)||asset.kind!=="VIDEO")throw new DomainError("DURABLE_MEDIA_SCOPE_MISMATCH","Uploaded asset does not belong to this Creative Reference.");ownedAsset=true;const policy=mediaTypes.get(asset.mimeType);const bytes=Buffer.from(await runtime.storage.read(asset.storageKey));if(!policy||policy.kind!=="VIDEO"||!policy.signature(bytes)){await runtime.durableMediaStore.rejectUpload(asset.id,"Video signature verification failed.");throw new DomainError("INVALID_MEDIA_SIGNATURE","File content does not match its declared video type.");}const{assetId,metaAccountId,metaAdId,...metadata}=input;const reference=await runtime.creativeDnaService.register({productId,assetId,...metadata,actor:actor(request)});if(metaAccountId&&metaAdId){if(!runtime.metaWinners)throw new DomainError("META_NOT_CONFIGURED","The Meta Ads integration is not configured.");await runtime.metaWinners.linkUploaded(reference.id,metaAccountId.startsWith("act_")?metaAccountId:`act_${metaAccountId}`,metaAdId);}return reference;}catch(error){if(ownedAsset)await runtime.durableMediaStore.deleteAsset(input.assetId).catch(()=>undefined);throw error;}};
  const registerMultipartReference=async(request:FastifyRequest,productId:string)=>{const part=await request.file();if(!part)throw new DomainError("UPLOAD_REQUIRED","Provide one historical ad video.");const mimeType=part.mimetype.toLowerCase();const policy=mediaTypes.get(mimeType);const extension=part.filename.split(".").at(-1)?.toLowerCase();if(!policy||policy.kind!=="VIDEO"||extension!==policy.extension)throw new DomainError("UNSUPPORTED_MEDIA_TYPE","Creative References accept MP4 or WebM video only.");const bytes=await part.toBuffer();if(part.file.truncated||!bytes.byteLength||!policy.signature(bytes))throw new DomainError("INVALID_MEDIA_SIGNATURE","Historical ad content does not match its declared video type.");const fields=part.fields as Record<string,{value?:unknown}>;const metadata=body(z.object({displayName:z.string().trim().min(1).max(160),operatorStatus:z.enum(["WINNER","CONTROL","REFERENCE","LOSER"]),operatorNotes:z.string().max(4000).optional(),operatorTranscript:z.string().max(20000).optional(),platform:z.string().max(80).optional(),dateStart:z.string().date().optional(),dateEnd:z.string().date().optional(),performance:performanceInput.optional()}),{displayName:fields.displayName?.value,operatorStatus:fields.operatorStatus?.value,operatorNotes:fields.operatorNotes?.value,operatorTranscript:fields.operatorTranscript?.value,platform:fields.platform?.value,dateStart:fields.dateStart?.value,dateEnd:fields.dateEnd?.value,...(typeof fields.performance?.value==="string"?{performance:JSON.parse(fields.performance.value)}:{})});await runtime.service.getProduct(productId);const asset=await runtime.storage.put(`products/${productId}/winners/${randomUUID()}.${policy.extension}`,{bytes,mimeType,extension:policy.extension,metadata:{projectId:productId,purpose:"WINNER_SOURCE_VIDEO",originalFilename:part.filename.slice(0,255),uploadedBy:actor(request)}});try{return await runtime.creativeDnaService.register({productId,assetId:asset.id,...metadata,actor:actor(request)});}catch(error){await runtime.durableMediaStore?.deleteAsset(asset.id).catch(()=>undefined);throw error;}};
  app.post("/api/products/:id/creative-references/upload",async(request)=>authorizeReferenceUpload(request,(request.params as{id:string}).id));
  app.post("/api/products/:id/creative-references/complete",async(request)=>completeReferenceUpload(request,(request.params as{id:string}).id));
  app.post("/api/products/:id/creative-references",async(request)=>registerMultipartReference(request,(request.params as{id:string}).id));
  const metaWinners=()=>{if(!runtime.metaWinners)throw new DomainError("META_NOT_CONFIGURED","The Meta Ads integration is not configured. Add META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_IDS on the server.");return runtime.metaWinners;};
  app.get("/api/meta/status",async()=>runtime.metaWinners?{configured:true,...await runtime.metaWinners.status()}:{configured:false});
  app.get("/api/meta/top-ads",async(request)=>{const query=body(z.object({accountId:z.string().min(1),since:z.string().date(),until:z.string().date()}),request.query);return metaWinners().topAds(query.accountId,query.since,query.until);});
  app.post("/api/meta/import",async(request)=>{const input=body(z.object({accountId:z.string().regex(/^(act_)?[0-9]{5,25}$/),adId:z.string().regex(/^[0-9]{5,25}$/),productId:z.string().uuid(),displayName:z.string().trim().max(160).optional()}),request.body);return metaWinners().importAd({adId:input.adId,productId:input.productId,...(input.displayName?{displayName:input.displayName}:{}),accountId:input.accountId.startsWith("act_")?input.accountId:`act_${input.accountId}`,actor:actor(request)});});
  app.delete("/api/creative-references/:id",async(request)=>{ownerOnly(request as unknown as AuthenticatedRequest);await runtime.creativeDnaService.archive((request.params as{id:string}).id,actor(request));return{ok:true};});
  app.post("/api/creative-references/:id/meta/refresh",async(request)=>{await metaWinners().refresh((request.params as{id:string}).id);return{ok:true};});
  app.post("/api/creative-references/:id/analyze",async(request,reply)=>{const input=body(z.object({requestId:z.string().uuid(),mode:z.enum(["FULL","REPORT"]).optional()}),request.body);return reply.code(202).send(await runtime.creativeDnaService.requestAnalysis((request.params as{id:string}).id,input.requestId,input.mode));});
  app.put("/api/creative-references/:id/dna",async(request)=>runtime.creativeDnaService.edit((request.params as{id:string}).id,body(dnaDraftInput,request.body),actor(request)));
  app.post("/api/creative-references/:id/dna/:revisionId/approve",async(request)=>runtime.creativeDnaService.approve((request.params as{id:string;revisionId:string}).id,(request.params as{id:string;revisionId:string}).revisionId,actor(request)));
  // Winner-to-video: write plans from an analyzed winner, then make the chosen videos on the server.
  const videoPlanRequestInput=z.object({count:z.union([z.literal(3),z.literal(6),z.literal(12)]),durationSeconds:z.union([z.literal(15),z.literal(30)]).default(15),style:z.enum(VIDEO_PLAN_STYLES).default("PHOTO_MOTION")});
  app.post("/api/creative-references/:id/video-plans",async(request,reply)=>{const input=body(videoPlanRequestInput,request.body);return reply.code(202).send(await runtime.winnerVideos.requestPlans({referenceId:(request.params as{id:string}).id,count:input.count,durationSeconds:input.durationSeconds,style:input.style,actor:actor(request as unknown as AuthenticatedRequest)}));});
  app.get("/api/video-batches",async(request)=>{const query=request.query as{referenceId?:unknown};return runtime.winnerVideos.list(typeof query.referenceId==="string"?query.referenceId:undefined);});
  app.post("/api/video-batches/:id/make",async(request,reply)=>{const input=body(z.object({videoIds:z.array(z.string().uuid()).min(1).max(12)}),request.body);return reply.code(202).send(await runtime.winnerVideos.makeVideos((request.params as{id:string}).id,input.videoIds));});
  const scenePlanInput=z.object({photoAssetId:z.string().uuid(),motion:z.enum(VIDEO_PLAN_MOTIONS),caption:z.string().trim().max(80),durationMs:z.number().int().min(1000).max(15000),imagePrompt:z.string().trim().max(1500).default(""),videoPrompt:z.string().trim().max(1500).default("")});
  const videoPlanInput=z.object({title:z.string().trim().min(1).max(120),keepsFromWinner:z.string().trim().max(300).default(""),changes:z.string().trim().max(300).default(""),hookText:z.string().trim().max(60),voiceover:z.string().trim().min(1).max(900),scenes:z.array(scenePlanInput).min(2).max(8),ctaText:z.string().trim().max(40),style:z.enum(VIDEO_PLAN_STYLES).default("PHOTO_MOTION")});
  app.put("/api/videos/:id/plan",async(request)=>runtime.winnerVideos.editPlan((request.params as{id:string}).id,body(videoPlanInput,request.body)));
  app.get("/api/videos/:id/download",async(request,reply)=>{const video=await runtime.winnerVideoStore.getVideo((request.params as{id:string}).id);if(video.status!=="READY"||!video.outputAssetId)throw new DomainError("VIDEO_NOT_READY","This video is not ready yet.");const asset=await runtime.storage.getAsset(video.outputAssetId);const filename=`${video.plan.title.replace(/[^A-Za-z0-9._ -]/g,"").trim().replace(/\s+/g,"-").slice(0,80)||"video"}.mp4`;if(asset.storageProvider==="s3"&&runtime.durableMediaStore){const reference=await runtime.durableMediaStore.getDownloadReference(asset.id,{downloadFilename:filename});return reply.redirect(reference.url);}return reply.header("Content-Type","video/mp4").header("Content-Disposition",`attachment; filename="${filename}"`).send(Buffer.from(await runtime.storage.read(asset.storageKey)));});

  app.get("/api/assets/:id", async (request, reply) => {
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
