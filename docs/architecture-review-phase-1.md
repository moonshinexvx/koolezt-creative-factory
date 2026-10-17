# Phase 1 Architecture Critical Review

Date: 2026-08-29  
Reviewed document: `docs/architecture-phase-1.md`

## Review result

The design is suitable as the foundation baseline after the clarifications below. It keeps Phase 1 as a modular monolith, makes expensive operations auditable and restart-safe, and does not make a real vendor adapter a prerequisite for proving the workflow.

## Complexity review

### Accepted

- Two Node processes (API and worker) are justified because long-running paid jobs and rendering must survive HTTP request lifetimes.
- A separate React/Vite app is small enough for an internal UI and avoids mixing browser rendering with workflow execution.
- PostgreSQL plus Redis/BullMQ matches the stated production requirements.
- Append-only attempts for concepts/scenes/voice/renders are justified by audit and independent regeneration requirements.
- A transactional outbox is justified because losing a job after committing a state transition would strand a project.

### Reduced or deferred

- No event-sourcing framework. Current tables plus append-only audit/attempt rows are sufficient.
- No generic workflow engine, saga framework, dependency-injection container, CQRS split, microservices, Kubernetes, or object-storage requirement.
- No universal provider base class. Each adapter implements a narrow port and shares only HTTP/retry utilities that prove reusable.
- No generic polymorphic asset graph. Explicit link tables preserve database constraints.
- No production UI timeline editor or arbitrary effect scripting.
- No automatic working-media deduplication; hashes are used for integrity and diagnostics because dedupe complicates deletion/permissions.

## Coupling review

### Finding: template field names could leak into the domain

Resolution: provider-neutral `CompositionInput` and versioned `composition_styles` remain the boundary. Creatomate template IDs and element/modification names belong only in the Creatomate adapter configuration. Render snapshots store the neutral input plus sanitized provider metadata so a future adapter can reproduce intent.

### Finding: provider job states could become the project state machine

Resolution: provider jobs are operational records. Project and scene state transitions are application decisions based on prerequisites. A provider callback cannot directly set a project to `READY` or approve content.

### Finding: local storage assumptions could infect use cases

Resolution: application code uses opaque storage keys. Absolute roots, partial filenames, containment checks, and filesystem atomicity stay inside the local storage/READY publisher.

## Data-loss review

### Finding: edits might overwrite the audit source

Resolution: user edits and regenerations create new concept revisions. Scene prompt changes create new attempts. Voice and render changes create new attempts. Approved targets are immutable; project pointers select current versions.

### Finding: provider-hosted files expire

Resolution: completed outputs are immediately ingested into internal storage and checksummed before provider jobs are considered locally complete. Kling and Creatomate temporary URLs are not canonical assets.

### Finding: product updates could change historical meaning

Resolution: projects retain selected asset IDs and concepts/render requests keep immutable input snapshots. Product records/assets referenced by projects cannot be hard-deleted. The concept provider request metadata records the product facts/restrictions snapshot used at generation time.

### Finding: READY copy could expose partial or wrong output

Resolution: copy to a destination-local hidden partial file, close/flush, checksum and inspect, then rename atomically. The approval is bound to a render ID and checksum. A deterministic filename collision with a different checksum is a conflict, not an overwrite.

## Duplicate paid-call review

### Safe cases

- Duplicate queue delivery is contained by the database `operation_key` uniqueness and worker state checks.
- A retry after a persisted provider task ID polls rather than submits.
- Kling's documented unique `external_task_id` gives a reconciliation identity.
- Completed provider jobs and obsolete attempts no-op when redelivered.

### Irreducible crash window

A process can time out or crash after a provider accepted a paid request but before its task/request ID was persisted. A database transaction cannot be atomic with an external API.

Resolution:

1. generate and persist the deterministic external operation identity before submission;
2. use a provider idempotency key/external ID where supported;
3. on ambiguity, query/reconcile before retry;
4. if reconciliation is impossible, set `SUBMISSION_UNKNOWN` and require operator action rather than automatically spending again.

This tradeoff may leave a job awaiting attention, but it protects against silent double spend. Real adapters must demonstrate their reconciliation behavior in contract tests before automatic retry is enabled.

## Restart and recovery review

- Active provider IDs, request fingerprints, attempts, and next poll times are durable in PostgreSQL.
- Redis loss may lose queued wakeups but not work identity. Startup/outbox/provider reconciliation re-enqueues due work.
- A stale lease is recoverable without generating a new paid operation identity.
- Scene-level failure does **not** force the whole project to global `FAILED`; the project remains in scene review with an actionable failed attempt. Global `FAILED` is reserved for project-level orchestration failures that prevent progress.
- The UI must show `SUBMISSION_UNKNOWN`, credential/config errors, retry time, and manual recovery actions rather than a generic spinner.

## State-machine review

### Finding: state names alone cannot express mixed scene activity

Resolution: project state is a coarse navigation/progress state; each scene attempt and provider job has its own status. `SCENES_REVIEW` may contain accepted, generating, failed, or rejected attempts simultaneously. Project readiness is calculated from required logical scenes selecting accepted attempts.

### Finding: rerender/change voice paths were not drawn in the linear diagram

Resolution: the implementation transition table must include:

- `FINAL_REVIEW -> COMPOSITION_PENDING` for Render Again, preserving old render;
- `FINAL_REVIEW -> VOICE_GENERATING` for Change Voice;
- `FINAL_REVIEW -> SCENES_REVIEW` for Return to Scenes;
- `FINAL_REVIEW -> COMPOSITION_PENDING` after Change CTA creates a new approved concept revision or render override according to the UI decision;
- `CONCEPT_REVIEW -> CONCEPT_GENERATING` for regenerate;
- retry transitions from recorded `failed_from_state` only after guards pass.

No transition deletes prior accepted/generated artifacts.

## Production operability review

### Strengths

- Clear API/worker split and graceful restart model.
- Queue and provider concurrency are configuration, not hard-coded.
- Health/readiness separation and structured identifiers are planned.
- Migrations are explicit and deployment-independent.
- READY and working storage are separate boundaries.

### Required before live use

- Backups and restore rehearsal for PostgreSQL and working media.
- Disk-capacity alerts and a documented retention policy.
- Redis persistence/availability choice; recovery works without it, but queue latency should still be monitored.
- Nginx authentication and named approval actors.
- Provider spend caps and alerting outside the application as defense in depth.
- A dead-letter/operator recovery view for permanent and ambiguous failures.
- OneDrive mount behavior tested with partial-file rename, antivirus/sync locking, and checksum verification.
- Worker shutdown and provider reconciliation exercised under forced termination.

## External provider review

- OpenAI Structured Outputs is sufficiently documented to define the port, but account/model selection remains configuration.
- Kling async task IDs, polling, callback URL, external task IDs, reference images, and temporary outputs are documented. Authentication, callback verification, current account capability/concurrency, and reconciliation by external ID still require verification before code is enabled.
- ElevenLabs synchronous binary TTS is documented. Its ambiguous-request/idempotency behavior and selected timing endpoint need verification.
- Creatomate is plausible but not committed as the only renderer. A template proof must confirm safe areas, caption timing, ducking, private media ingestion, and output codecs.

## Amendments required during implementation

1. Encode state transitions in one explicit transition policy and test every allowed reverse/rework path.
2. Treat scene failures locally unless they make the project unrecoverable.
3. Persist the creative input facts/restrictions snapshot, not only prompt/model metadata.
4. Add provider-job `SUBMISSION_UNKNOWN` as a first-class status and UI condition.
5. Bind final approval and READY publication to render ID plus checksum.
6. Keep the fake renderer honest: its test artifact proves orchestration/storage only and must never be represented as a production-valid MP4.
7. Do not enable any real provider from the default application wiring.

## Go/no-go decision

**Go for Milestone 0 and Milestone 1 foundation work.**

No-go for real provider adapters or deployment until the provider-specific open questions and production prerequisites above are resolved.

