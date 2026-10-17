# Seedance 2.5 API facts

Verified against the [official BytePlus LAS video-generation documentation](https://docs.byteplus.com/en/docs/byteplus_las/video_gen_enhanced) on 2026-08-30. This adapter intentionally uses only the Phase 1 subset.

- Task creation is `POST https://operator.las.ap-southeast-1.bytepluses.com/api/v1/contents/generations/tasks` with `Authorization: Bearer <LAS API key>`.
- Creation returns a task `id`; task status is queried at `GET /api/v1/contents/generations/tasks/{id}`. The documented task states include `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `expired`.
- `dreamina-seedance-2-5-260628` supports text and image/reference inputs, 4–30 second MP4 output at 24 fps, and 480p/720p resolution. The Phase 1 default is a five-second, `9:16`, 720p silent clip.
- Generation uses the documented `content` array: text is `{ "type": "text", "text": "..." }`; a staged image reference is `{ "type": "image_url", "image_url": { "url": "..." }, "role": "reference_image" }`. The documented aspect field is `ratio`, and `generate_audio=false` requests a silent source scene.
- A temporary signed URL is acceptable as a provider input only while it remains valid. The generated video URL is returned by the task query, is documented as valid for 24 hours, and is never Koolezt's permanent asset identity.
- The API supports callbacks, but Phase 1 deliberately uses the existing durable polling path. The adapter does not rely on undocumented provider-side idempotency fields; Koolezt's operation and provider-job records remain authoritative.
- The documented non-4k limits are 600 RPM and 10 concurrent operations. Koolezt defaults to a conservative worker cap of one and keeps it configurable.

No real BytePlus request was made for this implementation. Before a paid smoke test, configure server-side credentials, private S3 staging, a safe worker concurrency, and explicit paid-test authorization.
