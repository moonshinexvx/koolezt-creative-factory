import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const motionLabel: Record<string, string> = { ZOOM_IN: "slow zoom in", ZOOM_OUT: "slow zoom out", PAN_LEFT: "pan left", PAN_RIGHT: "pan right" };
const statusLabel: Record<string, string> = { PLANNED: "Plan", QUEUED: "Waiting to be made", RENDERING: "Making video…", READY: "Video ready", FAILED: "Failed" };
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

function PlanCard({ video, selected, onToggle }: Readonly<{ video: any; selected: boolean; onToggle: () => void }>) {
  const plan = video.plan;
  const selectable = video.status === "PLANNED" || video.status === "FAILED";
  return <article className={`plan-card ${video.status.toLowerCase()} ${selected ? "selected" : ""}`}>
    <header>
      {selectable ? <label className="plan-select"><input type="checkbox" checked={selected} onChange={onToggle} /> Make this video</label> : <span className={`plan-status ${video.status.toLowerCase()}`}>{statusLabel[video.status] ?? video.status}</span>}
      <h4>{video.ordinal}. {plan.title}</h4>
    </header>
    {video.status === "READY" && video.outputAssetId && <div className="plan-video"><video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} /><a className="button primary" href={`/api/videos/${video.id}/download`}>Download MP4</a></div>}
    {video.status === "FAILED" && video.failureMessage && <p className="error small">{video.failureMessage}</p>}
    <dl>
      <dt>Keeps from the winner</dt><dd>{plan.keepsFromWinner || "—"}</dd>
      <dt>What's new</dt><dd>{plan.changes || "—"}</dd>
      <dt>Hook (first 3s)</dt><dd><b>{plan.hookText}</b></dd>
      <dt>Call to action</dt><dd>{plan.ctaText}</dd>
    </dl>
    <details><summary>Voiceover and scenes</summary>
      <p className="voiceover">"{plan.voiceover}"</p>
      <ol className="plan-scenes">{plan.scenes.map((scene: any, index: number) => <li key={index}><img src={`/api/assets/${scene.photoAssetId}`} alt="" /><div><b>{scene.caption || "No caption"}</b><small>{seconds(scene.durationMs)} · {motionLabel[scene.motion] ?? scene.motion}</small></div></li>)}</ol>
    </details>
  </article>;
}

/** Writes new video plans from an analyzed winner, then makes the chosen ones on the server. */
export function MakeVideos({ referenceId, reportReady }: Readonly<{ referenceId: string; reportReady: boolean }>) {
  const [batches, setBatches] = useState<any[]>([]);
  const [count, setCount] = useState<3 | 6 | 12>(6);
  const [length, setLength] = useState<15 | 30>(15);
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => setBatches(await api(`/api/video-batches?referenceId=${encodeURIComponent(referenceId)}`)), [referenceId]);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load videos.")); }, [load]);
  const busy = batches.some((entry) => entry.batch.status === "WRITING" || entry.videos.some((video: any) => video.status === "QUEUED" || video.status === "RENDERING"));
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [busy, load]);
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setWorking(true); setError("");
    try { await action(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : failure); } finally { setWorking(false); }
  };
  const writing = batches.some((entry) => entry.batch.status === "WRITING");

  return <section className="card make-videos">
    <h3>Make new videos from this winner</h3>
    {!reportReady ? <p className="muted">Available once the analysis report is ready.</p> : <>
      <p className="muted">Claude writes video plans that keep what made this ad work and change one thing each. You choose which ones to make; videos are built from your product photos with captions and an AI voiceover.</p>
      <div className="make-controls">
        <label>How many<select value={count} onChange={(event) => setCount(Number(event.target.value) as 3 | 6 | 12)}><option value={3}>3 videos</option><option value={6}>6 videos</option><option value={12}>12 videos</option></select></label>
        <label>Length<select value={length} onChange={(event) => setLength(Number(event.target.value) as 15 | 30)}><option value={15}>15 seconds</option><option value={30}>30 seconds</option></select></label>
        <button className="primary" disabled={working || writing} onClick={() => void run(() => api(`/api/creative-references/${referenceId}/video-plans`, "POST", { count, durationSeconds: length }), "Could not start writing plans.")}>{writing ? "Writing plans…" : `Write ${count} video plans`}</button>
      </div>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {batches.map(({ batch, videos }) => {
      const chosen = videos.filter((video: any) => selected.includes(video.id));
      return <div className="plan-batch" key={batch.id}>
        <div className="plan-batch-header"><b>{batch.requestedCount} plans · {batch.targetDurationMs / 1000}s</b><span className="muted small">{new Date(batch.createdAt).toLocaleString()}</span></div>
        {batch.status === "WRITING" && <p className="muted">Claude is writing {batch.requestedCount} plans. This usually takes 1–2 minutes and refreshes automatically.</p>}
        {batch.status === "FAILED" && <p className="error">Writing these plans failed: {batch.failureMessage ?? "unknown error"}. Start a new set to try again.</p>}
        {batch.status === "READY" && <>
          <div className="plan-grid">{videos.map((video: any) => <PlanCard key={video.id} video={video} selected={selected.includes(video.id)} onToggle={() => setSelected((current) => current.includes(video.id) ? current.filter((id) => id !== video.id) : [...current, video.id])} />)}</div>
          <div className="winner-actions"><button className="primary" disabled={working || !chosen.length} onClick={() => void run(async () => { await api(`/api/video-batches/${batch.id}/make`, "POST", { videoIds: chosen.map((video: any) => video.id) }); setSelected((current) => current.filter((id) => !chosen.some((video: any) => video.id === id))); }, "Could not start making videos.")}>Make {chosen.length || ""} selected video{chosen.length === 1 ? "" : "s"}</button><span className="muted small">Each video takes about 20–40 seconds to make, one after another.</span></div>
        </>}
      </div>;
    })}
  </section>;
}
