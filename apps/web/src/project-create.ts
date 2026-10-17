export type NewProjectDraft = Readonly<{
  requestId: string;
  name: string;
  creativeTopic: string;
  productDetails: string;
  targetDurationSeconds: number;
  verifiedClaims?: readonly string[];
}>;

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export function validateNewProject(draft: NewProjectDraft, files: readonly File[]): string | undefined {
  if (!draft.name.trim()) return "Product / Project Name is required.";
  if (draft.name.trim().length > 160) return "Product / Project Name is too long.";
  if (!draft.creativeTopic.trim()) return "Creative Topic / Angle is required.";
  if (draft.creativeTopic.trim().length > 1_000) return "Creative Topic / Angle is too long.";
  if (draft.productDetails.trim().length > 5_000) return "Product Details is too long.";
  if (!Number.isInteger(draft.targetDurationSeconds) || draft.targetDurationSeconds < 5 || draft.targetDurationSeconds > 60) {
    return "Target Duration must be between 5 and 60 seconds.";
  }
  if (files.length > 50) return "Select no more than 50 product reference images.";
  if (files.some((file) => !allowedImageTypes.has(file.type))) return "Product references must be PNG, JPEG, or WebP images.";
  return undefined;
}

async function jsonResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const decoded: unknown = await response.json().catch(() => ({}));
  const value = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  if (!response.ok) throw new Error(typeof value.message === "string" ? value.message : fallback);
  return value;
}

async function checksum(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadProductReference(input: Readonly<{
  projectId: string;
  file: File;
  order: number;
  label?: string;
  fetcher?: typeof fetch;
  onStage?: (stage: string) => void;
}>): Promise<Record<string, unknown>> {
  if (!allowedImageTypes.has(input.file.type)) throw new Error("Product references must be PNG, JPEG, or WebP images.");
  const fetcher = input.fetcher ?? fetch;
  input.onStage?.("Uploading…");
  const sha256 = await checksum(input.file);
  const authorization = await jsonResponse(await fetcher(`/api/projects/${input.projectId}/product-references/upload`, {
    method: "POST",
    headers: { "x-koolezt-actor": "web-user", "content-type": "application/json" },
    body: JSON.stringify({ filename: input.file.name, mimeType: input.file.type, byteSize: input.file.size, sha256, order: input.order })
  }), "Product reference upload authorization failed.");
  if (!authorization.uploaded) {
    const put = await fetcher(String(authorization.url), { method: "PUT", headers: authorization.headers as Record<string, string>, body: input.file });
    if (!put.ok) throw new Error(`Product reference upload failed with HTTP ${put.status}.`);
  }
  input.onStage?.("Verifying…");
  const project = await jsonResponse(await fetcher(`/api/projects/${input.projectId}/product-references/complete`, {
    method: "POST",
    headers: { "x-koolezt-actor": "web-user", "content-type": "application/json" },
    body: JSON.stringify({ assetId: authorization.assetId, label: input.label ?? `Reference ${input.order + 1}`, order: input.order })
  }), "Product reference verification failed.");
  input.onStage?.("Ready");
  return project;
}

export async function createNewProjectWorkflow(input: Readonly<{
  draft: NewProjectDraft;
  files: readonly File[];
  fetcher?: typeof fetch;
  onStage?: (stage: string) => void;
}>): Promise<Record<string, unknown>> {
  const validation = validateNewProject(input.draft, input.files);
  if (validation) throw new Error(validation);
  const fetcher = input.fetcher ?? fetch;
  input.onStage?.("Creating…");
  let project = await jsonResponse(await fetcher("/api/projects/from-brief", {
    method: "POST",
    headers: { "x-koolezt-actor": "web-user", "content-type": "application/json" },
    body: JSON.stringify(input.draft)
  }), "Project creation failed.");
  for (const [order, file] of input.files.entries()) {
    input.onStage?.(`Uploading reference ${order + 1}…`);
    project = await uploadProductReference({
      projectId: String(project.id),
      file,
      order,
      label: order === 0 ? "Primary Product Reference" : `Reference ${order + 1}`,
      fetcher,
      onStage: (stage) => {
        if (stage === "Verifying…") input.onStage?.(`Verifying reference ${order + 1}…`);
      }
    });
  }
  input.onStage?.("Ready");
  return project;
}
