import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_RENDER_FONT_PATH } from "./overlay.js";
import type { WorkerConfig } from "./types.js";

type StoredConfig = Readonly<{ serverUrl: string; workerId: string; preferredEncoder?: string }>;

const PROTECT_SCRIPT = String.raw`
Add-Type -AssemblyName System.Security
$path = $env:KOOLEZT_WORKER_CREDENTIAL_PATH
$plain = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($plain)) { exit 2 }
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$temporary = $path + '.tmp'
[IO.File]::WriteAllBytes($temporary, $protected)
Move-Item -LiteralPath $temporary -Destination $path -Force
`;

const UNPROTECT_SCRIPT = String.raw`
Add-Type -AssemblyName System.Security
$path = $env:KOOLEZT_WORKER_CREDENTIAL_PATH
$protected = [IO.File]::ReadAllBytes($path)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

const root = () => process.env.RENDER_WORKER_DATA_ROOT ?? join(process.env.LOCALAPPDATA ?? process.cwd(), "KooleztCreativeFactoryRenderWorker");
const configPath = () => join(root(), "config.json");
const tokenPath = () => join(root(), "worker-token.dpapi");

function powershellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return windowsRoot ? join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

function protectedCredentialEnvironment(path: string): NodeJS.ProcessEnv {
  const keys = ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"] as const;
  const environment: NodeJS.ProcessEnv = { KOOLEZT_WORKER_CREDENTIAL_PATH: path };
  for (const key of keys) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

function runCredentialProtection(script: string, path: string, input?: string): string {
  const result = spawnSync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: protectedCredentialEnvironment(path),
    ...(input !== undefined ? { input } : {}),
    maxBuffer: 64 * 1024
  });
  if (result.error) {
    const code = "code" in result.error && typeof result.error.code === "string" ? result.error.code : "launch failed";
    throw new Error(`Windows credential protection failed: PowerShell ${code}.`);
  }
  if (result.status !== 0) throw new Error(`Windows credential protection failed: PowerShell exited with code ${result.status ?? "unknown"}.`);
  return result.stdout;
}

export function protectWorkerToken(path: string, token: string): void {
  if (process.platform !== "win32") throw new Error("Windows credential protection is available on Windows only.");
  if (!token) throw new Error("Worker token cannot be empty.");
  runCredentialProtection(PROTECT_SCRIPT, path, token);
}

export function unprotectWorkerToken(path: string): string {
  if (process.platform !== "win32") throw new Error("Windows credential protection is available on Windows only.");
  return runCredentialProtection(UNPROTECT_SCRIPT, path);
}

async function readWorkerToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
  }

  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let token = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\r\n");
      if (error) reject(error); else resolve(token);
    };
    const onData = (value: Buffer | string) => {
      for (const character of String(value)) {
        if (character === "\u0003") { finish(new Error("Configuration cancelled.")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0008" || character === "\u007f") token = token.slice(0, -1);
        else if (character >= " ") token += character;
      }
    };
    output.write("Worker token: ");
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const PRODUCTION_WORKER_URL = "https://worker.printwlove.com/";
export const RENDER_WORKER_VERSION = "1.2.4";

function validatedServerUrl(serverUrl: string): URL {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("Worker server URL must use trusted HTTPS or a local test endpoint.");
  return parsed;
}

export async function enrollWorker(serverUrl = PRODUCTION_WORKER_URL, setupCode = process.env.KOOLEZT_WORKER_SETUP_CODE ?? ""): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows worker enrollment is supported on Windows only.");
  if (!setupCode.trim()) throw new Error("A Worker Setup Code is required.");
  const parsed = validatedServerUrl(serverUrl);
  const response = await fetch(new URL("/api/render-worker/v1/enroll", parsed), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: setupCode.trim(), machineName: hostname(), workerVersion: RENDER_WORKER_VERSION, protocolVersion: "render-worker/v1" }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(failure.message ?? "The Setup Code is invalid, expired, or already used.");
  }
  const enrolled = await response.json() as { workerId?: string; token?: string; protocolVersion?: string };
  if (!enrolled.workerId || !enrolled.token || enrolled.protocolVersion !== "render-worker/v1") throw new Error("Creative Factory returned an invalid enrollment response.");
  await mkdir(root(), { recursive: true });
  protectWorkerToken(tokenPath(), enrolled.token);
  const stored: StoredConfig = { serverUrl: parsed.toString(), workerId: enrolled.workerId };
  await writeFile(configPath(), JSON.stringify(stored, null, 2) + String.fromCharCode(10), { encoding: "utf8", mode: 0o600 });
  console.log("Connected successfully.");
}

export function workerCredentialExists(): boolean {
  return existsSync(configPath()) && existsSync(tokenPath());
}
export async function configureWorker(serverUrl: string, preferredEncoder?: string, suppliedToken?: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Interactive worker configuration is supported on Windows only.");
  const parsed = validatedServerUrl(serverUrl);
  await mkdir(root(), { recursive: true });
  const token = suppliedToken ?? await readWorkerToken();
  protectWorkerToken(tokenPath(), token);
  const stored: StoredConfig = { serverUrl: parsed.toString(), workerId: `windows-${randomUUID()}`, ...(preferredEncoder ? { preferredEncoder } : {}) };
  await writeFile(configPath(), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log("Configuration saved securely.");
}

function readProtectedToken(): string {
  if (process.platform !== "win32" || !existsSync(tokenPath())) return "";
  return unprotectWorkerToken(tokenPath());
}

export async function loadWorkerConfig(): Promise<WorkerConfig> {
  const stored = process.env.CREATIVE_FACTORY_URL ? undefined : JSON.parse(await readFile(configPath(), "utf8")) as StoredConfig;
  const executableRoot = dirname(process.execPath);
  const siblingFfmpeg = join(executableRoot, "ffmpeg.exe");
  const siblingFfprobe = join(executableRoot, "ffprobe.exe");
  const token = readProtectedToken();
  if (!token) throw new Error("Worker is not connected. Re-run the installer with a new Setup Code.");
  const preferredEncoder = process.env.RENDER_WORKER_ENCODER ?? stored?.preferredEncoder;
  return {
    serverUrl: process.env.CREATIVE_FACTORY_URL ?? stored!.serverUrl,
    workerId: process.env.RENDER_WORKER_ID ?? stored!.workerId,
    workerVersion: RENDER_WORKER_VERSION,
    token,
    ffmpegPath: process.env.FFMPEG_PATH ?? (existsSync(siblingFfmpeg) ? siblingFfmpeg : "ffmpeg"),
    ffprobePath: process.env.FFPROBE_PATH ?? (existsSync(siblingFfprobe) ? siblingFfprobe : "ffprobe"),
    dataRoot: root(),
    cacheMaxBytes: Number(process.env.RENDER_WORKER_CACHE_MAX_BYTES ?? 10 * 1024 * 1024 * 1024),
    fontPath: process.env.RENDER_WORKER_FONT_PATH ?? DEFAULT_RENDER_FONT_PATH,
    ...(preferredEncoder ? { preferredEncoder } : {})
  };
}
