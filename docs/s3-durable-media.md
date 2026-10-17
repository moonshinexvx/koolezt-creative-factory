# Durable S3 media

Creative Factory keeps workflow truth and asset identity in PostgreSQL. Production media uses the private S3 bucket through `DURABLE_MEDIA_PROVIDER=s3`; `local` remains the development and legacy fallback. Temporary external-provider delivery remains a separate lifecycle under `provider-staging/*`.

Server-controlled durable keys are opaque:

- `creative-factory/working/<project-or-product-id>/<asset-id>/<opaque-id>.<ext>`
- `creative-factory/final/<project-id>/<asset-id>/<opaque-id>.mp4`

Presigned URLs are never persisted. Browser PUTs, browser playback GETs, worker input GETs, and worker final PUTs are short-lived and exact-object scoped. The server verifies S3 HEAD metadata, byte size, and the independently downloaded SHA-256 before marking an upload available; media QA then runs from a bounded temporary file which is removed immediately.

## Bucket CORS

Configure this on the private bucket with an AWS administrator credential, not the application's IAM key. Do not use wildcard origins.

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3100", "http://localhost:3100"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-meta-asset-id", "x-amz-meta-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

Add a future Tailscale application origin as one additional exact HTTPS origin. Do not broaden this to `*`.

## Least-privilege IAM

The application requires `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` for:

- `<bucket>/provider-staging/*`
- `<bucket>/creative-factory/working/*`
- `<bucket>/creative-factory/final/*`

Existing staging reconciliation may use `s3:ListBucket`, restricted with `s3:prefix` to those same prefixes. Durable-media operations themselves use exact keys and do not list prefixes. No public ACL or bucket-public permission is required.

## Retention

The existing worker reconciles and cleans due exact objects hourly by default. Rejected scene/voice and superseded render media has a seven-day grace period. Accepted scene/voice inputs receive seven days after READY. Abandoned pending uploads receive 24 hours. Approved final render objects have no deletion deadline and are retained indefinitely. Cleanup keeps database history and marks media `CLEANED`; repeated deletion is safe.

A bucket lifecycle rule may be used only as a long-delay (for example 30-day) safety net for `creative-factory/working/*`. Never apply an expiration rule to `creative-factory/final/*`.