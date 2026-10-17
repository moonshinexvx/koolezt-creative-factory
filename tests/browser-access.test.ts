import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudflareAccessVerifier } from "../apps/api/src/browser-auth.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("Cloudflare Access verification", () => {
  it("cryptographically verifies issuer, audience, expiry and maps approved email roles", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "access-key" }] }), { status: 200 }));
    const now = Date.parse("2026-09-15T00:00:00Z");
    const verifier = new CloudflareAccessVerifier({
      teamDomain: "https://koolezt.cloudflareaccess.com",
      audience: "creative-aud",
      ownerEmails: ["owner@example.com"],
      editorEmails: ["editor@example.com"]
    }, fetchImpl as typeof fetch, () => now);
    const header = encode({ alg: "RS256", kid: "access-key" });
    const payload = encode({ iss: "https://koolezt.cloudflareaccess.com", aud: ["creative-aud"], email: "OWNER@EXAMPLE.COM", exp: Math.floor(now / 1000) + 300 });
    const signature = sign("RSA-SHA256", Buffer.from(header + "." + payload), privateKey).toString("base64url");
    await expect(verifier.verify(header + "." + payload + "." + signature)).resolves.toEqual({ email: "owner@example.com", role: "OWNER" });
    expect(fetchImpl).toHaveBeenCalledWith("https://koolezt.cloudflareaccess.com/cdn-cgi/access/certs", expect.any(Object));
  });

  it("rejects a validly signed but unauthorized identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const now = Date.now();
    const verifier = new CloudflareAccessVerifier({ teamDomain: "https://team.cloudflareaccess.com", audience: "aud", ownerEmails: [], editorEmails: [] }, async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k" }] })), () => now);
    const header = encode({ alg: "RS256", kid: "k" });
    const payload = encode({ iss: "https://team.cloudflareaccess.com", aud: "aud", email: "stranger@example.com", exp: Math.floor(now / 1000) + 60 });
    const signature = sign("RSA-SHA256", Buffer.from(header + "." + payload), privateKey).toString("base64url");
    await expect(verifier.verify(header + "." + payload + "." + signature)).rejects.toThrow("not authorized");
  });
});