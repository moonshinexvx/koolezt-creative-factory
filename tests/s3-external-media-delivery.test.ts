import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { S3ExternalMediaDeliveryProvider } from "@koolezt/media";

const bytes = Buffer.from("small private fixture");
const asset = {
  id: "asset-1", kind: "VIDEO" as const, storageKey: "private/asset-1.bin", mimeType: "video/mp4", byteSize: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"), metadata: {}, createdAt: "2026-08-30T00:00:00.000Z"
};

describe("S3 external media delivery", () => {
  it("accepts standard AWS S3 configuration without a custom endpoint", () => {
    expect(() => new S3ExternalMediaDeliveryProvider({ region: "us-east-1", bucket: "koolezt-test", accessKeyId: "test", secretAccessKey: "test" })).not.toThrow();
  });

  it("returns the durable claimed key after a recovered staging upload", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
      return {};
    });
    const markAvailable = vi.fn(async () => undefined);
    const provider = new S3ExternalMediaDeliveryProvider(
      { region: "us-east-1", bucket: "koolezt-test", accessKeyId: "test", secretAccessKey: "test", ttlSeconds: 60 },
      {
        findAvailable: async () => undefined,
        create: async () => undefined,
        claim: async () => ({ id: "staging-1", object_key: "provider-staging/project/operation/recovered.mp4" }),
        markAvailable
      }
    );
    (provider as unknown as { client: { send: typeof send } }).client.send = send;

    const reference = await provider.stage({ projectId: "project", operationId: "operation", asset, storage: { read: async () => bytes } as never });
    expect(send).toHaveBeenCalledTimes(2);
    expect(markAvailable).toHaveBeenCalledWith("staging-1");
    expect(new URL(reference.url).pathname).toContain("recovered.mp4");
  });

  it("reuses a durable AVAILABLE object without another S3 upload", async () => {
    const provider = new S3ExternalMediaDeliveryProvider(
      { region: "us-east-1", bucket: "koolezt-test", accessKeyId: "test", secretAccessKey: "test", ttlSeconds: 60 },
      {
        findAvailable: async () => ({ object_key: "provider-staging/project/operation/available.mp4", content_type: "video/mp4", byte_size: bytes.byteLength, expires_at: new Date(Date.now() + 60_000) }),
        create: async () => undefined
      }
    );
    const send = vi.fn();
    (provider as unknown as { client: { send: typeof send } }).client.send = send;

    const reference = await provider.stage({ projectId: "project", operationId: "operation", asset, storage: { read: async () => { throw new Error("reuse must not read private storage"); } } as never });
    expect(send).not.toHaveBeenCalled();
    expect(new URL(reference.url).pathname).toContain("available.mp4");
  });

  it("executes durable cleanup using only the persisted object key", async () => {
    const markCleanupPending = vi.fn(async () => 1);
    const markCleaned = vi.fn(async () => undefined);
    const provider = new S3ExternalMediaDeliveryProvider(
      { region: "us-east-1", bucket: "koolezt-test", accessKeyId: "test", secretAccessKey: "test" },
      {
        findAvailable: async () => undefined,
        create: async () => undefined,
        markCleanupPending,
        dueCleanup: async () => [{ id: "staging-1", object_key: "provider-staging/project/operation/cleanup.mp4" }],
        markCleaned
      }
    );
    const send = vi.fn(async () => ({}));
    (provider as unknown as { client: { send: typeof send } }).client.send = send;

    await provider.cleanup("operation");
    expect(markCleanupPending).toHaveBeenCalledWith("operation");
    expect(send).toHaveBeenCalledOnce();
    expect(markCleaned).toHaveBeenCalledWith("staging-1");
  });
});
