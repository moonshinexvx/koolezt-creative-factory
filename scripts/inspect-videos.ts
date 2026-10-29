// Read-only: copies the latest finished videos to /tmp/cf-videos and prints each one's scene settings,
// stream lengths and any frozen stretches, so playback problems can be diagnosed without touching data.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "../apps/api/src/runtime.js";

const limit = Number(process.argv[2] ?? "3");
const out = "/tmp/cf-videos";
const runtime = createRuntime();
try {
  await mkdir(out, { recursive: true });
  const rows = (await runtime.pool.query("SELECT id, output_asset_id, plan FROM winner_videos WHERE status='READY' AND output_asset_id IS NOT NULL ORDER BY updated_at DESC LIMIT $1", [limit])).rows as { id: string; output_asset_id: string; plan: { title: string; style?: string; captionStyle?: string; scenes: { durationMs: number; transition?: string; motion: string; sceneImageAssetId?: string }[] } }[];
  for (const row of rows) {
    const asset = await runtime.storage.getAsset(row.output_asset_id);
    const file = join(out, `${row.id.slice(0, 8)}.mp4`);
    await writeFile(file, await runtime.storage.read(asset.storageKey));
    console.log(`\n${row.id.slice(0, 8)} "${row.plan.title}" style=${row.plan.style ?? "-"} captions=${row.plan.captionStyle ?? "-"} -> ${file}`);
    console.log("scenes:", row.plan.scenes.map((scene) => `${scene.durationMs}ms ${scene.transition ?? "-"} ${scene.motion}${scene.sceneImageAssetId ? " AI" : ""}`).join(" | "));
    console.log(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration,nb_frames,r_frame_rate", "-of", "csv=p=0", file]).toString().trim());
    const scan = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", "freezedetect=n=0.001:d=1", "-map", "0:v", "-f", "null", "-"], { encoding: "utf8" });
    const freezes = scan.stderr.split("
").filter((line) => line.includes("freeze_")).map((line) => line.replace(/^.*lavfi\./, "").trim());
    console.log(freezes.length ? `frozen: ${freezes.join(", ")}` : "frozen: none");
  }
} finally {
  await runtime.pool.end();
}
