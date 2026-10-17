import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../apps/api/src/server.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";

describe("Creative Strategy HTTP and operator UI", () => {
  it("starts generation only on the explicit POST action and validates a maximum of three handoff selections", async () => {
    const createBatch = vi.fn(async () => ({ id: batchId, status: "PENDING" }));
    const list = vi.fn(async () => []);
    const handoff = vi.fn(async () => []);
    const app = buildServer({ strategyService: { createBatch, list, handoff, requestReplacement: vi.fn() } } as never);
    const get = await app.inject({ method: "GET", url: `/api/projects/${projectId}/strategy-batches` });
    expect(get.statusCode).toBe(200);
    expect(createBatch).not.toHaveBeenCalled();
    const post = await app.inject({ method: "POST", url: `/api/projects/${projectId}/strategy-batches`, payload: { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    expect(post.statusCode).toBe(202);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(createBatch).toHaveBeenCalledWith(projectId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "development-user", 6);
    for (const requestedCount of [1, 2, 4, 5, 7, 8, 20]) {
      const rejected = await app.inject({ method: "POST", url: `/api/projects/${projectId}/strategy-batches`, payload: { requestId: crypto.randomUUID(), requestedCount } });
      expect(rejected.statusCode).toBe(400);
    }
    expect(createBatch).toHaveBeenCalledTimes(1);
    const invalid = await app.inject({ method: "POST", url: `/api/strategy-batches/${batchId}/handoff`, payload: { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"] } });
    expect(invalid.statusCode).toBe(400);
    expect(handoff).not.toHaveBeenCalled();
    await app.close();
  });

  it("exposes strategy review cards, bounded selection, explicit replacement, and Video Maker handoff controls", async () => {
    const source = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    expect(source).toContain("Standard (recommended)");
    expect(source).toContain("strategyRequestedCount");
    expect(source).toContain("batch.requestedCount");
    expect(source).toContain("activeStrategyOperation");
    expect(source).toContain("Refresh Status");
    expect(source).toContain("Automatic retry is disabled");
    expect(source).toContain("Automatic resubmission is disabled");
    expect(source).toContain("Replace Flagged Concepts (OpenAI)");
    expect(source).toContain("Send Selected to Video Maker");
    expect(source).toContain("Create New Video Maker Project");
    expect(source).toContain("sendStrategiesToVideoMaker(batch.id, selectedForBatch)");
    expect(source).toContain("toggleStrategySelection(revision.id, selectable.map");
    expect(source).not.toContain('disabled={!ready || batch.status === "HANDED_OFF"');
    expect(source).not.toContain('disabled={strategyWorking || batch.status === "HANDED_OFF"');
    expect(source).toContain("selectedForBatch.length >= 3");
    expect(source).toContain("These Campaign inputs are shared authority");
    expect(source).toContain("Allowed Product configurations");
    expect(source).toContain("An allowed configuration must also be supported by a verified Product claim");
    expect(source).toContain("campaignWorkspaceView ? campaignTabs : executionTabs");
  });
});
