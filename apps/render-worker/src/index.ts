import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { RenderWorkerClient } from "./client.js";
import { configureWorker, enrollWorker, loadWorkerConfig } from "./config.js";
import { detectEncoder, detectTools, probeOutput, render } from "./renderer.js";
import { PROTOCOL_VERSION, WORKER_CAPABILITIES } from "./types.js";

async function main(): Promise<void> {
  if (process.argv[2] === "enroll") {
    const serverIndex = process.argv.indexOf("--server");
    await enrollWorker(serverIndex >= 0 ? process.argv[serverIndex + 1] : undefined);
    return;
  }
  if (process.argv[2] === "configure") {
    const serverIndex = process.argv.indexOf("--server");
    if (serverIndex < 0 || !process.argv[serverIndex + 1]) throw new Error("Usage: CreativeFactoryRenderWorker.exe configure --server <private-url>");
    await configureWorker(process.argv[serverIndex + 1]!, process.env.RENDER_WORKER_ENCODER);
    return;
  }
  const config = await loadWorkerConfig();
  await mkdir(config.dataRoot, { recursive: true }); await detectTools(config.ffmpegPath, config.ffprobePath, config.fontPath); const encoder = await detectEncoder(config.ffmpegPath, config.preferredEncoder); const client = new RenderWorkerClient(config);
  console.log(`Koolezt Creative Factory Render Worker ${config.workerVersion}`); console.log(`Protocol ${PROTOCOL_VERSION} | Encoder ${encoder}`);
  let paused = false; let stopping = false;
  process.once("SIGINT", () => { stopping = true; }); process.once("SIGTERM", () => { stopping = true; });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => { if (key.toLowerCase() === "p") { paused = true; console.log("Worker paused; the current job will finish safely."); } else if (key.toLowerCase() === "r") { paused = false; console.log("Worker resumed."); } else if (key.toLowerCase() === "q" || key === "\u0003") stopping = true; });
    console.log("Controls: P pause | R resume | Q exit");
  }
  let registered = false;
  while (!stopping) {
    if (paused) { await new Promise((resolveWait) => setTimeout(resolveWait, 1_000)); continue; }
    if (!registered) {
      try {
        await client.register([encoder], WORKER_CAPABILITIES);
        registered = true;
        console.log("Connected");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Worker registration failed.";
        console.error(`Connection unavailable: ${message} Retrying in 5 seconds.`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
        continue;
      }
    }
    let job: Awaited<ReturnType<RenderWorkerClient["claim"]>>;
    try {
      job = await client.claim([encoder], WORKER_CAPABILITIES);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker claim failed.";
      console.error(`Connection unavailable: ${message} Retrying in 5 seconds.`);
      registered = false;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
      continue;
    }
    if (!job) { await new Promise((resolveWait) => setTimeout(resolveWait, 5_000)); continue; }
    const workspace = client.jobPath(job.jobId); const leaseTimer = setInterval(() => void client.renew(job).catch(() => undefined), 60_000); leaseTimer.unref();
    try {
      console.log(`Current Job ${job.projectPublicId} | Downloading`); await client.progress(job, "Downloading", 5, encoder);
      const scenePaths = job.scenes.map((item) => client.cachePath(item.sha256)); for (let index = 0; index < job.scenes.length; index++) await client.download(job, job.scenes[index]!, scenePaths[index]!);
      const narrationPath = client.cachePath(job.narration.sha256); await client.download(job, job.narration, narrationPath);
      const musicPath = job.music ? client.cachePath(job.music.sha256) : undefined; if (job.music && musicPath) await client.download(job, job.music, musicPath);
      await mkdir(workspace, { recursive: true }); const outputPath = join(workspace, "output.tmp.mp4"); await client.progress(job, "Preparing", 15, encoder); await client.progress(job, "Rendering", 25, encoder);
      await render(job, scenePaths, narrationPath, outputPath, config.ffmpegPath, encoder, workspace, musicPath, config.fontPath); await client.progress(job, "QA", 85, encoder); const inspection = await probeOutput(config.ffprobePath, outputPath, job); console.log(`QA ${inspection.width}x${inspection.height} ${inspection.durationMs}ms ${inspection.videoCodec}/${inspection.audioCodec}`);
      await client.progress(job, "Uploading", 92, encoder); await client.upload(job, outputPath); console.log(`Current Job ${job.projectPublicId} | Completed`); await rm(workspace, { recursive: true, force: true }); await client.pruneCache();
    } catch (error) { const diagnostic = error instanceof Error ? error.message : "Unknown worker failure."; const message = /checksum|HTTP \d{3}|protocol|encoder|ffprobe QA/i.test(diagnostic) ? diagnostic : "Local FFmpeg rendering failed."; console.error(`Job ${job.projectPublicId} failed: ${message}`); await client.fail(job, "DESKTOP_RENDER_FAILED", message).catch(() => undefined); }
    finally { clearInterval(leaseTimer); }
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Render worker stopped."); process.exitCode = 1; });
