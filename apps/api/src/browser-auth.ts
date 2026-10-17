import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { DomainError } from "@koolezt/domain";

export type BrowserRole = "OWNER" | "EDITOR";
export type BrowserIdentity = Readonly<{ email: string; role: BrowserRole }>;
export interface BrowserIdentityVerifier { verify(assertion: string): Promise<BrowserIdentity>; }

type JwtPayload = Readonly<{ aud?: string | readonly string[]; email?: string; exp?: number; nbf?: number; iss?: string }>;
type Jwk = JsonWebKey & Readonly<{ kid?: string }>;
const decode = (value: string) => Buffer.from(value, "base64url");
const normalizedIssuer = (value: string) => value.replace(/\/$/, "");

export class CloudflareAccessVerifier implements BrowserIdentityVerifier {
  private keys?: Readonly<{ expiresAt: number; values: readonly Jwk[] }>;
  constructor(private readonly config: Readonly<{ teamDomain: string; audience: string; ownerEmails: readonly string[]; editorEmails: readonly string[]; keyCacheMs?: number }>, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async signingKeys(): Promise<readonly Jwk[]> {
    const timestamp = this.now();
    if (this.keys && this.keys.expiresAt > timestamp) return this.keys.values;
    const response = await this.fetchImpl(`${normalizedIssuer(this.config.teamDomain)}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new DomainError("BROWSER_AUTH_UNAVAILABLE", "Browser authentication keys are temporarily unavailable.");
    const body = await response.json() as { keys?: readonly Jwk[] };
    if (!body.keys?.length) throw new DomainError("BROWSER_AUTH_UNAVAILABLE", "Browser authentication keys are unavailable.");
    this.keys = { values: body.keys, expiresAt: timestamp + (this.config.keyCacheMs ?? 3_600_000) };
    return body.keys;
  }

  async verify(assertion: string): Promise<BrowserIdentity> {
    const parts = assertion.split(".");
    if (parts.length !== 3) throw new DomainError("BROWSER_AUTH_INVALID", "Browser authentication is invalid.");
    let header: { alg?: string; kid?: string }; let payload: JwtPayload;
    try { header = JSON.parse(decode(parts[0]!).toString("utf8")) as { alg?: string; kid?: string }; payload = JSON.parse(decode(parts[1]!).toString("utf8")) as JwtPayload; }
    catch { throw new DomainError("BROWSER_AUTH_INVALID", "Browser authentication is invalid."); }
    if (header.alg !== "RS256" || !header.kid) throw new DomainError("BROWSER_AUTH_INVALID", "Browser authentication uses an unsupported signature.");
    const key = (await this.signingKeys()).find((candidate) => candidate.kid === header.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), decode(parts[2]!))) throw new DomainError("BROWSER_AUTH_INVALID", "Browser authentication signature is invalid.");
    const seconds = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!payload.exp || payload.exp <= seconds || (payload.nbf && payload.nbf > seconds) || normalizedIssuer(payload.iss ?? "") !== normalizedIssuer(this.config.teamDomain) || !audiences.includes(this.config.audience)) throw new DomainError("BROWSER_AUTH_INVALID", "Browser authentication has expired or is not intended for this application.");
    const email = String(payload.email ?? "").trim().toLowerCase();
    const owners = new Set(this.config.ownerEmails.map((value) => value.trim().toLowerCase()).filter(Boolean));
    const editors = new Set(this.config.editorEmails.map((value) => value.trim().toLowerCase()).filter(Boolean));
    const role = owners.has(email) ? "OWNER" : editors.has(email) ? "EDITOR" : undefined;
    if (!email || !role) throw new DomainError("BROWSER_ACCESS_DENIED", "This account is not authorized for Creative Factory.");
    return { email, role };
  }
}