import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.js";

const motionLabel: Record<string, string> = { ZOOM_IN: "slow zoom in", ZOOM_OUT: "slow zoom out", PAN_LEFT: "pan left", PAN_RIGHT: "pan right" };
const statusLabel: Record<string, string> = { PLANNED: "Plan", QUEUED: "Waiting to be made", RENDERING: "Making video…", READY: "Video ready", FAILED: "Failed" };
// Same text as SCENE_IMAGE_PRODUCT_RULES / SCENE_VIDEO_PRODUCT_RULES in @koolezt/domain; the server adds them to every AI image request.
const IMAGE_RULES = "Use the attached product photo as the exact product. Keep its shape, colors, printed artwork, text and proportions identical; do not redraw, warp or restyle it. Vertical 9:16 photorealistic photo. No added text, logos or watermarks.";
const VIDEO_RULES = "The product stays completely still and unchanged: no morphing, no new text, no warping of the printed artwork.";
const styleLabel: Record<string, string> = { PHOTO_MOTION: "Photo motion", STOP_MOTION: "Stop motion" };
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const hasAiImage = (scene: any) => scene.imageStatus === "READY" && scene.sceneImageAssetId;
const makingImages = (video: any) => video.plan.scenes.some((scene: any) => scene.imageStatus === "GENERATING");

/** Shows only the scene's own description; Copy gives the full prompt with the product rules in front. */
function CopyPrompt({ label, text, rules }: Readonly<{ label: string; text?: string; rules: string }>) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return <div className="scene-prompt"><div><b>{label}</b><button type="button" title="Copies the full prompt including the product rules" onClick={() => void navigator.clipboard.writeText(`${rules}\n\nScene: ${text}`).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copied" : "Copy"}</button></div><p>{text}</p></div>;
}

/** Lets the owner change a plan before making it: photo, caption, length and motion of each scene, scene order, and the words. */
function PlanEditor({ video, photos, onSaved, onCancel }: Readonly<{ video: any; photos: readonly any[]; onSaved: () => Promise<void>; onCancel: () => void }>) {
  const [draft, setDraft] = useState<any>(() => structuredClone(video.plan));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (field: string, value: unknown) => setDraft((current: any) => ({ ...current, [field]: value }));
  const setScene = (index: number, field: string, value: unknown) => set("scenes", draft.scenes.map((scene: any, at: number) => at === index ? { ...scene, [field]: value } : scene));
  const move = (index: number, step: number) => {
    const scenes = [...draft.scenes];
    const [scene] = scenes.splice(index, 1);
    scenes.splice(index + step, 0, scene);
    set("scenes", scenes);
  };
  const save = async () => {
    setSaving(true); setError("");
    try { await api(`/api/videos/${video.id}/plan`, "PUT", draft); await onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the plan."); } finally { setSaving(false); }
  };
  return <article className="plan-card plan-editor">
    <label>Title<input value={draft.title} maxLength={120} onChange={(event) => set("title", event.target.value)} /></label>
    <label>Hook (first 3s, on screen)<input value={draft.hookText} maxLength={60} onChange={(event) => set("hookText", event.target.value)} /></label>
    <label>Voiceover<textarea rows={4} value={draft.voiceover} maxLength={900} onChange={(event) => set("voiceover", event.target.value)} /></label>
    <label>Call to action (last scene)<input value={draft.ctaText} maxLength={40} onChange={(event) => set("ctaText", event.target.value)} /></label>
    <label>Style<select value={draft.style ?? "PHOTO_MOTION"} onChange={(event) => set("style", event.target.value)}>{Object.entries(styleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <b>Scenes</b>
    <ol className="scene-editor">{draft.scenes.map((scene: any, index: number) => <li key={index}>
      {scene.sceneImageAssetId
        ? <div className="scene-ai-image"><img src={`/api/assets/${scene.sceneImageAssetId}`} alt="AI scene" /><div><b>AI scene image</b><button type="button" onClick={() => setDraft((current: any) => ({ ...current, scenes: current.scenes.map((item: any, at: number) => at === index ? { ...item, sceneImageAssetId: undefined, imageStatus: undefined, imageError: undefined } : item) }))}>Use product photo instead</button></div></div>
        : <div className="scene-photos">{photos.map((photo: any) => <button type="button" key={photo.id} className={photo.id === scene.photoAssetId ? "chosen" : ""} title={photo.label} onClick={() => setScene(index, "photoAssetId", photo.id)}><img src={`/api/assets/${photo.id}`} alt={photo.label} /></button>)}</div>}
      <label>Caption<input value={scene.caption} maxLength={80} onChange={(event) => setScene(index, "caption", event.target.value)} /></label>
      <div className="scene-row">
        <label>Seconds<input type="number" min={1} max={15} step={0.5} value={scene.durationMs / 1000} onChange={(event) => setScene(index, "durationMs", Math.round(Math.min(15, Math.max(1, Number(event.target.value) || 1)) * 1000))} /></label>
        <label>Motion<select value={scene.motion} onChange={(event) => setScene(index, "motion", event.target.value)}>{Object.entries(motionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label>AI image: this scene (product rules are added automatically)<textarea rows={3} value={scene.imagePrompt ?? ""} maxLength={1500} onChange={(event) => setScene(index, "imagePrompt", event.target.value)} /></label>
      <label>Kling / Seedance video: this scene<textarea rows={3} value={scene.videoPrompt ?? ""} maxLength={1500} onChange={(event) => setScene(index, "videoPrompt", event.target.value)} /></label>
      <div className="scene-row">
        <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>↑ Up</button>
        <button type="button" disabled={index === draft.scenes.length - 1} onClick={() => move(index, 1)}>↓ Down</button>
        <button type="button" className="danger" disabled={draft.scenes.length <= 2} onClick={() => set("scenes", draft.scenes.filter((_: any, at: number) => at !== index))}>Remove</button>
      </div>
    </li>)}</ol>
    <button type="button" disabled={draft.scenes.length >= 8} onClick={() => set("scenes", [...draft.scenes, { ...draft.scenes.at(-1), caption: "" }])}>+ Add scene</button>
    <p className="muted small">Seconds set how long each scene lasts compared with the others; the video is stretched to fit the voiceover.</p>
    {error && <p className="error small" role="alert">{error}</p>}
    <div className="scene-row"><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save plan"}</button><button type="button" disabled={saving} onClick={onCancel}>Cancel</button></div>
  </article>;
}

function PlanCard({ video, selected, working, onToggle, onEdit, onSceneImages }: Readonly<{ video: any; selected: boolean; working: boolean; onToggle: () => void; onEdit: () => void; onSceneImages: (scenes?: number[]) => void }>) {
  const plan = video.plan;
  const busyImages = makingImages(video);
  const selectable = (video.status === "PLANNED" || video.status === "FAILED") && !busyImages;
  const editable = (video.status === "PLANNED" || video.status === "FAILED" || video.status === "READY") && !busyImages;
  const canMakeImages = editable && plan.scenes.some((scene: any) => scene.imagePrompt);
  const aiCount = plan.scenes.filter(hasAiImage).length;
  return <article className={`plan-card ${video.status.toLowerCase()} ${selected ? "selected" : ""}`}>
    <header>
      {busyImages ? <span className="plan-status rendering">Making AI scene images…</span> : selectable ? <label className="plan-select"><input type="checkbox" checked={selected} onChange={onToggle} /> Make this video</label> : <span className={`plan-status ${video.status.toLowerCase()}`}>{statusLabel[video.status] ?? video.status}</span>}
      <h4>{video.ordinal}. {plan.title}</h4>
      <span className="plan-style">{styleLabel[plan.style ?? "PHOTO_MOTION"]}</span>
    </header>
    {video.status === "READY" && video.outputAssetId && <div className="plan-video"><video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} /><a className="button primary" href={`/api/videos/${video.id}/download`}>Download MP4</a></div>}
    {video.status === "PLANNED" && video.outputAssetId && <div className="plan-video"><small className="muted">Video from before your edits (make it again to update):</small><video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} /></div>}
    {video.status === "FAILED" && video.failureMessage && <p className="error small">{video.failureMessage}</p>}
    <dl>
      <dt>Keeps from the winner</dt><dd>{plan.keepsFromWinner || "—"}</dd>
      <dt>What's new</dt><dd>{plan.changes || "—"}</dd>
      <dt>Hook (first 3s)</dt><dd><b>{plan.hookText}</b></dd>
      <dt>Call to action</dt><dd>{plan.ctaText}</dd>
    </dl>
    <details open><summary>Voiceover and scenes</summary>
      <p className="voiceover">"{plan.voiceover}"</p>
      <ol className="plan-scenes">{plan.scenes.map((scene: any, index: number) => <li key={index}><a href={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} alt="" /></a><div><b>{scene.caption || "No caption"}</b><small>{seconds(scene.durationMs)} · {motionLabel[scene.motion] ?? scene.motion}{hasAiImage(scene) ? " · AI image" : ""}</small>
          {scene.imageStatus === "GENERATING" && <small className="muted">Making AI image…</small>}
          {scene.imageStatus === "FAILED" && <small className="error">AI image failed: {scene.imageError}</small>}
          {canMakeImages && scene.imagePrompt && <button type="button" className="link-button" disabled={working} onClick={() => onSceneImages([index])}>{hasAiImage(scene) || scene.imageStatus === "FAILED" ? "Make AI image again" : "Make AI image"}</button>}</div>
        <CopyPrompt label="AI image: this scene" text={scene.imagePrompt} rules={IMAGE_RULES} /><CopyPrompt label="Kling / Seedance video: this scene" text={scene.videoPrompt} rules={VIDEO_RULES} /></li>)}</ol>
    </details>
    {canMakeImages && <button type="button" disabled={working} onClick={() => onSceneImages()}>{aiCount ? `Make all ${plan.scenes.length} AI scene images again` : `Make AI scene images (${plan.scenes.length})`}</button>}
    {busyImages && <p className="muted small">OpenAI is making one image per scene from the main product photo. This takes about 1–2 minutes and refreshes automatically.</p>}
    {editable && <button type="button" onClick={onEdit}>{video.status === "READY" ? "Edit and make again" : "Edit photos and scenes"}</button>}
  </article>;
}

/** Small tile in the plan list: thumbnail, title and status. Clicking it opens the plan in the panel on the right. */
function PlanTile({ video, open, selected, onOpen, onToggle }: Readonly<{ video: any; open: boolean; selected: boolean; onOpen: () => void; onToggle: () => void }>) {
  const first = video.plan.scenes[0];
  const still = first ? (hasAiImage(first) ? first.sceneImageAssetId : first.photoAssetId) : undefined;
  const selectable = (video.status === "PLANNED" || video.status === "FAILED") && !makingImages(video);
  return <div className={`plan-tile ${open ? "open" : ""} ${selected ? "selected" : ""}`}>
    <button type="button" className="plan-tile-open" onClick={onOpen}>
      <div className="plan-tile-thumb">{video.status === "READY" && video.outputAssetId
        ? <video src={`/api/assets/${video.outputAssetId}#t=0.5`} preload="metadata" muted playsInline />
        : still ? <img src={`/api/assets/${still}`} alt="" /> : null}</div>
      <b>{video.ordinal}. {video.plan.title}</b>
      <span className={`plan-status ${makingImages(video) ? "rendering" : video.status.toLowerCase()}`}>{makingImages(video) ? "Making AI images…" : statusLabel[video.status] ?? video.status}</span>
    </button>
    {selectable && <label className="plan-select"><input type="checkbox" checked={selected} onChange={onToggle} /> Make</label>}
  </div>;
}

/** Writes new video plans from an analyzed winner, then makes the chosen ones on the server. */
export function MakeVideos({ referenceId, reportReady }: Readonly<{ referenceId: string; reportReady: boolean }>) {
  const [batches, setBatches] = useState<any[]>([]);
  const [count, setCount] = useState<3 | 6 | 12>(6);
  const [length, setLength] = useState<15 | 30>(15);
  const [style, setStyle] = useState<"PHOTO_MOTION" | "STOP_MOTION">("PHOTO_MOTION");
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [open, setOpen] = useState("");
  // The winners page has an empty column on the right (#plan-panel); the open plan is shown and edited there.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useEffect(() => { setPanel(document.getElementById("plan-panel")); }, []);
  const [products, setProducts] = useState<any[]>([]);
  const load = useCallback(async () => setBatches(await api(`/api/video-batches?referenceId=${encodeURIComponent(referenceId)}`)), [referenceId]);
  useEffect(() => { void api("/api/products").then(setProducts).catch(() => undefined); }, []);
  const photosOf = (productId: string) => (products.find((product: any) => product.id === productId)?.assets ?? []).filter((asset: any) => asset.kind === "IMAGE");
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load videos.")); }, [load]);
  const busy = batches.some((entry) => entry.batch.status === "WRITING" || entry.videos.some((video: any) => video.status === "QUEUED" || video.status === "RENDERING" || makingImages(video)));
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
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const openEntry = batches.flatMap((entry) => entry.videos.map((video: any) => ({ video, batch: entry.batch }))).find((entry) => entry.video.id === open);
  const detail = openEntry && <div className="plan-panel-body">
    <div className="plan-panel-header"><span className="muted small">Plan {openEntry.video.ordinal} · {openEntry.batch.targetDurationMs / 1000}s</span><button type="button" onClick={() => { setOpen(""); setEditing(""); }}>Close</button></div>
    {editing === openEntry.video.id
      ? <PlanEditor key={openEntry.video.id} video={openEntry.video} photos={photosOf(openEntry.batch.productId)} onCancel={() => setEditing("")} onSaved={async () => { setEditing(""); await load(); }} />
      : <PlanCard key={openEntry.video.id} video={openEntry.video} working={working} selected={selected.includes(openEntry.video.id)} onEdit={() => setEditing(openEntry.video.id)} onSceneImages={(scenes) => void run(() => api(`/api/videos/${openEntry.video.id}/scene-images`, "POST", scenes ? { scenes } : {}), "Could not start the AI scene images.")} onToggle={() => toggle(openEntry.video.id)} />}
  </div>;

  return <section className="card make-videos">
    <h3>Make new videos from this winner</h3>
    {!reportReady ? <p className="muted">Available once the analysis report is ready.</p> : <>
      <p className="muted">Claude writes video plans that keep what made this ad work and change one thing each. You choose which ones to make; videos are built from your product photos with captions and an AI voiceover. Each scene also gets an OpenAI image prompt and a Kling/Seedance video prompt you can copy.</p>
      <div className="make-controls">
        <label>How many<select value={count} onChange={(event) => setCount(Number(event.target.value) as 3 | 6 | 12)}><option value={3}>3 videos</option><option value={6}>6 videos</option><option value={12}>12 videos</option></select></label>
        <label>Length<select value={length} onChange={(event) => setLength(Number(event.target.value) as 15 | 30)}><option value={15}>15 seconds</option><option value={30}>30 seconds</option></select></label>
        <label>Style<select value={style} onChange={(event) => setStyle(event.target.value as "PHOTO_MOTION" | "STOP_MOTION")}><option value="PHOTO_MOTION">Photo motion (smooth zoom and pan)</option><option value="STOP_MOTION">Stop motion (hand-made jumps)</option></select></label>
        <button className="primary" disabled={working || writing} onClick={() => void run(() => api(`/api/creative-references/${referenceId}/video-plans`, "POST", { count, durationSeconds: length, style }), "Could not start writing plans.")}>{writing ? "Writing plans…" : `Write ${count} video plans`}</button>
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
          <div className="plan-tiles">{videos.map((video: any) => <PlanTile key={video.id} video={video} open={open === video.id} selected={selected.includes(video.id)} onOpen={() => { setOpen(video.id); setEditing(""); }} onToggle={() => toggle(video.id)} />)}</div>
          <div className="winner-actions"><button className="primary" disabled={working || !chosen.length} onClick={() => void run(async () => { await api(`/api/video-batches/${batch.id}/make`, "POST", { videoIds: chosen.map((video: any) => video.id) }); setSelected((current) => current.filter((id) => !chosen.some((video: any) => video.id === id))); }, "Could not start making videos.")}>Make {chosen.length || ""} selected video{chosen.length === 1 ? "" : "s"}</button><span className="muted small">Each video takes about 20–40 seconds to make, one after another.</span></div>
        </>}
      </div>;
    })}
    {detail && (panel ? createPortal(detail, panel) : detail)}
  </section>;
}
