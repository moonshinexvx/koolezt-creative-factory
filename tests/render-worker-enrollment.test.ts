import { describe, expect, it } from "vitest";
import { InMemoryRenderWorkerIdentityStore } from "@koolezt/infrastructure";

describe("render worker enrollment", () => {
  it("exchanges a short-lived single-use code for an independently revocable credential", async () => {
    let now = new Date("2026-09-15T00:00:00Z");
    const store = new InMemoryRenderWorkerIdentityStore(() => now);
    const enrollment = await store.createEnrollment("Editor Laptop", "owner@example.com");
    expect(enrollment.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(enrollment).not.toHaveProperty("token");

    const result = await store.enroll({ setupCode: enrollment.setupCode.toLowerCase(), machineName: "DESKTOP-EDITOR", workerVersion: "1.1.0", protocolVersion: "render-worker/v1" });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await store.authenticate(result.token, result.worker.id)).toMatchObject({ displayName: "Editor Laptop" });
    await expect(store.enroll({ setupCode: enrollment.setupCode, workerVersion: "1.1.0", protocolVersion: "render-worker/v1" })).rejects.toThrow("invalid, expired, or already used");

    await store.heartbeat(result.worker.id, { workerVersion: "1.1.0", protocolVersion: "render-worker/v1", encoders: ["libx264"], capabilities: ["standard-render-v1", "variant-effects-v1"], runtimeState: "IDLE" });
    expect((await store.list())[0]).toMatchObject({ runtimeState: "IDLE", workerVersion: "1.1.0" });
    await store.revoke(result.worker.id);
    expect(await store.authenticate(result.token, result.worker.id)).toBeUndefined();
    expect((await store.list())[0]).toMatchObject({ runtimeState: "OFFLINE", revokedAt: expect.any(String) });

    const expired = await store.createEnrollment("Backup", "owner@example.com", 1000);
    now = new Date(now.getTime() + 1001);
    await expect(store.enroll({ setupCode: expired.setupCode, workerVersion: "1.1.0", protocolVersion: "render-worker/v1" })).rejects.toThrow("invalid, expired, or already used");
  });

  it("never returns token material from worker listings", async () => {
    const store = new InMemoryRenderWorkerIdentityStore();
    const code = await store.createEnrollment("Editor Laptop", "owner");
    const enrolled = await store.enroll({ setupCode: code.setupCode, workerVersion: "1.1.0", protocolVersion: "render-worker/v1" });
    const serialized = JSON.stringify(await store.list());
    expect(serialized).not.toContain(enrolled.token);
    expect(serialized).not.toContain("tokenHash");
  });
});