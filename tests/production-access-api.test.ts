import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../apps/api/src/server.js";

const readyProject = {
  id: "project-1", publicId: "CF-000005", productId: "product-1", state: "READY",
  currentRenderId: "render-current", readyFile: { assetId: "asset-current", sha256: "a".repeat(64) },
  renders: [{ id: "render-old", outputAssetId: "asset-old", outputSha256: "b".repeat(64) }, { id: "render-current", outputAssetId: "asset-current", outputSha256: "a".repeat(64) }]
};

describe("production browser authorization and final download", () => {
  it("allows only owners to download the exact current READY final with a safe filename", async () => {
    const download = vi.fn(async () => ({ url: "https://bucket.s3.amazonaws.com/signed", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const runtime = {
      browserAuth: { verify: vi.fn(async (assertion: string) => ({ email: assertion === "owner" ? "owner@example.com" : "editor@example.com", role: assertion === "owner" ? "OWNER" : "EDITOR" })) },
      service: { getProject: vi.fn(async () => readyProject), getProduct: vi.fn(async () => ({ name: 'Pet / Ornament: "Holiday"' })), },
      storage: { getAsset: vi.fn(async () => ({ id: "asset-current", projectId: "project-1", sha256: "a".repeat(64), mimeType: "video/mp4", storageProvider: "s3" })) },
      durableMediaStore: { getDownloadReference: download },
      renderWorkerIdentities: { list: vi.fn(async () => []) }
    };
    const app = buildServer(runtime as never);
    const editor = await app.inject({ method: "GET", url: "/api/projects/project-1/download", headers: { "cf-access-jwt-assertion": "editor" } });
    expect(editor.statusCode).toBe(403);
    const owner = await app.inject({ method: "GET", url: "/api/projects/project-1/download", headers: { "cf-access-jwt-assertion": "owner" } });
    expect(owner.statusCode).toBe(302);
    expect(owner.headers.location).toBe("https://bucket.s3.amazonaws.com/signed");
    expect(download).toHaveBeenCalledWith("asset-current", { downloadFilename: "CF-000005-Pet-Ornament-Holiday.mp4" });
    expect(owner.body).not.toContain("asset-current");
    await app.close();
  });

  it("rejects anonymous browser API access and keeps worker enrollment outside interactive login", async () => {
    const enroll = vi.fn(async () => ({ worker: { id: "worker-1" }, token: "permanent-secret" }));
    const app = buildServer({ browserAuth: { verify: vi.fn() }, renderWorkerIdentities: { enroll }, service: {} } as never);
    expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/api/render-worker/v1/enroll", payload: { setupCode: "K7P4-N2QM", workerVersion: "1.1.0", protocolVersion: "render-worker/v1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ protocolVersion: "render-worker/v1", workerId: "worker-1", token: "permanent-secret" });
    await app.close();
  });
  it("isolates browser and worker surfaces by the Cloudflare Tunnel hostname", async () => {
    const enroll = vi.fn(async () => ({ worker: { id: "worker-1" }, token: "permanent-secret" }));
    const runtime = {
      browserAuth: { verify: vi.fn(async () => ({ email: "owner@example.com", role: "OWNER" })) },
      renderWorkerToken: "",
      renderWorkerIdentities: { enroll, authenticate: vi.fn(async () => false) },
      service: { listProjects: vi.fn(async () => []) }
    };
    const app = buildServer(runtime as never);

    const workerHttp = await app.inject({ method: "GET", url: "/api/render-worker/v1/register", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "http" } });
    expect(workerHttp.statusCode).toBe(426);
    const workerUi = await app.inject({ method: "GET", url: "/", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "https" } });
    expect(workerUi.statusCode).toBe(404);
    const workerAdmin = await app.inject({ method: "GET", url: "/api/projects", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "https", "cf-access-jwt-assertion": "owner" } });
    expect(workerAdmin.statusCode).toBe(404);
    const workerMissingCredential = await app.inject({ method: "POST", url: "/api/render-worker/v1/register", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "https" }, payload: {} });
    expect(workerMissingCredential.statusCode).toBe(401);
    const workerEnrollment = await app.inject({ method: "POST", url: "/api/render-worker/v1/enroll", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "https" }, payload: { setupCode: "K7P4-N2QM", workerVersion: "1.1.0", protocolVersion: "render-worker/v1" } });
    expect(workerEnrollment.statusCode).toBe(200);

    const browserWorkerApi = await app.inject({ method: "POST", url: "/api/render-worker/v1/enroll", headers: { host: "creative.printwlove.com", "x-forwarded-proto": "https" }, payload: { setupCode: "K7P4-N2QM", workerVersion: "1.1.0", protocolVersion: "render-worker/v1" } });
    expect(browserWorkerApi.statusCode).toBe(404);
    const browserProjects = await app.inject({ method: "GET", url: "/api/projects", headers: { host: "creative.printwlove.com", "x-forwarded-proto": "https", "cf-access-jwt-assertion": "owner" } });
    expect(browserProjects.statusCode).toBe(200);
    expect(runtime.browserAuth.verify).toHaveBeenCalledWith("owner");
    expect((await app.inject({ method: "GET", url: "/", headers: { host: "untrusted.example" } })).statusCode).toBe(404);
    await app.close();
  });
});

describe("variant batch ZIP download", () => {
  const checksum = (ordinal: number) => ordinal.toString(16).padStart(64, "0");
  const readyVariants = Array.from({ length: 12 }, (_, index) => ({
    id: `variant-${index + 1}`,
    batchId: "batch-1",
    publicId: `CF-000006-B02-V${String(index + 1).padStart(2, "0")}`,
    status: "READY",
    outputAssetId: `asset-${index + 1}`,
    outputSha256: checksum(index + 1)
  }));

  it("streams exactly the completed batch outputs as an owner-only ZIP without redirecting the browser to S3", async () => {
    const runtime = {
      browserAuth: { verify: vi.fn(async (assertion: string) => ({ email: `${assertion}@example.com`, role: assertion === "owner" ? "OWNER" : "EDITOR" })) },
      variantFactory: {
        getBatch: vi.fn(async () => ({ id: "batch-1", projectId: "project-1", batchSequence: 2 })),
        listVariants: vi.fn(async () => readyVariants)
      },
      storage: {
        getAsset: vi.fn(async (assetId: string) => {
          const ordinal = Number(assetId.split("-")[1]);
          return { id: assetId, projectId: "project-1", mimeType: "video/mp4", sha256: checksum(ordinal), storageProvider: "local", storageKey: `output-${ordinal}.mp4` };
        }),
        read: vi.fn(async (key: string) => Buffer.from(`fixture-${key}`))
      },
      renderWorkerIdentities: { list: vi.fn(async () => []) }
    };
    const app = buildServer(runtime as never);
    const editor = await app.inject({ method: "GET", url: "/api/variant-batches/batch-1/download.zip", headers: { "cf-access-jwt-assertion": "editor" } });
    expect(editor.statusCode).toBe(403);
    const owner = await app.inject({ method: "GET", url: "/api/variant-batches/batch-1/download.zip", headers: { "cf-access-jwt-assertion": "owner" } });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["content-type"]).toContain("application/zip");
    expect(owner.headers["content-disposition"]).toContain("variant-batch-B02.zip");
    expect(owner.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(owner.body).toContain("CF-000006-B02-V01.mp4");
    expect(owner.body).toContain("CF-000006-B02-V12.mp4");
    expect(owner.body).not.toContain("amazonaws.com");
    await app.close();
  });

  it("refuses a partial batch instead of silently producing an incomplete download", async () => {
    const runtime = {
      browserAuth: { verify: vi.fn(async () => ({ email: "owner@example.com", role: "OWNER" })) },
      variantFactory: { getBatch: vi.fn(async () => ({ id: "batch-1", projectId: "project-1", batchSequence: 2 })), listVariants: vi.fn(async () => readyVariants.slice(0, 11)) },
      renderWorkerIdentities: { list: vi.fn(async () => []) }
    };
    const app = buildServer(runtime as never);
    const response = await app.inject({ method: "GET", url: "/api/variant-batches/batch-1/download.zip", headers: { "cf-access-jwt-assertion": "owner" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "VARIANT_BATCH_DOWNLOAD_NOT_READY" });
    await app.close();
  });
});