import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureWorker, loadWorkerConfig, protectWorkerToken, unprotectWorkerToken } from "../apps/render-worker/src/config.js";

const roots: string[] = [];
const originalRoot = process.env.RENDER_WORKER_DATA_ROOT;

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.RENDER_WORKER_DATA_ROOT;
  else process.env.RENDER_WORKER_DATA_ROOT = originalRoot;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("Windows render-worker credentials", () => {
  it("round-trips a token with CurrentUser DPAPI and never stores or logs plaintext", async () => {
    const root = join(tmpdir(), `render-worker-credential-${randomBytes(8).toString("hex")}`);
    const token = `test-token-${randomBytes(24).toString("base64url")}`;
    roots.push(root);
    process.env.RENDER_WORKER_DATA_ROOT = root;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await configureWorker("http://127.0.0.1:3100", "libx264", token);

    const configText = await readFile(join(root, "config.json"), "utf8");
    const protectedBytes = await readFile(join(root, "worker-token.dpapi"));
    expect(configText).not.toContain(token);
    expect(protectedBytes.length).toBeGreaterThan(0);
    expect(protectedBytes.includes(Buffer.from(token, "utf8"))).toBe(false);
    expect(unprotectWorkerToken(join(root, "worker-token.dpapi"))).toBe(token);
    expect((await loadWorkerConfig()).token).toBe(token);
    expect(log).toHaveBeenCalledWith("Configuration saved securely.");
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it("fails safely for missing and corrupt protected credentials", async () => {
    const root = join(tmpdir(), `render-worker-credential-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    process.env.RENDER_WORKER_DATA_ROOT = root;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({ serverUrl: "http://127.0.0.1:3100/", workerId: "test" }));

    await expect(loadWorkerConfig()).rejects.toThrow("Worker is not connected");
    await writeFile(join(root, "worker-token.dpapi"), randomBytes(48));
    expect(() => unprotectWorkerToken(join(root, "worker-token.dpapi"))).toThrow(/^Windows credential protection failed: PowerShell exited with code /);
  });

  it("does not decrypt a tampered protected credential", async () => {
    const root = join(tmpdir(), `render-worker-credential-${randomBytes(8).toString("hex")}`);
    const path = join(root, "worker-token.dpapi");
    roots.push(root);
    await mkdir(root, { recursive: true });
    protectWorkerToken(path, "synthetic-token");
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(path, bytes);
    expect(() => unprotectWorkerToken(path)).toThrow("Windows credential protection failed");
  });
});
