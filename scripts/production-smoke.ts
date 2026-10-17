import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const providerModes = {
  CREATIVE_PROVIDER: "fake",
  VIDEO_PROVIDER: "fake",
  VOICE_PROVIDER: "fake",
  COMPOSITION_PROVIDER: "fake",
  EXTERNAL_MEDIA_DELIVERY_PROVIDER: "disabled"
} as const;

export function parseEnvironmentFile(contents: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    environment[key] = line.slice(separator + 1);
  }
  return environment;
}

export function assertSafeSmokeProviderModes(environment: Record<string, string>): void {
  for (const [key, expected] of Object.entries(providerModes)) {
    if (environment[key] !== expected) throw new Error(`${key} must be ${expected} for the non-paid production smoke test.`);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    wait(timeoutMs)
  ]);
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || process.platform === "win32") return;
  try {
    process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!(error instanceof Error) || ("code" in error && error.code !== "ESRCH")) throw error;
  }
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  terminateProcessGroup(child, "SIGTERM");
  await waitForExit(child, 5_000);
  if (child.exitCode === null && child.signalCode === null) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 2_000);
  }
}

function startProcess(command: "start:api" | "start:worker", workingDirectory: string, environment: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  const logFile = openSync(logPath, "a");
  return spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [command], {
    cwd: workingDirectory,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", logFile, logFile]
  });
}

async function waitForHealthyApi(port: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The temporary server has not bound its localhost port yet.
    }
    await wait(500);
  }
  throw new Error("Temporary API did not become healthy within 15 seconds.");
}

export async function runProductionSmoke(options: { cwd?: string; envFile?: string; port?: string } = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const envFile = options.envFile ?? join(cwd, ".env.production");
  const configured = parseEnvironmentFile(readFileSync(envFile, "utf8"));
  assertSafeSmokeProviderModes(configured);
  if (!configured.DATABASE_URL || !configured.REDIS_URL) throw new Error("The production smoke test requires database and Redis configuration.");

  const port = options.port ?? process.env.KOOLEZT_SMOKE_PORT ?? configured.APP_PORT ?? "3100";
  const environment = { ...process.env, ...configured, APP_PORT: port };
  const prefix = join(tmpdir(), `koolezt-creative-smoke-${process.pid}`);
  const apiLog = `${prefix}-api.log`;
  const workerLog = `${prefix}-worker.log`;
  let api: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([api, worker].filter((child): child is ChildProcess => Boolean(child)).map(stopProcessGroup));
  };
  const stopForSignal = (exitCode: number) => () => void cleanup().finally(() => process.exit(exitCode));
  process.once("SIGINT", stopForSignal(130));
  process.once("SIGTERM", stopForSignal(143));
  process.once("SIGHUP", stopForSignal(129));

  try {
    api = startProcess("start:api", cwd, environment, apiLog);
    worker = startProcess("start:worker", cwd, environment, workerLog);
    await waitForHealthyApi(port);
    const [products, web] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/products`),
      fetch(`http://127.0.0.1:${port}/`)
    ]);
    if (!products.ok || !web.ok || !(await web.text()).includes("id=\"root\"")) throw new Error("Temporary API or web application smoke request failed.");
    writeFileSync(`${prefix}-success`, `${basename(cwd)} smoke passed\n`, { mode: 0o600 });
  } finally {
    await cleanup();
    for (const path of [apiLog, workerLog, `${prefix}-success`]) rmSync(path, { force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runProductionSmoke().catch((error: unknown) => {
    process.stderr.write(`Production smoke test failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
