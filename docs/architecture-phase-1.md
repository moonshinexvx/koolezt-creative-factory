# Koolezt Creative Factory — Phase 1 Architecture

Status: reviewed baseline for foundation implementation  
Date: 2026-08-29  
Scope: internal AI-assisted Facebook/Instagram video production, automating the existing concept-to-READY workflow only

## 1. Repository and environment findings

The working directory was empty at inspection time: no Git repository, source tree, package manifest, environment template, or repository-local instructions existed.

Available locally:

- Node.js 24.18.0
- npm 11.16.0
- pnpm 11.19.0

Not installed or not discoverable on `PATH`:

- Docker / Docker Compose
- PostgreSQL client/server
- Redis server
- ffmpeg / ffprobe

Consequences:

- The project will be created as a new pnpm TypeScript workspace.
- Production architecture still uses PostgreSQL, Redis, BullMQ, and ffmpeg/ffprobe.
- Unit and workflow tests use in-memory repositories, an in-process job harness, fake providers, and a fake media inspector. They never call paid APIs.
- PostgreSQL/BullMQ and real ffprobe behavior are covered by opt-in integration suites once those services are available.
- No live service, deployment, or paid API call is authorized by this phase.

## 2. Scope and non-goals

Phase 1 covers:

1. reusable products and product media;
2. persistent creative projects;
3. concept generation, editing, regeneration, and explicit approval;
4. independent scene generation/replacement/review;
5. independent narration generation;
6. template-driven composition;
7. technical media QA;
8. final human review and explicit Approve & Save;
9. atomic publication into a configured READY filesystem directory;
10. complete history, provider metadata, failures, and cost records.

Phase 1 explicitly excludes Meta Ads integration, publishing, Shopify, a general-purpose timeline editor, browser-side provider credentials, arbitrary AI-authored animation logic, direct OneDrive API integration, and customer-facing multi-tenancy.

## 3. Chosen application structure

Use a pragmatic modular monolith with two processes and one React application:

```text
apps/
  api/                 Fastify HTTP API, callbacks, static SPA hosting in production
  worker/              BullMQ consumers and recovery/reconciliation loops
  web/                 React + Vite internal UI
packages/
  domain/              entities, value objects, state rules, provider ports
  application/         use cases, orchestration, transactions, job commands
  infrastructure/      PostgreSQL/Drizzle, BullMQ, storage, logging, config
  providers/           fake and vendor adapters
  media/               ffprobe QA, safe paths, READY publication
  contracts/           HTTP schemas and shared DTOs; no secrets
db/
  migrations/          reviewed SQL migrations
docs/
  architecture-phase-1.md
  architecture-review-phase-1.md
```

Technology choices:

- **Fastify**: small, schema-friendly Node API with good TypeScript support.
- **React + Vite**: operational internal UI without adopting a full-stack framework whose server conventions would compete with the worker/application layers.
- **Drizzle ORM + SQL migrations**: typed queries while keeping PostgreSQL schema and constraints explicit.
- **PostgreSQL**: source of truth for workflow, versions, jobs, audit, and cost.
- **Redis + BullMQ**: delivery, retry scheduling, concurrency, and delayed polling; never the source of truth for paid work.
- **Zod** at trust boundaries: environment, HTTP payloads, provider responses, and persisted JSON metadata.
- **Pino** structured logging.
- **Vitest** for unit/component/application tests.

This is one codebase, one database, one queue service, and two deployable Node processes. Microservices are not justified for Phase 1.

## 4. Major modules and responsibilities

### Product library

Owns products, structured product claims, reusable product assets, activation, and asset validation. Product records referenced by a project are not hard-deleted; they are deactivated or archived.

### Creative projects

Owns the stable `CF-000001` public identifier, selected product/assets, user instructions, preferred angle/style/voice, project state, and current approved versions.

### Concepts

Owns append-only concept revisions and their scene specifications. Regeneration or editing creates a new revision. Approval points the project at one immutable approved concept revision.

### Scenes

Owns logical scene slots plus append-only scene attempts. Each attempt records source type, prompt/settings snapshot, provider job, assets, and review disposition. A rejected attempt remains auditable. Each logical scene selects at most one accepted attempt.

### Narration

Owns configured voice profiles and append-only narration attempts. Narration can be regenerated independently from scenes.

### Composition and QA

Owns composition styles, immutable render requests, render attempts, captions/overlay inputs, technical inspection results, and final-review selection.

### Workflow and jobs

Owns legal state transitions, the transactional outbox, BullMQ dispatch, retry/recovery rules, and provider submission/poll/callback state.

### Storage and READY publication

Owns media paths, checksums, atomic writes, project working layout, safe downloads, and final publication.

### Usage and audit

Owns provider usage/cost rows, approval events, and user-visible plus internal error records.

## 5. Provider ports

Ports live in the domain/application boundary. Vendor DTOs never cross adapters.

```ts
interface CreativeProvider {
  generateConcept(input: CreativeBrief, operation: OperationContext): Promise<CreativeConceptResult>;
}

interface VideoGenerationProvider {
  submit(input: SceneGenerationInput, operation: OperationContext): Promise<ProviderSubmission>;
  getStatus(job: ProviderJobHandle): Promise<ProviderJobStatus<GeneratedVideoResult>>;
  findByExternalId?(externalId: string): Promise<ProviderJobStatus<GeneratedVideoResult> | null>;
}

interface VoiceProvider {
  generate(input: VoiceGenerationInput, operation: OperationContext): Promise<GeneratedVoiceResult>;
}

interface CompositionProvider {
  submit(input: CompositionInput, operation: OperationContext): Promise<ProviderSubmission>;
  getStatus(job: ProviderJobHandle): Promise<ProviderJobStatus<CompositionResult>>;
  findByExternalId?(externalId: string): Promise<ProviderJobStatus<CompositionResult> | null>;
}

interface StorageProvider {
  put(source: Readable, destination: StorageKey, options: PutOptions): Promise<StoredObject>;
  open(key: StorageKey): Promise<Readable>;
  stat(key: StorageKey): Promise<StoredObjectMetadata>;
  copyAtomically(source: StorageKey, destination: PublishedFileKey): Promise<StoredObject>;
}

interface MediaInspector {
  inspect(key: StorageKey): Promise<MediaInspection>;
}
```

Important design boundaries:

- Application code requests a generation; it does not know Kling URLs, ElevenLabs headers, or Creatomate RenderScript.
- Provider capabilities are data/configuration, not large conditional blocks in workflow code.
- `MediaInspector` is separate from composition because every renderer output must receive the same QA.
- Fake providers implement the same ports and are the default outside explicit integration mode.
- Provider selection is server configuration. The browser never chooses an arbitrary provider credential or endpoint.

## 6. Database design

All primary keys are UUIDs except the monotonic project number. Timestamps are `timestamptz`. Media bytes are never stored in PostgreSQL. Enumerations may initially use constrained text to make migrations safer than PostgreSQL enum alterations.

### Product data

`products`

- `id` UUID PK
- `name`, `slug` (unique), `description`, `default_cta`, `creative_notes`
- `status` (`ACTIVE`, `INACTIVE`)
- `created_at`, `updated_at`

`product_claims`

- `id` UUID PK, `product_id` FK
- `kind` (`FEATURE`, `SELLING_POINT`, `RESTRICTION`)
- `text`, `position`
- unique (`product_id`, `kind`, `position`)
- index (`product_id`, `kind`)

`product_assets`

- `id` UUID PK, `product_id` FK
- `asset_id` FK to `media_assets`
- `kind` (`IMAGE`, `VIDEO`), `label`, `position`, `active`
- optional dimensions/duration are canonical on `media_assets`
- deletion restricted while referenced by a project

### Projects and selected inputs

`project_number_sequence`

- PostgreSQL sequence used to format immutable public IDs as `CF-` plus six digits

`creative_projects`

- `id` UUID PK, `project_number` bigint unique, `public_id` text unique
- `product_id` FK restricted
- `state`, `additional_instructions`, preferred angle/style/voice IDs
- `current_concept_id`, `current_voice_generation_id`, `current_render_id` nullable
- `failure_code`, safe `failure_message`, `failed_from_state`
- `version` integer for optimistic concurrency
- `created_at`, `updated_at`, `ready_at`
- indexes (`state`, `updated_at`), (`product_id`, `created_at`)

`creative_project_assets`

- `project_id`, `product_asset_id`, `role`, selection timestamp
- PK (`project_id`, `product_asset_id`)
- selection is retained even if the library asset later becomes inactive

### Versioned concepts and scenes

`creative_concepts`

- `id` UUID PK, `project_id` FK
- `revision` integer, `source` (`PROVIDER`, `USER_EDIT`)
- `angle`, `hook`, `target_duration_ms`, `voice_script`, `cta`
- `editing_style_key`, `music_category`
- provider/model/prompt/schema version metadata
- immutable creative-input snapshot containing the product facts, restrictions, asset descriptors, and user choices used for that revision
- `status` (`GENERATING`, `REVIEW`, `APPROVED`, `SUPERSEDED`, `FAILED`)
- unique (`project_id`, `revision`)

`concept_scene_specs`

- `id` UUID PK, `concept_id` FK
- `scene_number`, `duration_ms`, `purpose`, `source_type`
- `generation_prompt`, `overlay_text`, `accuracy_requirements`
- unique (`concept_id`, `scene_number`)

`concept_scene_reference_assets`

- `scene_spec_id`, `product_asset_id`, `position`
- unique (`scene_spec_id`, `product_asset_id`)

`creative_scenes`

- logical slot: `id`, `project_id`, `scene_number`, `status`
- `approved_attempt_id` nullable
- unique (`project_id`, `scene_number`)

`scene_attempts`

- `id`, `scene_id`, `attempt_number`, `concept_scene_spec_id`
- `source_type` (`KLING_VIDEO`, `UPLOADED_VIDEO`, `PRODUCT_IMAGE`, `EXISTING_ASSET`)
- immutable prompt/settings/input snapshot JSON
- `input_asset_id`, `output_asset_id`, `provider_job_id` nullable
- `status` (`PENDING`, `SUBMITTED`, `PROCESSING`, `REVIEW`, `ACCEPTED`, `REJECTED`, `FAILED`, `CANCELLED`)
- `replaces_attempt_id` nullable self-FK
- unique (`scene_id`, `attempt_number`)
- indexes (`scene_id`, `status`), (`provider_job_id`)

The logical scene is stable; attempts are append-only. Independent regeneration creates one new attempt for one scene.

### Voice, music, styles, and render data

`voice_profiles`

- `id`, `provider`, `provider_voice_id`, `display_name`, `category`, `active`
- optional provider settings JSON
- unique (`provider`, `provider_voice_id`)

`voice_generations`

- `id`, `project_id`, `attempt_number`, `voice_profile_id`
- immutable `source_script`, provider/model/settings metadata
- `provider_request_id`, `asset_id`, `status`, error fields
- unique (`project_id`, `attempt_number`)

`music_assets`

- `id`, `asset_id`, `name`, `category`, `active`
- licensing source, license identifier, notes, expiry, attribution fields

`composition_styles`

- `id`, stable `key`, `name`, `version`, `active`
- validated style configuration JSON: timing, transitions, caption theme, overlay placement, animation, zoom, CTA, music behavior, safe-area preset
- unique (`key`, `version`)

`renders`

- `id`, `project_id`, `attempt_number`, `status`
- selected scene attempt IDs captured through `render_scene_inputs`
- selected voice generation, music asset, composition style/version
- immutable composition request snapshot JSON
- `provider_job_id`, `output_asset_id`, `qa_inspection_id`
- output width/height/duration/codec summary
- unique (`project_id`, `attempt_number`)

`render_scene_inputs`

- `render_id`, `scene_id`, `scene_attempt_id`, `position`
- unique (`render_id`, `position`)

`media_inspections`

- `id`, `asset_id`, inspector version, pass/fail
- container, codecs, stream counts, width, height, duration, byte size
- rule results JSON and safe failure summary

### Media, jobs, audit, and cost

`media_assets`

- `id`, `storage_provider`, `storage_key` unique
- `kind`, `mime_type`, `byte_size`, `sha256`
- dimensions/duration when known
- `status` (`UPLOADING`, `AVAILABLE`, `QUARANTINED`, `MISSING`, `DELETED`)
- original filename (display only), created timestamp
- index (`sha256`, `byte_size`) for detection, not automatic cross-project dedupe

`provider_jobs`

- `id`, provider, operation type, project/scene/render references
- deterministic `operation_key` unique
- provider task/request ID unique where present, external task ID unique where supported
- state, submission state, request fingerprint, sanitized request/response metadata
- attempt counters, next poll time, lease/heartbeat timestamps, last error
- created/submitted/completed timestamps
- check constraints ensure the required owner reference for each operation type

`workflow_outbox`

- `id`, topic, aggregate type/id, deterministic dedupe key unique
- payload, availability time, dispatch attempts, dispatched timestamp
- rows are created in the same database transaction as state changes

`usage_costs`

- `id`, provider, model, operation type, project ID and optional scene/provider job IDs
- request ID, input/output units JSON
- estimated and actual amount as `numeric`, currency, estimation version
- status (`ESTIMATED`, `REPORTED`, `FINAL`, `UNAVAILABLE`), timestamp
- unique provider request/cost component where possible

`approvals`

- `id`, `project_id`, stage (`CONCEPT`, `SCENE`, `FINAL`, `READY_SAVE`)
- nullable concept, scene-attempt, or render FK with a check requiring the stage-appropriate target
- decision (`APPROVED`, `REJECTED`), actor ID/name, note, timestamp
- append-only

`audit_events`

- `id`, project ID, actor, event type, entity type/id
- safe details JSON, correlation ID, timestamp
- append-only; secrets and raw binary data forbidden

### Lifecycle and deletion

- Projects and generation history are archived, not cascade-deleted in normal operation.
- Product/library records referenced by projects are restricted from deletion and can be deactivated.
- Concept revisions, scene attempts, narration attempts, renders, approvals, usage, and audit rows are append-only except for operational status fields.
- A later retention process may delete working media only after policy checks and will mark `media_assets` rather than orphan references.

## 7. Workflow state machine

Project states:

```text
DRAFT
  -> CONCEPT_GENERATING
  -> CONCEPT_REVIEW
  -> CONCEPT_APPROVED
  -> SCENES_GENERATING
  -> SCENES_REVIEW
  -> SCENES_APPROVED
  -> VOICE_GENERATING
  -> COMPOSITION_PENDING
  -> RENDERING
  -> FINAL_REVIEW
  -> SAVING
  -> READY
```

`FAILED` is not a terminal black hole. The project records `failed_from_state`; an explicit retry/recovery action returns it to the correct pending state after validating prerequisites.

The diagram is the primary forward path, not the entire transition graph. Supported rework transitions include `CONCEPT_REVIEW -> CONCEPT_GENERATING`, `FINAL_REVIEW -> COMPOSITION_PENDING` (render again), `FINAL_REVIEW -> VOICE_GENERATING` (change voice), and `FINAL_REVIEW -> SCENES_REVIEW` (return to scenes). Every rework action preserves previous versions.

Important guards:

- `CONCEPT_APPROVED` requires an approval row for the current concept revision.
- Scene jobs cannot be created before concept approval.
- `SCENES_APPROVED` requires every required logical scene to select an accepted attempt.
- Non-generated source types become reviewable without a Kling submission after media validation.
- Rendering requires accepted scene attempts, a completed narration when audio is expected, and an active composition style.
- `FINAL_REVIEW` requires a completed render with passing QA.
- `SAVING` requires explicit final Approve & Save against the exact current render.
- `READY` requires the READY file to exist, match the source checksum, and retain passing QA.

A failed scene attempt is local to that scene and normally leaves the project in `SCENES_REVIEW`; it does not force a project-level `FAILED` state. Project-level `FAILED` is reserved for orchestration failures that prevent the workflow from remaining actionable in its current review state.

Scene status is independently derived from the current/latest attempts; a project can remain `SCENES_REVIEW` while one scene regenerates and accepted scenes remain selected.

Commands are validated against state and aggregate version. HTTP endpoints do not directly assign arbitrary states.

## 8. Jobs, idempotency, and restart recovery

PostgreSQL is canonical; BullMQ is a wake-up and retry mechanism.

### Transactional dispatch

1. An application command validates state and writes domain changes.
2. It inserts a `workflow_outbox` row in the same transaction.
3. A dispatcher enqueues BullMQ with `jobId = dedupe_key`.
4. The worker loads current database state and safely no-ops if the work already completed or became obsolete.

### Paid submission protocol

Each paid operation gets a deterministic operation key such as:

```text
scene:{sceneId}:attempt:{attemptNumber}:generate
voice:{projectId}:attempt:{attemptNumber}:generate
render:{projectId}:attempt:{attemptNumber}:compose
```

The worker transactionally inserts or locks the unique `provider_jobs` row before calling a provider. It stores a request fingerprint and deterministic external ID. Rules:

- If a provider task ID exists, retries poll/reconcile; they never submit again.
- If the operation is complete, retries no-op.
- If no submission started, one worker owns a database lease and may submit.
- For Kling, `external_task_id` is the deterministic operation identity. After an ambiguous timeout, the adapter must query/reconcile by that identity before any resubmission.
- If a provider cannot reconcile an ambiguous accepted request and offers no idempotency key, status becomes `SUBMISSION_UNKNOWN`; automated retries stop and require an operator decision. Preventing duplicate spend takes priority over convenience.
- Provider job metadata is committed immediately after submission. Queue attempt count is not treated as provider attempt count.

### Polling and callbacks

- Callback handlers validate authenticity using the documented provider mechanism where available, record the payload fingerprint, and idempotently update the provider job.
- Scheduled polling is the fallback and recovery path even when callbacks are configured.
- Provider URLs are downloaded promptly into internal storage; no project depends on a vendor's temporary URL.
- Exponential backoff with jitter applies only to classified transient errors (`429`, timeouts, selected `5xx`). Validation, policy, and credential errors are not blindly retried.
- Provider-specific concurrency is configured per BullMQ worker/limiter and can be reduced without code changes.

### Restart recovery

- On startup, the worker scans due `provider_jobs` in submitted/processing/ambiguous states and enqueues reconciliation.
- Stale worker leases expire; provider task IDs and operation keys remain durable.
- Outbox rows not marked dispatched are replayed.
- A reconciliation command compares database state, queue state, provider state, and stored output presence.

## 9. Media and storage model

The local filesystem provider uses opaque `StorageKey` values. No caller passes an arbitrary absolute path.

Working layout:

```text
{WORKING_ROOT}/
  projects/{projectUuid}/
    sources/
    scenes/{sceneUuid}/{attempt}/
    audio/{attempt}/
    renders/{attempt}/
    metadata/
  library/products/{productUuid}/
  library/music/{musicUuid}/
```

Rules:

- Resolve a key against its configured root and verify the resolved path remains under that root.
- Generate stored filenames; retain the original filename only as untrusted display metadata.
- Stream uploads to a random temporary file, enforce byte limits, sniff media type, validate extension/type agreement, inspect media, compute SHA-256, then atomically rename.
- Reject symlinks in managed storage paths and never follow user-controlled path components.
- Serve media through authenticated application routes or short-lived server-generated access, not by exposing the entire working root through Nginx.
- Persist vendor response metadata but never depend on vendor-hosted output retention.

Default upload policy is configuration-driven. Initial allowlist: JPEG/PNG product images; MP4/QuickTime source video; MP3/WAV/M4A audio where applicable. Exact maximum sizes will be selected during the upload milestone and documented in config.

## 10. OpenAI creative integration

Use the server-side official OpenAI JavaScript/TypeScript SDK and the Responses API. The adapter supplies product facts, restrictions, selected asset descriptors, optional angle/style, voice preference, and user instructions. It asks for strict JSON Schema output matching the versioned `CreativeConcept` contract.

The current official OpenAI API reference states that Responses accepts text/image inputs and JSON outputs; strict schema formatting is supported through the response text format. Model selection remains configuration (`OPENAI_CREATIVE_MODEL`) rather than a hard-coded assumption. See:

- https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create
- https://platform.openai.com/docs/guides/structured-outputs

Adapter behavior:

- Parse SDK structured output and validate it again with the local schema.
- Treat refusal, incomplete response, schema mismatch, and transport failure distinctly.
- Record response ID, model, schema/prompt versions, token usage, latency, and safe error metadata.
- Do not send unrelated product assets or secrets.
- The provider returns a concept draft only. It cannot approve a concept or enqueue paid video work.
- Tests use a deterministic fake concept provider.

## 11. Kling integration design

The real adapter is deferred until account-specific verification, but the architecture is based on the current official Kling Open Platform documentation.

Verified official behavior as of the document date:

- video creation is asynchronous and returns a provider `task_id`;
- task states include submitted, processing, succeeded, and failed;
- single-task polling and callback URLs are supported;
- `external_task_id` is supported and must be unique within an account;
- image-to-video accepts supported reference images subject to model capability and validation;
- provider output URLs are temporary and the documentation says generated media is cleared after 30 days;
- task responses may include final unit/balance deductions, useful for actual cost records.

Source: https://kling.ai/document-api/api/video/2-0-master

Implementation rules:

- The model and mode come from validated configuration/capability data, not source-code defaults.
- Phase 1 submits one provider job per logical scene attempt, preserving independent regeneration.
- Kling sound remains off in the standard workflow because narration/music are composed separately.
- The adapter records the exact prompt, reference assets, duration, mode, model, request ID, task ID, output ID, and deduction metadata.
- Output is copied immediately to internal storage and inspected.
- Callback plus polling is supported, with polling required for recovery.

## 12. ElevenLabs integration design

The real adapter uses the official text-to-speech API server-side. Current official documentation specifies `POST /v1/text-to-speech/:voice_id`, `xi-api-key` authentication, configurable model/output format, and binary audio output. Model and voice IDs remain data/configuration, not constants.

Source: https://elevenlabs.io/docs/api-reference/text-to-speech/convert

Implementation rules:

- Voice profiles store provider IDs and optional style/settings.
- Generate from the exact approved concept script snapshot.
- Persist request ID when available, model/settings, script, output format, and generated asset.
- Voice regeneration creates a new attempt and does not touch accepted scenes.
- Caption timing should use the provider's documented speech-with-timing endpoint when selected, with forced alignment or a renderer/ffmpeg alignment fallback only after verification.
- Normal tests use a deterministic generated fixture/fake; no API key is needed.

## 13. Composition and rendering design

`CompositionInput` is provider-neutral:

- ordered visual segments with trim/duration/crop behavior;
- narration asset and timed caption cues;
- music asset and ducking level;
- marketing overlays separate from narration captions;
- CTA and optional logo;
- selected immutable style version;
- canvas, frame rate, codec/container targets, and safe-area preset.

The first production candidate is a Creatomate adapter. Current official documentation supports template-based renders or RenderScript, asynchronous render status, webhooks, metadata, and configurable dimensions. Render outputs must be copied to owned storage because hosted render files are retained temporarily.

Sources:

- https://creatomate.com/docs/api/reference/create-a-render
- https://creatomate.com/docs/api/reference/what-is-a-render
- https://creatomate.com/docs/api/reference/limits-and-concurrency

The adapter maps a provider-neutral style to versioned template IDs/modifications or RenderScript. Workflow code never sees element names such as `Text-1`. A future Remotion/ffmpeg adapter consumes the same composition input.

Initial templates:

- `UGC_FAST/v1`: fast cuts, bold center-safe marketing overlays, word/phrase captions, punchy CTA, music ducking.
- `PRODUCT_REVEAL/v1`: gentler reveal, product-centered framing, restrained captions, clean CTA.

Styles define a 1080 × 1920 default, 9:16 canvas, H.264 MP4 and AAC targets, but those values remain validated render-profile configuration rather than domain-wide constants.

Safe-area presets reserve top/bottom UI-obscured regions and lateral padding. Marketing overlays and captions are laid out in separate lanes and validated for text length. The AI recommends content and a style key; it does not create arbitrary effect code.

## 14. Captions, music, and audio behavior

- Marketing overlays originate from concept scene specs and can be edited during review.
- Narration captions originate from the approved voice script and timed alignment data.
- Render inputs keep both as distinct tracks.
- Music is selected only from active internal `music_assets` in the recommended/configured category.
- `No music` is a first-class selection.
- Styles define target narration loudness, music gain, and ducking. Final technical inspection verifies an audio stream when narration or music is expected; perceptual loudness QA can be added after the vertical slice.
- Music licensing metadata is retained even when optional, and expired/inactive tracks cannot be selected for new renders.

## 15. READY-folder design

`READY_ROOT` is a required server-side configuration in production and may point to a mounted OneDrive-synced filesystem directory.

Destination:

```text
{READY_ROOT}/{YYYY-MM-DD}/{sanitized-product-slug}_{projectPublicId}.mp4
```

Publication protocol:

1. Confirm the selected render still has passing QA and matches the approval target.
2. Create the date directory from server time in the configured business timezone.
3. Copy from working storage to a random hidden/partial file in the destination directory.
4. Flush and close, inspect the copied file, and compare byte size plus SHA-256.
5. Atomically rename the partial file to the deterministic final name.
6. Persist the published path/checksum and transition `SAVING -> READY`.

Atomic rename occurs within the READY filesystem. This avoids presenting a partially copied MP4 even when working and READY roots are different mounts. Existing deterministic destinations are never silently overwritten: matching checksum is an idempotent success; a mismatch creates an operator-visible conflict.

## 16. Technical QA

The production `FfprobeMediaInspector` executes ffprobe with a fixed argument array (no shell interpolation) and validates:

- regular file exists and byte size is greater than zero;
- readable MP4 container;
- at least one video stream;
- audio stream exists when expected;
- expected width and height;
- duration within render-profile tolerance;
- accepted video/audio codec set;
- ffprobe exit status and parseable JSON.

Optional ffmpeg decode sampling can detect damaged media that has readable headers. The full raw probe result may be retained in internal diagnostics; UI shows individual safe rule results. QA version is stored so a render remains auditable when rules change.

## 17. Security model

- Secrets exist only in worker/API server environment or a later secret manager.
- `.env.example` contains names and safe defaults only.
- Provider adapters are unavailable unless explicitly configured; integration commands require `ALLOW_PAID_PROVIDER_TESTS=true` plus provider-specific confirmation.
- The web bundle receives capability/status DTOs, never API keys or private provider responses.
- Uploads use authentication, byte limits, content sniffing, safe generated names, media inspection, and path-containment checks.
- Provider callback routes have raw-body size limits, authenticity validation where documented, replay/idempotency protection, and no implicit trust in URLs.
- Outbound media downloads allow only adapter-returned HTTPS URLs, enforce size/time limits, limit redirects, and protect against private-network SSRF after DNS/IP validation.
- Nginx terminates TLS, limits upload/body sizes, and proxies only application routes.
- Logs redact authorization headers, cookies, API keys, signed URLs, and request bodies likely to contain secrets.
- Internal authentication can begin as a reverse-proxy protected single-organization login, but actor identity is still attached to approval/audit events. Authorization remains server-side.

## 18. Observability and operations

Structured logs include correlation ID, project public/UUID, scene/attempt, render, workflow job, provider job, provider request/task ID, state transition, duration, and retry classification.

Operational views/metrics should expose:

- projects by state and age;
- queue depth and oldest job;
- provider jobs stuck by state/provider;
- transition failures and retry counts;
- provider latency and failure rates;
- estimated/actual cost by project/provider;
- missing media and READY publication conflicts;
- outbox lag and worker heartbeat.

User errors are stable codes plus understandable messages. Raw provider errors are sanitized and retained server-side. Health endpoints distinguish liveness from PostgreSQL/Redis/storage/ffmpeg readiness.

## 19. Testing strategy

### Default suite (no paid/network calls)

- domain state-machine and guard tests;
- concept revision/approval lifecycle;
- approval required before scene job creation;
- three default scenes without hard-coding an exact count in domain rules;
- per-scene independent attempt/regeneration and rejection history;
- mixed scene source types;
- operation-key uniqueness and duplicate BullMQ delivery;
- ambiguous provider submission behavior;
- transient versus permanent provider failures;
- restart reconciliation from durable provider jobs/outbox;
- independent voice regeneration;
- composition request snapshots and render lifecycle;
- passing/failing media inspection;
- final approval bound to the exact render;
- atomic/idempotent READY publication and filename sanitization;
- path containment and traversal attempts;
- invalid upload type/size/content;
- missing credentials and paid mode disabled;
- cost/audit history preservation.

### Integration suites (explicit opt-in)

- PostgreSQL migration/constraint/repository tests;
- Redis/BullMQ retry, concurrency, and restart tests;
- ffprobe against generated valid/corrupt fixtures;
- local filesystem atomic-copy tests;
- provider contract smoke tests, one provider at a time, gated by credentials and an explicit paid-test flag.

The normal `pnpm test` command cannot import or instantiate real paid clients through default dependency wiring.

## 20. Deployment architecture

Ubuntu VPS processes/services:

```text
Internet / LAN
  -> Nginx (TLS, auth boundary, upload limits)
      -> API + built React assets

API and worker
  -> PostgreSQL (durable source of truth)
  -> Redis (BullMQ delivery/scheduling)
  -> private persistent working-media mount
  -> READY mount (possibly OneDrive-synced)

Worker only
  -> OpenAI / Kling / ElevenLabs / composition provider
  -> ffmpeg / ffprobe
```

Docker Compose is appropriate for repeatable development/staging and may package API, worker, PostgreSQL, Redis, and Nginx. Media/READY directories are bind mounts or named volumes. Production may instead use systemd-managed Node processes and host PostgreSQL/Redis; no domain code depends on Compose.

Deployments run migrations as an explicit release step, then start API and worker. Graceful worker shutdown stops taking jobs, extends/finishes safe leases, and leaves provider jobs recoverable.

## 21. Implementation milestones

### Milestone 0 — architecture and skeleton

- architecture plus critical review;
- pnpm workspace, TypeScript, lint/test/build configuration;
- environment schema and `.env.example`;
- domain module boundaries and provider ports.

### Milestone 1 — foundation vertical slice (fake providers)

- product and project domain/repositories;
- concept contract, fake generation, edit/regenerate/approval;
- default concept fixture with three approximately five-second scenes;
- scene logical slots and independent fake generation attempts;
- fake voice generation;
- fake composition producing a deterministic test artifact;
- fake/fixture inspection plus real inspector interface;
- exact-render final approval and atomic READY save;
- full state/cost/audit preservation;
- application-service tests for the complete path.

The first slice prioritizes domain correctness and persistence contracts. It does not pretend a fake artifact is a production-valid 1080 × 1920 video; production media validity belongs to the ffprobe integration milestone.

### Milestone 2 — PostgreSQL, Redis, HTTP, and basic UI

- SQL migrations and Drizzle repositories;
- outbox/BullMQ dispatcher and worker recovery;
- dashboard, product, new creative, concept review, scene review, final review;
- authenticated upload/download paths.

### Milestone 3 — real media QA and local composition fallback

- ffprobe inspector and fixtures;
- final render profile rules;
- music/style library seed and safe-area rendering checks.

### Milestone 4 — OpenAI concept adapter

- current SDK/Responses Structured Output implementation;
- schema/refusal/usage handling;
- opt-in contract smoke test.

### Milestone 5 — Kling adapter

- account/model/capability verification;
- authenticated async submit/poll/callback/reconciliation;
- output ingestion and cost deductions;
- strict concurrency and opt-in paid smoke test.

### Milestone 6 — ElevenLabs adapter

- TTS/timing integration and voice sync;
- regeneration and cost/usage;
- opt-in paid smoke test.

### Milestone 7 — composition provider and production hardening

- Creatomate template adapter if procurement/template proof succeeds;
- full ffprobe QA, READY mount tests, backup/restore rehearsal;
- Nginx/systemd or Compose deployment docs and operational runbooks.

## 22. Assumptions and provider facts requiring verification

Before real adapter implementation, verify with the Koolezt accounts and current official documentation:

### OpenAI

- approved account model and its Structured Outputs/image-input support;
- data-retention policy required by Koolezt;
- project-specific rate and spend limits;
- current SDK structured parsing helper and usage fields at implementation time.

### Kling

- account API region/base URL and commercial API access;
- current supported model/mode/cost combination for 5-second vertical image-to-video;
- exact authentication token construction and rotation;
- account concurrency/rate limits and `429` semantics;
- callback authenticity/signature behavior;
- whether query-by-`external_task_id` is sufficient to reconcile every ambiguous submission;
- current reference-image, aspect-ratio, duration, and model capability matrix;
- current content/licensing terms and output retention.

The official documentation currently warns that several legacy models retire on 2026-09-15. No retiring model will be hard-coded.

### ElevenLabs

- approved voice IDs and permission to use them commercially;
- selected model/output format and account concurrency;
- request ID and usage/cost response fields;
- speech-with-timing endpoint output and alignment quality;
- whether generation idempotency/reconciliation is available for ambiguous requests.

### Creatomate or alternate renderer

- template proof for all required safe-area captions, overlays, CTA, transitions, image pan/zoom, audio ducking, and codecs;
- webhook authenticity and retry behavior;
- account concurrency, retention, and credit reporting;
- ability to ingest private media without broadly exposing working storage;
- output codec guarantees versus required post-render ffmpeg normalization.

### Operations

- production Ubuntu version and CPU/RAM/disk budget;
- authentication boundary and named internal users;
- working-media retention/backup policy;
- OneDrive mount technology and its atomic rename/fsync semantics;
- business timezone and deterministic filename collision policy;
- maximum upload sizes based on real Koolezt assets.

## 23. Architecture decision summary

- A modular monolith minimizes Phase 1 operational complexity while preserving adapter boundaries.
- PostgreSQL, not Redis, owns workflow truth and paid-operation identity.
- Concepts, scene attempts, voice attempts, and renders are versioned/append-only to prevent history loss.
- Explicit approvals are durable records and guards, not UI-only buttons.
- Ambiguous paid submissions stop for reconciliation rather than risk duplicate spend.
- The READY folder is a publication boundary; only an exact approved, QA-passing render crosses it via a destination-local atomic rename.
- Composition styles are versioned configuration mapped inside the adapter, keeping arbitrary AI animation logic out of Phase 1.
- Fake providers are first-class and default, enabling the vertical slice without credentials or spending.
