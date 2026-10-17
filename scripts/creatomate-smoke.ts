import { HttpCreatomateTransport } from "@koolezt/providers";

if (process.env.COMPOSITION_PROVIDER !== "creatomate" || process.env.EXTERNAL_MEDIA_DELIVERY_PROVIDER !== "s3" || process.env.KOOLEZT_ALLOW_PAID_PROVIDER_TESTS !== "true") {
  throw new Error("Refusing paid smoke test: set COMPOSITION_PROVIDER=creatomate, EXTERNAL_MEDIA_DELIVERY_PROVIDER=s3, and KOOLEZT_ALLOW_PAID_PROVIDER_TESTS=true.");
}
if (!process.env.CREATOMATE_API_KEY || !process.env.CREATOMATE_SMOKE_MEDIA_URL || !process.env.S3_ENDPOINT || !process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  throw new Error("Creatomate credentials, S3/R2 credentials, and a pre-staged CREATOMATE_SMOKE_MEDIA_URL are required for the explicit smoke test.");
}
const transport = new HttpCreatomateTransport(process.env.CREATOMATE_API_KEY);
const render = await transport.createRender({ output_format: "mp4", width: 1080, height: 1920, frame_rate: 30, duration: 1, elements: [{ type: "video", source: process.env.CREATOMATE_SMOKE_MEDIA_URL, track: 1, duration: 1, width: "100%", height: "100%", fit: "cover" }] }, `smoke:${Date.now()}`);
console.log(JSON.stringify({ provider: "creatomate", renderId: render.id, status: render.status }));
