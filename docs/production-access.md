# Production access: printwlove.com

Creative Factory stays bound to `127.0.0.1:3100`. A remotely managed Cloudflare Tunnel is the only production ingress. Do not add Caddy routes for these applications and do not expose TCP 3100.

## Cloudflare Tunnel and hostnames

Configure the `koolezt-creative-factory` tunnel with these public hostnames:

- `creative.printwlove.com` → `http://127.0.0.1:3100` (protected by Cloudflare Access)
- `worker.printwlove.com` → `http://127.0.0.1:3100` (no interactive Access policy)

The application enforces the hostname boundary: the browser hostname cannot reach `/api/render-worker/v1/*`, while the worker hostname returns 404 for the browser UI and every non-worker API. Worker enrollment codes and independently revocable bearer credentials protect the worker surface.

## Cloudflare Access

Protect `creative.printwlove.com` with a self-hosted Cloudflare Access application. Allow only the owner/editor email identities. Record the application AUD and team domain in the protected production environment:

- `BROWSER_AUTH_PROVIDER=cloudflare`
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`
- `CLOUDFLARE_ACCESS_AUD=<application-aud>`
- `CREATIVE_OWNER_EMAILS=<comma-separated owner emails>`
- `CREATIVE_EDITOR_EMAILS=<comma-separated editor emails>`
- `CREATIVE_BROWSER_ORIGINS=https://creative.printwlove.com`

The API verifies the Cloudflare Access JWT signature, issuer, audience, time bounds, and approved email role. It does not trust raw email headers. `worker.printwlove.com` must not have an interactive Access policy; application host isolation plus enrollment and independently revocable worker credentials protect that endpoint.

## S3 CORS

Keep the bucket private and use this exact origin set:

```json
[
  {
    "AllowedOrigins": [
      "https://creative.printwlove.com",
      "http://127.0.0.1:3100",
      "http://localhost:3100"
    ],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["content-type", "x-amz-meta-asset-id", "x-amz-meta-sha256"],
    "ExposeHeaders": ["ETag", "x-amz-meta-asset-id", "x-amz-meta-sha256"],
    "MaxAgeSeconds": 900
  }
]
```

Do not use a wildcard origin and do not change Block Public Access.

## Owner workflow

Use **Render Workers → Add Render Worker** to create a one-time 30-minute Setup Code. Review projects highlighted as **Awaiting Owner Review**. Approve or request another version. READY projects provide **Download Final MP4**, which authorizes only the current checksum-bound published asset.
