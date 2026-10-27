import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../apps/api/src/server.js";

const identities = { verify: vi.fn(async (assertion: string) => ({ email: `${assertion}@example.com`, role: assertion === "owner" ? "OWNER" : "EDITOR" })) };

describe("production browser authorization", () => {
  it("rejects anonymous browser API access", async () => {
    const app = buildServer({ browserAuth: { verify: vi.fn() }, service: { listProducts: vi.fn(async () => []) } } as never);
    expect((await app.inject({ method: "GET", url: "/api/products" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("lets only owners delete a winner", async () => {
    const archive = vi.fn(async () => undefined);
    const app = buildServer({ browserAuth: identities, creativeDnaService: { archive } } as never);
    const editor = await app.inject({ method: "DELETE", url: "/api/creative-references/reference-1", headers: { "cf-access-jwt-assertion": "editor" } });
    expect(editor.statusCode).toBe(403);
    expect(archive).not.toHaveBeenCalled();
    const owner = await app.inject({ method: "DELETE", url: "/api/creative-references/reference-1", headers: { "cf-access-jwt-assertion": "owner" } });
    expect(owner.statusCode).toBe(200);
    expect(archive).toHaveBeenCalledWith("reference-1", "owner@example.com");
    await app.close();
  });

  it("serves the browser only on its Cloudflare hostname, over HTTPS", async () => {
    const runtime = { browserAuth: { verify: vi.fn(async () => ({ email: "owner@example.com", role: "OWNER" })) }, service: { listProducts: vi.fn(async () => []) } };
    const app = buildServer(runtime as never);
    const plainHttp = await app.inject({ method: "GET", url: "/api/products", headers: { host: "creative.printwlove.com", "x-forwarded-proto": "http", "cf-access-jwt-assertion": "owner" } });
    expect(plainHttp.statusCode).toBe(426);
    const browser = await app.inject({ method: "GET", url: "/api/products", headers: { host: "creative.printwlove.com", "x-forwarded-proto": "https", "cf-access-jwt-assertion": "owner" } });
    expect(browser.statusCode).toBe(200);
    expect(runtime.browserAuth.verify).toHaveBeenCalledWith("owner");
    // The retired render-worker hostname exposes nothing.
    const workerHost = await app.inject({ method: "GET", url: "/api/products", headers: { host: "worker.printwlove.com", "x-forwarded-proto": "https", "cf-access-jwt-assertion": "owner" } });
    expect(workerHost.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/", headers: { host: "untrusted.example" } })).statusCode).toBe(404);
    await app.close();
  });
});

describe("made video download", () => {
  it("redirects a finished video to a short-lived link with a safe filename and refuses unfinished ones", async () => {
    const download = vi.fn(async () => ({ url: "https://bucket.s3.amazonaws.com/signed", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const videos: Record<string, unknown> = {
      ready: { id: "ready", status: "READY", outputAssetId: "asset-1", plan: { title: 'Night porch: "reveal"' } },
      planned: { id: "planned", status: "PLANNED", plan: { title: "Later" } }
    };
    const runtime = {
      browserAuth: identities,
      winnerVideoStore: { getVideo: vi.fn(async (id: string) => videos[id]) },
      storage: { getAsset: vi.fn(async () => ({ id: "asset-1", storageProvider: "s3", mimeType: "video/mp4" })) },
      durableMediaStore: { getDownloadReference: download }
    };
    const app = buildServer(runtime as never);
    const ready = await app.inject({ method: "GET", url: "/api/videos/ready/download", headers: { "cf-access-jwt-assertion": "editor" } });
    expect(ready.statusCode).toBe(302);
    expect(ready.headers.location).toBe("https://bucket.s3.amazonaws.com/signed");
    expect(download).toHaveBeenCalledWith("asset-1", { downloadFilename: "Night-porch-reveal.mp4" });
    const planned = await app.inject({ method: "GET", url: "/api/videos/planned/download", headers: { "cf-access-jwt-assertion": "editor" } });
    expect(planned.statusCode).toBe(409);
    expect(planned.json()).toMatchObject({ error: "VIDEO_NOT_READY" });
    await app.close();
  });
});
