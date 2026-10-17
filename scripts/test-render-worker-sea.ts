import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("The SEA credential test must run on Windows.");

const executable = resolve("dist/render-worker/CreativeFactoryRenderWorker.exe");
if (!existsSync(executable)) throw new Error("Build the Windows render worker before running the SEA credential test.");

const dataRoot = await mkdtemp(join(tmpdir(), "cf-worker-sea-"));
const token = `sea-test-${randomBytes(32).toString("base64url")}`;
let authorizationVerified = false;
let enrollmentVerified = false;
let workerOutput = "";
let workerError = "";
let child: ReturnType<typeof spawn> | undefined;

const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/render-worker/v1/enroll") {
    const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(Buffer.from(chunk))); request.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { setupCode?: string };
      if (input.setupCode !== "K7P4-N2QM" || request.headers.authorization) { response.writeHead(401).end(); return; }
      enrollmentVerified = true; response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ protocolVersion: "render-worker/v1", workerId: "worker-enrolled", token }));
    }); return;
  }
  request.resume();
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  authorizationVerified = true;
  if (request.method === "POST" && request.url === "/api/render-worker/v1/register") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/render-worker/v1/jobs/claim") {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
});

const listen = () => new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", () => resolveListen());
});
const closeServer = () => new Promise<void>((resolveClose) => server.close(() => resolveClose()));
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for packaged worker authentication.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
};

try {
  await listen();
  const address = server.address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const environment = { ...process.env, RENDER_WORKER_DATA_ROOT: dataRoot, RENDER_WORKER_ENCODER: "libx264", KOOLEZT_WORKER_SETUP_CODE: "K7P4-N2QM" };
  let enrollmentOutput = ""; let enrollmentError = "";
  const enrollmentChild = spawn(executable, ["enroll", "--server", serverUrl], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  enrollmentChild.stdout!.setEncoding("utf8"); enrollmentChild.stderr!.setEncoding("utf8");
  enrollmentChild.stdout!.on("data", (chunk: string) => { enrollmentOutput += chunk; }); enrollmentChild.stderr!.on("data", (chunk: string) => { enrollmentError += chunk; });
  const enrollmentStatus = await new Promise<number | null>((resolveExit, rejectExit) => { const timer = setTimeout(() => { enrollmentChild.kill(); rejectExit(new Error("Packaged enrollment timed out.")); }, 30_000); enrollmentChild.once("exit", (code) => { clearTimeout(timer); resolveExit(code); }); });
  if (enrollmentStatus !== 0 || !enrollmentVerified) throw new Error("Packaged enrollment command failed.");
  if (enrollmentOutput.trim() !== "Connected successfully.") throw new Error("Packaged enrollment command returned an unexpected success message.");
  if (`${enrollmentOutput}${enrollmentError}`.includes(token)) throw new Error("Packaged enrollment output exposed the worker token.");

  const configText = await readFile(join(dataRoot, "config.json"), "utf8");
  const protectedBytes = await readFile(join(dataRoot, "worker-token.dpapi"));
  if (configText.includes(token) || protectedBytes.includes(Buffer.from(token, "utf8"))) throw new Error("Packaged configure stored the worker token in plaintext.");

  child = spawn(executable, [], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { workerOutput += chunk; });
  child.stderr!.on("data", (chunk: string) => { workerError += chunk; });
  await waitFor(() => authorizationVerified, 60_000);
  if (`${workerOutput}${workerError}`.includes(token)) throw new Error("Packaged startup output exposed the worker token.");
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
  child = undefined;

  const credentialPath = join(dataRoot, "worker-token.dpapi");
  const backupPath = join(dataRoot, "worker-token.dpapi.valid");
  await rename(credentialPath, backupPath);
  const missing = spawnSync(executable, [], { env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (missing.status === 0 || !`${missing.stdout}${missing.stderr}`.includes("Worker is not connected")) throw new Error("Packaged startup did not reject a missing protected credential.");
  await rename(backupPath, credentialPath);

  await writeFile(credentialPath, randomBytes(48));
  const corrupt = spawnSync(executable, [], { env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (corrupt.status === 0 || !`${corrupt.stdout}${corrupt.stderr}`.includes("Windows credential protection failed:")) throw new Error("Packaged startup did not reject a corrupt protected credential safely.");
  if (`${corrupt.stdout}${corrupt.stderr}`.includes(token)) throw new Error("Corrupt-credential diagnostics exposed the worker token.");

  console.log("Packaged SEA one-time enrollment, DPAPI decrypt, authenticated startup, missing, and corrupt-blob checks passed.");
} finally {
  if (child) child.kill("SIGTERM");
  await closeServer().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}
