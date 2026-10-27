# Koolezt Creative Factory

Internal Phase 1 foundation for the Koolezt concept-to-READY video production workflow.

## Current implementation status

Milestone 2 adds locally runnable infrastructure around the foundation slice:

- reviewed architecture and provider-boundary design;
- TypeScript workspace and strict build/lint/test configuration;
- reusable product and persistent-project domain contracts;
- versioned concept generation/edit/approval;
- explicit approval gate before scene jobs;
- independently reviewable/rejectable/regeneratable scene attempts;
- PostgreSQL migrations and a transactional aggregate repository; PostgreSQL is the workflow source of truth;
- transactional outbox plus Redis/BullMQ API/worker delivery (at-least-once queue delivery is idempotent via operation keys);
- Fastify API and a small React operational UI;
- ffprobe-based media QA and a tiny deterministic H.264/AAC vertical MP4 fixture;
- configurable, checksum-bound, destination-local atomic READY publication;
- provider-neutral storage, media inspection, and composition ports;
- render QA gate;
- final approval bound to render checksum;
- destination-local atomic READY publication;
- approvals, audit events, provider metadata, and usage-cost records;
- duplicate workflow-job delivery protection.

All default providers are deterministic fakes. The API runtime uses the committed valid MP4 fixture so real ffprobe QA is exercised; no fake provider contacts an external service.

## Claude creative generation

`CREATIVE_PROVIDER=fake` remains the default. Set `CREATIVE_PROVIDER=claude`, `ANTHROPIC_API_KEY`, and optionally `CLAUDE_CREATIVE_MODEL` (default `claude-opus-5-5`) to enable Claude for Creative Strategy, Creative Concepts, Creative DNA analysis, variant copy packages, and narration rewrites. Responses use Claude structured outputs; numeric, length, and item-count bounds that the API does not enforce are restated in the schema and validated locally before any result is accepted. Server-side refusal fallback is enabled.

Worker jobs (Strategy, Strategy-linked Concepts, Creative DNA) make one direct streamed call inside the job at `CLAUDE_BACKGROUND_EFFORT` (default `medium`). Claude has no stored background responses, so an interrupted call is recorded as SUBMISSION_UNKNOWN and never resubmitted automatically. Browser-request actions use `CLAUDE_INTERACTIVE_EFFORT` (default `low`) so they finish within the Cloudflare request limit. `pnpm test:claude-smoke` is explicitly paid/opt-in and requires `KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true`; normal tests use mocks and never call Claude. `CREATIVE_PROVIDER=openai` remains available as a rollback.

## Creative DNA inputs

Winning-ad analysis never receives the video file itself; the worker prepares measured inputs with FFmpeg. Scene cuts are detected at a 0.3 scene-change threshold and reported as `pacing` (cut timestamps, shot count, average shot length). Up to `CREATIVE_DNA_MAX_FRAMES` (default 30, range 12–60) frames are sampled: densely across the first three seconds, the final frame, one frame just inside each detected shot (thinned evenly when over budget), then even fill. With `DNA_TRANSCRIPTION_PROVIDER=openai` the audio track is extracted and transcribed with segment timestamps (`OPENAI_TRANSCRIBE_MODEL`, default `whisper-1`); segments Whisper marks as probably not speech are dropped, an operator transcript still takes precedence, and a transcription failure is passed to the analysis as `FAILED` instead of failing it. `SCENE_CUT` evidence is kept only near a measured cut and `AUDIO_TRANSCRIPT` evidence only when a transcript exists. Each DNA draft records the frames, pacing, and transcript it was based on in `providerMetadata.analysisInputs`.

## Winner Analysis and Meta Ads

The Winner Analysis page (`/winners`) holds winning ads per Product. Each analysis returns a human-facing report (why it likely won, hook, angle, beat timeline, voice, editing, claims check, next-creative brief) alongside the generation DNA; reports live in `creative_winner_reports` and can be regenerated without touching an approved DNA revision. Winners are filed under the Product's campaign, and every campaign of that Product can use an approved winner.

With `META_ADS_ACCESS_TOKEN` and `META_AD_ACCOUNT_IDS` set, the page lists top ads by date range (spend, purchases, ROAS, CPA, CTR, hook rate = 3-second views ÷ impressions, hold rate = ThruPlays ÷ 3-second views) and imports one: the video is downloaded from Meta's CDN only, lifetime results are copied onto the winner, and analysis starts. If the token cannot read the video, the import falls back to a manual upload that stays linked to the ad. The worker refreshes imported winners' lifetime results daily. The integration is read-only and uses its own token, separate from Koolezt OS.

`VOICE_PROVIDER=fake` also remains the default. Set `VOICE_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_VOICE_MODEL`, and `OPENAI_VOICE_NAME` only to enable server-side OpenAI narration. `OPENAI_VOICE_OUTPUT_FORMAT` defaults to MP3 and `OPENAI_VOICE_INSTRUCTIONS` can provide a short delivery style. OpenAI TTS does not provide native word timing in this adapter, so the provider-neutral narration timing array is safely empty; video composition continues without animated word captions. The existing ElevenLabs adapter remains available but is not required for Phase 1. A real OpenAI voice smoke test is opt-in and requires `KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true`; normal tests and fake development workflows make no paid calls.

Phase 1 final composition uses the private Windows desktop render worker described below. The optional Creatomate adapter remains in the codebase but is not the primary renderer and is never selected automatically.

`VIDEO_PROVIDER=fake` remains the default fallback. New `AI_VIDEO` scenes default to **Manual / External**: an editor copies the provider-neutral brief, uses Kling, Seedance, or another generator outside Creative Factory, and securely uploads the selected MP4/WebM. The recorded generator/model is provenance only and never triggers an API request. Accepted media is provider-agnostic, so composition consumes it exactly like supplied media. An editor can explicitly select API generation for a new pending attempt; `DEFAULT_VIDEO_PROVIDER` then supplies its fallback. Provider/model and generation method are copied into the immutable scene-attempt snapshot, so later changes never rewrite attempt history. Legacy `KLING_VIDEO` concepts remain readable and retain Kling as their preferred provider, while new concepts use `AI_VIDEO`.

Voice approval remains in `VOICE_REVIEW`; it never starts a render or completes the editor handoff. After the explicit editor-complete action, the owner separately chooses **Render Final Video**. Every attempt snapshots the accepted scenes, accepted voice, checksums, timing, overlays, CTA, and output target. Fake renders remain labelled **TEST RENDER — NOT PRODUCTION OUTPUT** and cannot be published to READY.

## Windows desktop render worker

The VPS remains the only workflow authority. A desktop worker has no PostgreSQL, Redis, OpenAI, AWS, or administrator credentials. It authenticates only to `/api/render-worker/v1`, claims one immutable job under a renewable five-minute lease, downloads only assets in that job's checksum-bound manifest, renders locally, uploads the result, and lets the VPS repeat ffprobe QA before `FINAL_REVIEW`. An offline PC leaves the job safely in `WAITING`; an expired claim can be reclaimed without creating another composition attempt.

The Phase 1 human handoff is explicit: accepting scenes and narration leaves the project in editor review until **Mark Editor Work Complete** validates every accepted media asset and records `READY_FOR_RENDER`. That action creates no render attempt or worker job. The owner later clicks **Render Final Video**, which creates one immutable render attempt and a durable desktop-worker job. The editor/owner labels are workflow separation only; the browser does not yet have authenticated user roles, so true role authorization remains a later security milestone.

Build on Windows with `pnpm build:render-worker`. The reproducible deliverable is `dist/CreativeFactoryRenderWorker-1.0.3-windows-x64.zip`, containing `CreativeFactoryRenderWorker.exe`, `ffmpeg.exe`, and `ffprobe.exe`; Node does not need to be installed on the operator PC. Run `pnpm test:render-worker-sea` after building to exercise secure configuration and authenticated startup through the packaged executable itself. Encoder capability is tested in the order NVENC, QSV, AMF, then libx264. Sources are muted, scaled without distortion over a blurred fill, combined at 1080x1920/30fps using CUT or a 300ms CROSSFADE, mixed with accepted narration and optional low-volume music, and emitted as H.264/yuv420p plus AAC.

Set one random, independently revocable `RENDER_WORKER_TOKEN` in the protected VPS `.env.production`; do not reuse another credential. Restarting the API after that configuration change makes only the worker endpoints available and performs no render. With the existing SSH tunnel active, configure the Windows executable once:

```text
CreativeFactoryRenderWorker.exe configure --server http://127.0.0.1:3100
```

Enter the matching token at the worker's non-echoing prompt. The token is passed to built-in Windows PowerShell through stdin and stored separately as `worker-token.dpapi`, encrypted with Windows DPAPI CurrentUser so only the same Windows user on the same installation can decrypt it. Non-secret configuration and a stable worker ID live in `config.json` under `%LOCALAPPDATA%\KooleztCreativeFactoryRenderWorker`. The checksum cache is capped at 10 GiB by default (oldest entries are removed first); override it with `RENDER_WORKER_CACHE_MAX_BYTES`. Launch the executable manually when rendering is desired. Tailscale can later replace the tunnel by re-running configuration with the private HTTPS URL; the protocol does not change. Auto-start and auto-update are deliberately not enabled in Phase 1.

To deliberately use Kling for a scene, set its server-side `KLING_API_KEY`, `KLING_VIDEO_MODEL` (for example the currently documented `kling-3.0-turbo`), and `EXTERNAL_MEDIA_DELIVERY_PROVIDER=s3` with private S3/R2 credentials. Product images are staged as short-lived server-side references; Kling never receives a private filesystem path. `KLING_MAX_CONCURRENCY` defaults to a conservative one worker operation and should be aligned with the account's documented capacity. Provider output is downloaded into private storage and must pass local ffprobe video QA before human review. See [verified Kling API facts](docs/kling-api-facts.md).

Seedance is optional and remains inactive until explicitly selected for a scene. Configure `SEEDANCE_API_KEY`, `SEEDANCE_VIDEO_MODEL` (default `dreamina-seedance-2-5-260628`), and `SEEDANCE_API_BASE_URL` (default BytePlus LAS AP Southeast 1), plus `EXTERNAL_MEDIA_DELIVERY_PROVIDER=s3` for private reference-image staging. The adapter submits a documented Seedance 2.5 task and polls its known task ID; it never retries an ambiguous creation request. It requests silent source clips (`generate_audio=false`) because final narration is supplied separately. Completed provider output is only a temporary transport URL and is ingested to private Koolezt storage before ffprobe QA. See [verified Seedance API facts](docs/seedance-api-facts.md). Normal tests use mocks and make no BytePlus calls.

`pnpm test:creatomate-smoke` is explicitly paid/opt-in. It additionally requires `KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true` and a temporary `CREATOMATE_SMOKE_MEDIA_URL`; it never runs in normal tests or CI.

`pnpm test:kling-smoke` is also explicitly paid/opt-in and refuses to submit unless `VIDEO_PROVIDER=kling`, `KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true`, `KLING_API_KEY`, and `KLING_VIDEO_MODEL` are all set. It submits one three-second 720p text-to-video task; it never runs in normal tests or CI.

Not yet implemented:

- Meta adapter;
- Ubuntu/Nginx deployment assets.

## Private VPS runtime

The API and worker are separate processes. The worker also performs durable transactional-outbox dispatch, so no third dispatcher service is required. Build first, then start `pnpm start:api` and `pnpm start:worker`; the API serves the built React application from `dist/web` and binds to `127.0.0.1` only.

Draft systemd units are in `deploy/systemd/`. They deliberately use a protected environment file and do not configure Caddy or public routing. The deployment order is: deploy a committed release, `pnpm install --frozen-lockfile`, run `pnpm db:migrate` once, run `pnpm build`, then restart only the Creative Factory API and worker units.

See [the architecture](docs/architecture-phase-1.md) and [critical review](docs/architecture-review-phase-1.md).

## Local commands

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
# set DATABASE_URL, REDIS_URL, WORKING_MEDIA_ROOT and READY_ROOT in .env
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
pnpm dev:web
pnpm typecheck
pnpm test
KOOLEZT_TEST_DATABASE_URL=postgres://creative_factory:creative_factory@localhost:5432/creative_factory KOOLEZT_TEST_REDIS_URL=redis://localhost:6379 pnpm test:integration
pnpm lint
pnpm build
```

Example local URLs are `postgres://creative_factory:creative_factory@localhost:5432/creative_factory` and `redis://localhost:6379`. The API listens on port 3000 and the Vite UI on port 5173. The development authentication fallback is deliberately limited to `x-koolezt-actor`; production exposure must be protected by the VPS reverse proxy/internal identity layer before use.

`READY_ROOT` is an ordinary local path. It may later be a mounted OneDrive-synchronised directory; no OneDrive API is used. The worker must be running separately from the API. It polls the transactional outbox, and a restart re-enqueues pending/running database operations safely.

Product assets are uploaded privately through the Product Library. The server accepts PNG, JPEG, WebP, MP4, and WebM only; it enforces `PRODUCT_ASSET_MAX_BYTES` (100 MiB by default), checks basic file signatures, generates storage keys and opaque IDs, and records the original filename as metadata rather than using it as a path.

External provider delivery is disabled by default. When enabled with `EXTERNAL_MEDIA_DELIVERY_PROVIDER=s3`, the S3-compatible adapter copies only trusted internal assets to a private, operation-scoped staging key and returns a short-lived presigned GET URL. It does not replace working storage or READY output. For standard AWS S3, set `S3_REGION` to the bucket's actual AWS region and leave `S3_ENDPOINT` empty; custom endpoints and `S3_FORCE_PATH_STYLE=true` are for S3-compatible services such as R2. Configure bucket lifecycle expiration as a cleanup safety net.

Signed URL TTL controls temporary provider access; staged-object retention is separate and is tracked durably for cleanup/retry. Configure a conservative lifecycle policy for the `provider-staging/` prefix as a second safety net, never as a replacement for application cleanup.

The normal test suite never makes network or paid-provider calls. Real provider smoke tests will be separate and require both credentials and `ALLOW_PAID_PROVIDER_TESTS=true`.


Production durable media can use the existing private AWS bucket with `DURABLE_MEDIA_PROVIDER=s3`. New manual scene uploads and desktop render transfers use exact-object presigned S3 operations while legacy local media remains readable. Retention is performed by the existing worker, and approved final objects are retained indefinitely. See [durable S3 media, CORS, IAM, and retention](docs/s3-durable-media.md).