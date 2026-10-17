# Kling API facts verified for Milestone 6

Verified against the current official Kling AI Open Platform documentation on 2026-08-29:

- [Authentication](https://kling.ai/document-api/api/get-started/authentication) and current API examples use `Authorization: Bearer <api key>`. Koolezt accepts that server-side credential as `KLING_API_KEY`; it does not invent or expose a browser-side token flow.
- [Kling 3.0 Turbo text-to-video](https://kling.ai/document-api/api/video/3-0-turbo/text-to-video) creates a task with `POST /text-to-video/kling-3.0-turbo`.
- [Kling 3.0 Turbo image-to-video](https://kling.ai/document-api/api/video/3-0-turbo/image-to-video) creates a task with `POST /image-to-video/kling-3.0-turbo`. Image input is a URL-bearing `contents` entry, so Koolezt supplies an authorized, operation-scoped presigned staging URL rather than a private path.
- Current model-routed requests use `settings` for resolution, duration, and text-to-video aspect ratio; `options.external_task_id` is account-unique and can be queried. Koolezt derives it deterministically from the internal operation key.
- Task polling uses `GET /tasks?task_ids=<id>`. Documented states are `submitted`, `processing`, `succeeded`, and `failed`.
- Successful task output contains typed output records and provider-hosted URLs. The documentation says generated images/videos are removed after 30 days, so Koolezt ingests output immediately into private working storage.
- The API supports callbacks, but Phase 1 deliberately uses the existing durable polling path. Webhooks remain a future throughput optimization.
- The official [concurrency rules](https://kling.ai/document-api/api/get-started/concurrency-rules) are account/capability dependent. Koolezt does not hard-code a claimed provider limit; BullMQ worker concurrency remains conservative and account limits are mapped from provider errors.
- Current 3.0 Turbo video duration is 3–15 seconds and text-to-video supports `9:16`. The model slug stays configurable because models and capability maps evolve.

The adapter intentionally implements only text-to-video and image-to-video for Phase 1. It does not expose arbitrary Kling request properties, callbacks, or provider URLs to the frontend.
