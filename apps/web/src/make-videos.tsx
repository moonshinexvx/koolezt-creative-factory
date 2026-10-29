import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.js";

const motionLabel: Record<string, string> = { ZOOM_IN: "slow zoom in", ZOOM_OUT: "slow zoom out", PAN_LEFT: "pan left", PAN_RIGHT: "pan right" };
const statusLabel: Record<string, string> = { PLANNED: "Plan", QUEUED: "Waiting to be made", RENDERING: "Making video…", READY: "Video ready", FAILED: "Failed" };
// Same text as SCENE_IMAGE_PRODUCT_RULES / SCENE_VIDEO_PRODUCT_RULES in @koolezt/domain; the server adds them to every AI image request.
const IMAGE_RULES = "Use the attached product photo as the exact product. Keep its shape, colors, printed artwork, text and proportions identical; do not redraw, warp or restyle it. Vertical 9:16 photorealistic photo. No added text, logos or watermarks.";
const VIDEO_RULES = "The product stays completely still and unchanged: no morphing, no new text, no warping of the printed artwork.";
const styleLabel: Record<string, string> = { PHOTO_MOTION: "Photo motion", STOP_MOTION: "Stop motion" };
const formatLabel: Record<string, string> = { CUSTOMER_REVIEW: "Customer review", BEFORE_AFTER: "Before / after", THREE_REASONS: "3 reasons", GIFT_REACTION: "Gift reaction", PET_POV_STORY: "Pet's story", DETAIL_CLOSEUPS: "Detail close-ups", PROBLEM_SOLUTION: "Problem → solution", COMPARISON: "Comparison", DAY_IN_THE_LIFE: "Day in the life", BOLD_STATEMENT: "Bold statement" };
const hookLabel: Record<string, string> = { QUESTION: "Question", POV: "POV", STOP_SCROLLING: "Stop scrolling", BEFORE_AFTER: "Before / after", BOLD_CLAIM: "Bold claim", CURIOSITY: "Curiosity", EMOTIONAL: "Emotional", SOCIAL_PROOF: "Social proof" };
const captionLabel: Record<string, string> = { CLASSIC: "Classic box", BOLD_POP: "Big words pop in", REVIEW: "Review bubble", TITLE_CARD: "Orange title band" };
const musicLabel: Record<string, string> = { NONE: "No music", UPBEAT: "Upbeat", WARM: "Warm", EMOTIONAL: "Emotional", CALM: "Calm" };
const transitionLabel: Record<string, string> = { CUT: "Hard cut", FADE: "Fade", WHIP: "Whip", ZOOM: "Zoom punch" };
const checkLabel: Record<string, string> = { hook: "Hook", story: "Story", shots: "Shots", callToAction: "Call to action", claims: "Claims" };
const verdictLabel: Record<string, string> = { STRONG: "Strong", OK: "OK", WEAK: "Weak", VERIFIED: "Checked", FIXED: "Fixed" };
const verdictMark: Record<string, string> = { STRONG: "✓", OK: "•", WEAK: "!", VERIFIED: "✓", FIXED: "✎" };
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse", "cedar"];
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const options = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>);
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
    <div className="scene-row">
      <label>Style<select value={draft.style ?? "PHOTO_MOTION"} onChange={(event) => set("style", event.target.value)}>{options(styleLabel)}</select></label>
      <label>Captions<select value={draft.captionStyle ?? "CLASSIC"} onChange={(event) => set("captionStyle", event.target.value)}>{options(captionLabel)}</select></label>
      <label>Music<select value={draft.musicMood ?? "NONE"} onChange={(event) => set("musicMood", event.target.value)}>{options(musicLabel)}</select></label>
      <label>Voice<select value={draft.voice ?? ""} onChange={(event) => set("voice", event.target.value || undefined)}><option value="">Default</option>{VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></label>
    </div>
    <label>Voice delivery<input value={draft.voiceStyle ?? ""} maxLength={200} placeholder="excited, fast, like telling a friend" onChange={(event) => set("voiceStyle", event.target.value)} /></label>
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
        <label>Shot<input value={scene.shotType ?? ""} maxLength={60} placeholder="close-up, hands holding it…" onChange={(event) => setScene(index, "shotType", event.target.value)} /></label>
        <label>Starts with<select value={scene.transition ?? "FADE"} onChange={(event) => setScene(index, "transition", event.target.value)}>{options(transitionLabel)}</select></label>
      </div>
      <label>Spoken in this scene<textarea rows={2} value={scene.voiceLine ?? ""} maxLength={300} onChange={(event) => setScene(index, "voiceLine", event.target.value)} /></label>
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
      <div className="plan-chips">
        <span className="plan-style">{styleLabel[plan.style ?? "PHOTO_MOTION"]}</span>
        {plan.format && <span className="plan-chip">{formatLabel[plan.format] ?? plan.format}</span>}
        {plan.hookType && <span className="plan-chip">{hookLabel[plan.hookType] ?? plan.hookType} hook</span>}
        {plan.captionStyle && <span className="plan-chip">{captionLabel[plan.captionStyle]}</span>}
        {plan.musicMood && plan.musicMood !== "NONE" && <span className="plan-chip">♪ {musicLabel[plan.musicMood]}</span>}
        {plan.voice && <span className="plan-chip">Voice: {plan.voice}</span>}
      </div>
    </header>
    {plan.review?.checks && <div className="plan-review">
      <div className="review-checks">{Object.entries(checkLabel).flatMap(([key, label]) => plan.review.checks[key] ? [<span key={key} className={`review-check ${plan.review.checks[key].toLowerCase()}`}>{verdictMark[plan.review.checks[key]] ?? ""} {label}: {verdictLabel[plan.review.checks[key]] ?? plan.review.checks[key]}</span>] : [])}</div>
      {plan.review.changed && plan.review.changed !== "Nothing" && <small><b>Critic changed:</b> {plan.review.changed}</small>}
      {plan.review.watchOut && <small><b>Watch out:</b> {plan.review.watchOut}</small>}
    </div>}
    {video.status === "READY" && video.outputAssetId && <div className="plan-video"><video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} /><a className="button primary" href={`/api/videos/${video.id}/download`}>Download MP4</a></div>}
    {video.status === "PLANNED" && video.outputAssetId && <div className="plan-video"><small className="muted">Video from before your edits (make it again to update):</small><video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} /></div>}
    {video.status === "FAILED" && video.failureMessage && <p className="error small">{video.failureMessage}</p>}
    <dl>
      {plan.angle && <><dt>Angle</dt><dd>{plan.angle}</dd></>}
      <dt>Keeps from the winner</dt><dd>{plan.keepsFromWinner || "—"}</dd>
      <dt>What's new</dt><dd>{plan.changes || "—"}</dd>
      <dt>Hook (first 3s)</dt><dd><b>{plan.hookText}</b></dd>
      <dt>Call to action</dt><dd>{plan.ctaText}</dd>
    </dl>
    <details open><summary>Voiceover and scenes</summary>
      <p className="voiceover">"{plan.voiceover}"</p>
      <ol className="plan-scenes">{plan.scenes.map((scene: any, index: number) => <li key={index}><a href={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} alt="" /></a><div><b>{scene.caption || "No caption"}</b><small>{seconds(scene.durationMs)}{scene.shotType ? ` · ${scene.shotType}` : ""} · {motionLabel[scene.motion] ?? scene.motion}{index > 0 && scene.transition ? ` · ${transitionLabel[scene.transition]}` : ""}{hasAiImage(scene) ? " · AI image" : ""}</small>
          {scene.voiceLine && <small className="voice-line">"{scene.voiceLine}"</small>}
          {scene.imageStatus === "GENERATING" && <small className="muted">Making AI image…</small>}
          {scene.imageStatus === "FAILED" && <small className="error">AI image failed: {scene.imageError}</small>}
          {canMakeImages && scene.imagePrompt && <button type="button" className="link-button" disabled={working} onClick={() => onSceneImages([index])}>{hasAiImage(scene) || scene.imageStatus === "FAILED" ? "Make AI image again" : "Make AI image"}</button>}</div>
        <CopyPrompt label="AI image: this scene" text={scene.imagePrompt} rules={IMAGE_RULES} /><CopyPrompt label="Kling / Seedance video: this scene" text={scene.videoPrompt} rules={VIDEO_RULES} /></li>)}</ol>
    </details>
    {canMakeImages && <button type="button" disabled={working} onClick={() => onSceneImages()}>{aiCount ? `Make all ${plan.scenes.length} AI scene images again` : `Make AI scene images (${plan.scenes.length})`}</button>}
    {busyImages && <p className="muted small">OpenAI is making one image per scene from the product photo chosen for that scene. This takes about 1–2 minutes and refreshes automatically.</p>}
    {editable && <button type="button" onClick={onEdit}>{video.status === "READY" ? "Edit and make again" : "Edit photos and scenes"}</button>}
  </article>;
}

/** Step between the brief and the scripts: the owner reads the director's brief and keeps the angles worth testing. */
function BriefReview({ batch, working, onApprove, onDiscard }: Readonly<{ batch: any; working: boolean; onApprove: (angleIds: string[]) => void; onDiscard: () => void }>) {
  const brief = batch.providerMetadata.brief;
  const [kept, setKept] = useState<string[]>(() => brief.angles.map((angle: any) => angle.id));
  return <div className="brief-review">
    <p className="muted small">Step 1 of 2 · Claude, as your marketing director, wrote this brief. Untick angles you don't want, then Claude writes {batch.requestedCount} scripts from the rest and a critic reviews them.</p>
    {brief.audience && <p><b>Who buys:</b> {brief.audience}</p>}
    {brief.buyerInsights?.length > 0 && <><b>Buyer insights</b><ul>{brief.buyerInsights.map((item: string) => <li key={item}>{item}</li>)}</ul></>}
    <b>Angles to test</b>
    <div className="brief-angles">{brief.angles.map((angle: any) => <label key={angle.id} className={`brief-angle ${kept.includes(angle.id) ? "kept" : ""}`}>
      <input type="checkbox" checked={kept.includes(angle.id)} onChange={() => setKept((current) => current.includes(angle.id) ? current.filter((id) => id !== angle.id) : [...current, angle.id])} />
      <span><b>{angle.name}</b><small>{angle.insight}</small><small className="muted">Why: {angle.whyItCouldWork}</small></span>
    </label>)}</div>
    {brief.hooks?.length > 0 && <details><summary>Hook ideas ({brief.hooks.length})</summary><ul className="brief-hooks">{brief.hooks.map((hook: any, index: number) => <li key={index}><span className="plan-chip">{hookLabel[hook.type] ?? hook.type}</span> {hook.text}</li>)}</ul></details>}
    {brief.directorNotes && <p className="muted"><b>Director's notes:</b> {brief.directorNotes}</p>}
    <div className="winner-actions">
      <button className="primary" disabled={working || !kept.length} onClick={() => onApprove(kept)}>Write {batch.requestedCount} scripts from {kept.length} angle{kept.length === 1 ? "" : "s"}</button>
      <button type="button" disabled={working} onClick={onDiscard}>Discard brief</button>
    </div>
  </div>;
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
      {video.plan.format && <small className="muted">{formatLabel[video.plan.format] ?? video.plan.format}{video.plan.review?.checks?.hook ? ` · hook ${(verdictLabel[video.plan.review.checks.hook] ?? video.plan.review.checks.hook).toLowerCase()}` : ""}</small>}
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
  const busy = batches.some((entry) => entry.batch.status === "WRITING" || entry.batch.status === "WRITING_BRIEF" || entry.videos.some((video: any) => video.status === "QUEUED" || video.status === "RENDERING" || makingImages(video)));
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [busy, load]);
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setWorking(true); setError("");
    try { await action(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : failure); } finally { setWorking(false); }
  };
  const writing = batches.some((entry) => entry.batch.status === "WRITING" || entry.batch.status === "WRITING_BRIEF");
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
      <p className="muted">Claude works like a marketing director: it writes a creative brief (buyers, angles, hooks) for you to approve, then full shot-by-shot scripts in different formats, and a critic reviews and improves each one. You choose which videos to make.</p>
      <div className="make-controls">
        <label>How many<select value={count} onChange={(event) => setCount(Number(event.target.value) as 3 | 6 | 12)}><option value={3}>3 videos</option><option value={6}>6 videos</option><option value={12}>12 videos</option></select></label>
        <label>Length<select value={length} onChange={(event) => setLength(Number(event.target.value) as 15 | 30)}><option value={15}>15 seconds</option><option value={30}>30 seconds</option></select></label>
        <label>Style<select value={style} onChange={(event) => setStyle(event.target.value as "PHOTO_MOTION" | "STOP_MOTION")}><option value="PHOTO_MOTION">Photo motion (smooth zoom and pan)</option><option value="STOP_MOTION">Stop motion (hand-made jumps)</option></select></label>
        <button className="primary" disabled={working || writing} onClick={() => void run(() => api(`/api/creative-references/${referenceId}/video-plans`, "POST", { count, durationSeconds: length, style }), "Could not start writing plans.")}>{writing ? "Claude is working…" : `Start creative brief for ${count} videos`}</button>
      </div>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {batches.map(({ batch, videos }) => {
      const chosen = videos.filter((video: any) => selected.includes(video.id));
      return <div className="plan-batch" key={batch.id}>
        <div className="plan-batch-header"><b>{batch.requestedCount} plans · {batch.targetDurationMs / 1000}s</b><span className="muted small">{new Date(batch.createdAt).toLocaleString()}</span></div>
        {batch.status === "WRITING_BRIEF" && <p className="muted">Claude is studying the winner and writing the creative brief. This takes about 1–2 minutes and refreshes automatically.</p>}
        {batch.status === "BRIEF_READY" && <BriefReview batch={batch} working={working} onApprove={(angleIds) => void run(() => api(`/api/video-batches/${batch.id}/approve-brief`, "POST", { angleIds }), "Could not start the scripts.")} onDiscard={() => void run(() => api(`/api/video-batches/${batch.id}/discard-brief`, "POST", {}), "Could not discard the brief.")} />}
        {batch.status === "WRITING" && <p className="muted">Step 2 of 2 · Claude is writing {batch.requestedCount} shot-by-shot scripts, then a critic checks each one (hook, story, shots, call to action, claims) and fixes weak parts. This takes about 3–5 minutes and refreshes automatically.</p>}
        {batch.status === "FAILED" && (batch.failureMessage === "Discarded by the owner." ? <p className="muted small">Brief discarded.</p> : <p className="error">Writing these plans failed: {batch.failureMessage ?? "unknown error"}. Start a new set to try again.</p>)}
        {batch.status === "READY" && <>
          <div className="plan-tiles">{videos.map((video: any) => <PlanTile key={video.id} video={video} open={open === video.id} selected={selected.includes(video.id)} onOpen={() => { setOpen(video.id); setEditing(""); }} onToggle={() => toggle(video.id)} />)}</div>
          <div className="winner-actions"><button className="primary" disabled={working || !chosen.length} onClick={() => void run(async () => { await api(`/api/video-batches/${batch.id}/make`, "POST", { videoIds: chosen.map((video: any) => video.id) }); setSelected((current) => current.filter((id) => !chosen.some((video: any) => video.id === id))); }, "Could not start making videos.")}>Make {chosen.length || ""} selected video{chosen.length === 1 ? "" : "s"}</button><span className="muted small">Each video takes about 1–2 minutes to make, one after another.</span></div>
        </>}
      </div>;
    })}
    {detail && (panel ? createPortal(detail, panel) : detail)}
  </section>;
}
