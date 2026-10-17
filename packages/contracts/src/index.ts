import { z } from "zod";

const uuid = z.uuid();

export const productAssetInput = z.object({
  id: uuid.optional(),
  kind: z.enum(["IMAGE", "VIDEO"]),
  label: z.string().trim().min(1).max(160),
  storageKey: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(3).max(120)
});
export const productPersonalizationVisualAuthorityInput = z.object({
  status: z.literal("OPERATOR_CONFIRMED"),
  immutableStructure: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  authorizedPersonalizationFields: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  authorizedProductConfigurations: z.array(z.string().trim().min(1).max(300)).max(30).optional()
}).superRefine((value, context) => {
  if (new Set(value.immutableStructure).size !== value.immutableStructure.length) context.addIssue({ code: "custom", message: "Immutable structure entries must be unique." });
  if (new Set(value.authorizedPersonalizationFields).size !== value.authorizedPersonalizationFields.length) context.addIssue({ code: "custom", message: "Authorized personalization fields must be unique." });
  if (value.authorizedProductConfigurations && new Set(value.authorizedProductConfigurations).size !== value.authorizedProductConfigurations.length) context.addIssue({ code: "custom", message: "Authorized Product configurations must be unique." });
  const immutable = new Set(value.immutableStructure.map((item) => item.toLowerCase()));
  if (value.authorizedProductConfigurations?.some((item) => immutable.has(item.toLowerCase()))) context.addIssue({ code: "custom", message: "An allowed Product configuration cannot also be immutable." });
});


export const productInput = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(5_000),
  claims: z.array(z.object({
    kind: z.enum(["FEATURE", "SELLING_POINT", "RESTRICTION"]),
    text: z.string().trim().min(1).max(500)
  })).max(50),
  defaultCta: z.string().trim().min(1).max(300),
  creativeNotes: z.string().trim().max(5_000).optional(),
  personalizationVisualAuthority: productPersonalizationVisualAuthorityInput.optional(),
  assets: z.array(productAssetInput).max(50).default([])
});

export const createProjectInput = z.object({
  productId: uuid,
  selectedProductAssetIds: z.array(uuid).min(1).max(50),
  additionalInstructions: z.string().trim().max(5_000).optional(),
  preferredVoiceProfileId: z.string().trim().min(1).max(160).default("female-ugc")
});

export const createProjectFromBriefInput = z.object({
  requestId: uuid,
  name: z.string().trim().min(1).max(160),
  creativeTopic: z.string().trim().min(1).max(1_000),
  productDetails: z.string().trim().max(5_000).default(""),
  targetDurationSeconds: z.number().int().min(5).max(60).default(15),
  verifiedClaims: z.array(z.string().trim().min(1).max(500)).max(50).default([])
});
export const strategyOperationInput = z.object({ requestId: uuid, requestedCount: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6) });
export const strategyReplacementInput = z.object({ requestId: uuid });
export const strategyHandoffInput = z.object({ requestId: uuid, revisionIds: z.array(uuid).min(1).max(3), winnerDnaRevisionId: uuid.optional() });

export const productReferenceUploadAuthorizationInput = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  order: z.number().int().min(0).max(49)
});

export const productReferenceUploadCompletionInput = z.object({
  assetId: uuid,
  label: z.string().trim().min(1).max(160),
  order: z.number().int().min(0).max(49)
});

export const conceptEditInput = z.object({
  angle: z.string().trim().min(1).max(1_000).optional(),
  hook: z.string().trim().min(1).max(1_000).optional(),
  voiceScript: z.string().trim().min(1).max(10_000).optional(),
  cta: z.string().trim().min(1).max(500).optional(),
  editingStyleKey: z.string().trim().min(1).max(160).optional(),
  musicCategory: z.string().trim().min(1).max(160).optional()
});

export const sceneRegenerationInput = z.object({
  prompt: z.string().trim().min(1).max(5_000),
  generationMethod: z.enum(["manual", "api"]).optional()
});

export const sceneVideoProviderInput = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/).max(64),
  model: z.string().trim().min(1).max(160).optional()
});

export const sceneGenerationMethodInput = z.object({
  method: z.enum(["manual", "api"])
});

export const sceneManualUploadInput = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(64),
  model: z.string().trim().min(1).max(160).optional()
});

export const narrationScriptInput = z.object({
  script: z.string().trim().min(1).max(10_000)
});

export const narrationRewriteInput = narrationScriptInput;

export const voiceGenerationInput = z.object({
  voiceProfileId: z.string().trim().min(1).max(160).optional(),
  script: z.string().trim().min(1).max(10_000).optional(),
  instructions: z.string().trim().min(1).max(2_000).optional()
});

export const compositionRenderInput = z.object({
  provider: z.enum(["fake", "desktop-worker", "creatomate"]).default("desktop-worker")
});

export const renderWorkerEnrollmentInput = z.object({
  setupCode: z.string().trim().regex(/^[A-Z0-9-]{8,32}$/i),
  machineName: z.string().trim().max(120).optional(),
  workerVersion: z.string().trim().min(1).max(80),
  protocolVersion: z.literal("render-worker/v1")
});
export const renderWorkerEnrollmentCreateInput = z.object({ displayName: z.string().trim().min(1).max(120) });
export const renderWorkerIdentityInput = z.object({
  workerId: z.string().trim().regex(/^[a-zA-Z0-9._-]+$/).max(120),
  protocolVersion: z.literal("render-worker/v1"),
  workerVersion: z.string().trim().min(1).max(80),
  encoders: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  capabilities: z.array(z.string().trim().regex(/^[a-z0-9-]+$/).max(80)).max(20).default(["standard-render-v1"])
});
export const renderWorkerLeaseInput = z.object({ workerId: z.string().trim().regex(/^[a-zA-Z0-9._-]+$/).max(120), leaseToken: z.string().min(20).max(200) });
export const renderWorkerProgressInput = renderWorkerLeaseInput.extend({ stage: z.enum(["Downloading", "Preparing", "Rendering", "Uploading", "QA", "Completed"]), percent: z.number().int().min(0).max(100).optional(), encoder: z.string().trim().min(1).max(80).optional() });
export const renderWorkerFailureInput = renderWorkerLeaseInput.extend({ code: z.string().trim().regex(/^[A-Z0-9_]+$/).max(80), message: z.string().trim().min(1).max(500) });

export const durableUploadAuthorizationInput = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(["video/mp4", "video/webm"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(64),
  model: z.string().trim().min(1).max(160).optional()
});
export const durableUploadCompletionInput = z.object({
  assetId: uuid,
  provider: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(64),
  model: z.string().trim().min(1).max(160).optional()
});
export const sceneContextImageUploadAuthorizationInput = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  productFidelityConfirmed: z.literal(true)
});
export const sceneContextImageUploadCompletionInput = z.object({ assetId: uuid });
export const renderWorkerOutputAuthorizationInput = renderWorkerLeaseInput.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive()
});
export const renderWorkerOutputCompletionInput = renderWorkerLeaseInput.extend({ assetId: uuid });

export const actorHeader = z.string().trim().min(1).max(160);

export type ProductInput = z.infer<typeof productInput>;
export type CreateProjectInput = z.infer<typeof createProjectInput>;
export type CreateProjectFromBriefInput = z.infer<typeof createProjectFromBriefInput>;
