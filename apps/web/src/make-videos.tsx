import { useCallback, useEffect, useRef, useState } from "react";
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
// Words that can appear in a plan: shown on screen or spoken. Find and replace works on all of them.
const PLAN_TEXT = ["title", "hookText", "voiceover", "ctaText"] as const;
const SCENE_TEXT = ["caption", "voiceLine"] as const;
const finder = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
const countIn = (plan: any, text: string) => !text ? 0 : [...PLAN_TEXT.map((field) => plan[field]), ...plan.scenes.flatMap((scene: any) => SCENE_TEXT.map((field) => scene[field]))]
  .reduce((sum: number, value: unknown) => sum + (typeof value === "string" ? value.match(finder(text))?.length ?? 0 : 0), 0);
const replaceIn = (plan: any, text: string, replacement: string) => {
  const swap = (value: unknown) => typeof value === "string" ? value.replace(finder(text), () => replacement) : value;
  return { ...plan, ...Object.fromEntries(PLAN_TEXT.map((field) => [field, swap(plan[field])])), scenes: plan.scenes.map((scene: any) => ({ ...scene, ...Object.fromEntries(SCENE_TEXT.filter((field) => typeof scene[field] === "string").map((field) => [field, swap(scene[field])])) })) };
};

/** Shows only the scene's own description; Copy gives the full prompt with the product rules in front. */
function CopyPrompt({ label, text, rules }: Readonly<{ label: string; text?: string; rules: string }>) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return <div className="scene-prompt"><div><b>{label}</b><button type="button" title="Copies the full prompt including the product rules" onClick={() => void navigator.clipboard.writeText(`${rules}\n\nScene: ${text}`).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copied" : "Copy"}</button></div><p>{text}</p></div>;
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Sends a file to a signed storage URL with upload progress. */
function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [header, value] of Object.entries(headers)) request.setRequestHeader(header, value);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100))); };
    request.onerror = () => reject(new Error("Upload failed. Check the connection and try again."));
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Upload failed with HTTP ${request.status}.`)));
    request.send(file);
  });
}

/**
 * Uploads a scene clip straight to storage (much faster than through the app's Cloudflare route), then lets the server
 * check it. Falls back to posting it through the app when direct upload is not set up (local development).
 */
async function uploadClipFile(videoId: string, file: File, onProgress: (percent: number) => void): Promise<{ assetId: string; durationMs: number }> {
  const type = file.type || (file.name.toLowerCase().endsWith(".mov") ? "video/quicktime" : file.name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4");
  let target: any;
  try {
    target = await api(`/api/videos/${videoId}/scene-clips/upload`, "POST", { filename: file.name, mimeType: type, byteSize: file.size, sha256: await sha256Hex(file) });
  } catch (reason) {
    if (!(reason instanceof Error) || !reason.message.includes("Direct durable upload is not enabled")) throw reason;
    const form = new FormData();
    form.append("file", file);
    return postWithProgress(`/api/videos/${videoId}/scene-clips`, form, onProgress);
  }
  try { await putWithProgress(target.url, target.headers, file, onProgress); }
  catch {
    // Storage refused the browser (network or CORS): send it through the app instead, slower but it works.
    const form = new FormData();
    form.append("file", file);
    return postWithProgress(`/api/videos/${videoId}/scene-clips`, form, onProgress);
  }
  onProgress(100);
  return api(`/api/videos/${videoId}/scene-clips/complete`, "POST", { assetId: target.assetId });
}

/** Posts a form with upload progress (fetch cannot report it); resolves with the JSON answer. */
function postWithProgress(url: string, form: FormData, onProgress: (percent: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("x-koolezt-actor", "web-user");
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    request.onerror = () => reject(new Error("Upload failed. Check the connection and try again."));
    request.onload = () => {
      let json: any = {};
      try { json = JSON.parse(request.responseText); } catch { /* not JSON */ }
      if (request.status >= 200 && request.status < 300) resolve(json); else reject(new Error(json.message ?? "Upload failed."));
    };
    request.send(form);
  });
}

/** Word count against the video length: about 2 words a second fit; a bit more is sped up slightly, more than that makes the video longer. */
function VoiceLength({ text, targetMs }: Readonly<{ text: string; targetMs: number }>) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.round(targetMs / 1000);
  const fits = seconds * 2;
  const tone = words <= fits ? "muted" : words <= Math.round(fits * 1.2) ? "warning" : "error";
  return <small className={`voice-length ${tone}`}>{words} words · {seconds}s video fits about {fits}.{words > fits && (words <= Math.round(fits * 1.2) ? " The voice will be sped up slightly to fit." : ` Too long: the video will run about ${Math.round((words / 2.3 / 1.2) + 1)}s. Shorten it to keep ${seconds}s.`)}</small>;
}

/** Lets the owner change a plan before making it: photo, caption, length and motion of each scene, scene order, and the words. */
function PlanEditor({ video, photos, targetMs, onSaved, onCancel }: Readonly<{ video: any; photos: readonly any[]; targetMs: number; onSaved: () => Promise<void>; onCancel: () => void }>) {
  const [draft, setDraft] = useState<any>(() => structuredClone(video.plan));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Clip uploads run in the background, two at a time, while the owner keeps editing: scene index -> percent.
  const [uploads, setUploads] = useState<Record<number, number>>({});
  const pending = useRef<Promise<void>[]>([]);
  const slots = useRef(0);
  const waiting = useRef<(() => void)[]>([]);
  const latest = useRef<any>(draft);
  latest.current = draft;
  const uploadCount = Object.keys(uploads).length;
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const found = countIn(draft, find.trim());
  const set = (field: string, value: unknown) => setDraft((current: any) => ({ ...current, [field]: value }));
  const patchScene = (index: number, patch: Record<string, unknown>) => setDraft((current: any) => ({ ...current, scenes: current.scenes.map((scene: any, at: number) => at === index ? { ...scene, ...patch } : scene) }));
  // Each clip is stored right away and attached to its scene in the draft; Save plan waits for uploads still running.
  const uploadClip = (index: number, file: File) => {
    setUploads((current) => ({ ...current, [index]: 0 })); setError("");
    const task = (async () => {
      if (slots.current >= 2) await new Promise<void>((resolve) => waiting.current.push(resolve));
      slots.current++;
      try {
        const json = await uploadClipFile(video.id, file, (percent) => setUploads((current) => ({ ...current, [index]: percent })));
        patchScene(index, { sceneVideoAssetId: json.assetId, videoDurationMs: json.durationMs, videoStartMs: 0 });
      } catch (reason) { setError(`Scene ${index + 1}: ${reason instanceof Error ? reason.message : "Upload failed."}`); }
      finally {
        slots.current--;
        waiting.current.shift()?.();
        setUploads((current) => { const { [index]: _done, ...rest } = current; void _done; return rest; });
      }
    })();
    pending.current = [...pending.current, task];
  };
  // Several clips at once: sorted by file name and given to the scenes that have no clip yet, in order.
  const uploadMany = (files: readonly File[]) => {
    const free = draft.scenes.flatMap((scene: any, index: number) => !scene.sceneVideoAssetId && uploads[index] === undefined ? [index] : []);
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    sorted.slice(0, free.length).forEach((file, at) => uploadClip(free[at]!, file));
    if (sorted.length > free.length) setError(`${sorted.length - free.length} clip${sorted.length - free.length === 1 ? " was" : "s were"} not used: only ${free.length} scene${free.length === 1 ? " has" : "s have"} no clip yet.`);
  };
  const setScene = (index: number, field: string, value: unknown) => set("scenes", draft.scenes.map((scene: any, at: number) => at === index ? { ...scene, [field]: value } : scene));
  const move = (index: number, step: number) => {
    const scenes = [...draft.scenes];
    const [scene] = scenes.splice(index, 1);
    scenes.splice(index + step, 0, scene);
    set("scenes", scenes);
  };
  const save = async () => {
    setSaving(true); setError("");
    try {
      await Promise.allSettled(pending.current);
      await api(`/api/videos/${video.id}/plan`, "PUT", latest.current); await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the plan."); } finally { setSaving(false); }
  };
  return <article className="plan-card plan-editor">
    <div className="find-replace">
      <b>Find and replace</b><small className="muted">Changes the words everywhere in this plan: hook, voiceover, on-screen text of every scene and call to action.</small>
      <div className="scene-row">
        <label>Find<input value={find} placeholder="up to 6 dogs" onChange={(event) => setFind(event.target.value)} /></label>
        <label>Replace with<input value={replacement} placeholder="up to 4 dogs" onChange={(event) => setReplacement(event.target.value)} /></label>
      </div>
      <div className="scene-row"><button type="button" disabled={!found} onClick={() => setDraft((current: any) => replaceIn(current, find.trim(), replacement))}>{find.trim() ? `Replace ${found} match${found === 1 ? "" : "es"}` : "Replace"}</button>{find.trim() && !found && <small className="muted">Not found in this plan.</small>}</div>
    </div>
    <label>Title<input value={draft.title} maxLength={120} onChange={(event) => set("title", event.target.value)} /></label>
    <label>Hook (first 3s, on screen)<input value={draft.hookText} maxLength={60} onChange={(event) => set("hookText", event.target.value)} /></label>
    <label>Voiceover<textarea rows={4} value={draft.voiceover} maxLength={900} onChange={(event) => set("voiceover", event.target.value)} />
      <VoiceLength text={draft.voiceover} targetMs={targetMs} /></label>
    <label>Call to action (last scene)<input value={draft.ctaText} maxLength={40} onChange={(event) => set("ctaText", event.target.value)} /></label>
    <div className="scene-row">
      <label>Style<select value={draft.style ?? "PHOTO_MOTION"} onChange={(event) => set("style", event.target.value)}>{options(styleLabel)}</select></label>
      <label>Captions<select value={draft.captionStyle ?? "CLASSIC"} onChange={(event) => set("captionStyle", event.target.value)}>{options(captionLabel)}</select></label>
      <label>Music<select value={draft.musicMood ?? "NONE"} onChange={(event) => set("musicMood", event.target.value)}>{options(musicLabel)}</select></label>
      <label>Voice<select value={draft.voice ?? ""} onChange={(event) => set("voice", event.target.value || undefined)}><option value="">Default</option>{VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></label>
    </div>
    <label>Voice delivery<input value={draft.voiceStyle ?? ""} maxLength={200} placeholder="excited, fast, like telling a friend" onChange={(event) => set("voiceStyle", event.target.value)} /></label>
    <b>Scenes</b>
    <label className="upload-label upload-many">Upload several Kling clips at once (they go to the scenes without a clip, in file-name order; keep editing while they upload)
      <input type="file" multiple accept="video/mp4,video/quicktime,video/webm" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) uploadMany(files); }} /></label>
    {uploadCount > 0 && <p className="muted small">Uploading {uploadCount} clip{uploadCount === 1 ? "" : "s"} in the background…</p>}
    <ol className="scene-editor">{draft.scenes.map((scene: any, index: number) => <li key={index}>
      <b className="scene-number">Scene {index + 1} · {seconds(scene.durationMs)}{scene.caption ? ` · "${scene.caption}"` : ""}</b>
      {scene.sceneImageAssetId
        ? <div className="scene-ai-image"><img src={`/api/assets/${scene.sceneImageAssetId}`} alt="AI scene" /><div><b>AI scene image</b><button type="button" onClick={() => setDraft((current: any) => ({ ...current, scenes: current.scenes.map((item: any, at: number) => at === index ? { ...item, sceneImageAssetId: undefined, imageStatus: undefined, imageError: undefined } : item) }))}>Use product photo instead</button></div></div>
        : <div className="scene-photos">{photos.map((photo: any) => <button type="button" key={photo.id} className={photo.id === scene.photoAssetId ? "chosen" : ""} title={photo.label} onClick={() => setScene(index, "photoAssetId", photo.id)}><img src={`/api/assets/${photo.id}`} alt={photo.label} /></button>)}</div>}
      <div className="scene-clip">{scene.sceneVideoAssetId
        ? <><video src={`/api/assets/${scene.sceneVideoAssetId}#t=${(scene.videoStartMs ?? 0) / 1000}`} muted playsInline controls preload="metadata" />
          <div>
            <b>Scene video</b>
            <label>Start at (seconds)<input type="number" min={0} step={0.1} max={Math.max(0, ((scene.videoDurationMs ?? 5000) - scene.durationMs) / 1000)} value={(scene.videoStartMs ?? 0) / 1000} onChange={(event) => setScene(index, "videoStartMs", Math.round(Math.max(0, Number(event.target.value) || 0) * 1000))} /></label>
            <small className="muted">Uses {seconds(scene.durationMs)} of this {seconds(scene.videoDurationMs ?? 0)} clip, from {seconds(scene.videoStartMs ?? 0)}.{(scene.videoStartMs ?? 0) + scene.durationMs > (scene.videoDurationMs ?? Infinity) ? " The clip ends early; its last frame is held." : ""}</small>
            <button type="button" onClick={() => patchScene(index, { sceneVideoAssetId: undefined, videoStartMs: undefined, videoDurationMs: undefined })}>Remove video</button>
          </div></>
        : uploads[index] !== undefined
          ? <p className="upload-label">{uploads[index]! === 0 ? "Waiting to upload…" : uploads[index]! < 100 ? `Uploading… ${uploads[index]}%` : "Saving…"}</p>
          : <label className="upload-label">Scene video from Kling (MP4, replaces the image)<input type="file" accept="video/mp4,video/quicktime,video/webm" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadClip(index, file); }} /></label>}
      </div>
      <label>On-screen text (caption)<input value={scene.caption} maxLength={80} onChange={(event) => setScene(index, "caption", event.target.value)} /></label>
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
        <button type="button" disabled={index === 0 || uploadCount > 0} onClick={() => move(index, -1)}>↑ Up</button>
        <button type="button" disabled={index === draft.scenes.length - 1 || uploadCount > 0} onClick={() => move(index, 1)}>↓ Down</button>
        <button type="button" className="danger" disabled={draft.scenes.length <= 2 || uploadCount > 0} onClick={() => set("scenes", draft.scenes.filter((_: any, at: number) => at !== index))}>Remove</button>
      </div>
    </li>)}</ol>
    <button type="button" disabled={draft.scenes.length >= 8 || uploadCount > 0} onClick={() => set("scenes", [...draft.scenes, { ...draft.scenes.at(-1), caption: "" }])}>+ Add scene</button>
    <p className="muted small">Scene videos are uploaded right away and used once you click Save plan (it waits for uploads still running). Seconds set how long each scene lasts compared with the others; the video is stretched to fit the voiceover.</p>
    {error && <p className="error small" role="alert">{error}</p>}
    <div className="scene-row"><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? (uploadCount ? `Saving after ${uploadCount} upload${uploadCount === 1 ? "" : "s"}…` : "Saving…") : "Save plan"}</button><button type="button" disabled={saving} onClick={() => { if (!uploadCount || window.confirm("Clips are still uploading. Leave without saving them to this plan?")) onCancel(); }}>Cancel</button></div>
  </article>;
}

const ctaLabel: Record<string, string> = { SHOP_NOW: "Shop now", ORDER_NOW: "Order now", LEARN_MORE: "Learn more", GET_OFFER: "Get offer", BUY_NOW: "Buy now", SEE_MORE: "See more", CUSTOMIZE: "Customize" };

function CopyText({ text }: Readonly<{ text: string }>) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="copy-small" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copied" : "Copy"}</button>;
}

/** Meta ad copy for the plan: Claude writes it, the owner copies or edits it. It never changes the video itself. */
function AdCopy({ video, working, onWrite, onSave }: Readonly<{ video: any; working: boolean; onWrite: () => void; onSave: (copy: unknown) => void }>) {
  const copy = video.plan.adCopy;
  const [draft, setDraft] = useState<any>();
  if (draft) {
    const set = (field: string, value: unknown) => setDraft((current: any) => ({ ...current, [field]: value }));
    const setItem = (field: "primaryTexts" | "headlines", index: number, value: string) => set(field, draft[field].map((item: string, at: number) => at === index ? value : item));
    return <section className="ad-copy">
      <h4>Meta ad copy</h4>
      {draft.primaryTexts.map((item: string, index: number) => <label key={`p${index}`}>Primary text {index + 1}<textarea rows={4} value={item} onChange={(event) => setItem("primaryTexts", index, event.target.value)} /></label>)}
      {draft.headlines.map((item: string, index: number) => <label key={`h${index}`}>Headline {index + 1} <small className="muted">({item.length}/40)</small><input value={item} maxLength={40} onChange={(event) => setItem("headlines", index, event.target.value)} /></label>)}
      <div className="scene-row">
        <label>Description <small className="muted">({draft.description.length}/30)</small><input value={draft.description} maxLength={30} onChange={(event) => set("description", event.target.value)} /></label>
        <label>Button<select value={draft.callToAction} onChange={(event) => set("callToAction", event.target.value)}>{options(ctaLabel)}</select></label>
      </div>
      <div className="scene-row"><button className="primary" disabled={working} onClick={() => { onSave(draft); setDraft(undefined); }}>Save copy</button><button type="button" onClick={() => setDraft(undefined)}>Cancel</button></div>
    </section>;
  }
  return <section className="ad-copy">
    <div className="ad-copy-header"><h4>Meta ad copy</h4><div className="scene-row">
      {copy && <button type="button" disabled={working} onClick={() => setDraft(structuredClone(copy))}>Edit</button>}
      <button type="button" disabled={working} onClick={onWrite}>{working ? "Writing…" : copy ? "Write again" : "Write Meta ad copy"}</button>
    </div></div>
    {!copy ? <p className="muted small">Claude writes 3 primary texts, 3 headlines, a description and the button for this video, matching its angle and hook. Takes about 20–40 seconds.</p> : <>
      <b className="small">Primary text</b>
      {copy.primaryTexts.map((item: string, index: number) => <div key={`p${index}`} className="ad-copy-item"><p>{item}</p><CopyText text={item} /></div>)}
      <b className="small">Headlines</b>
      {copy.headlines.map((item: string, index: number) => <div key={`h${index}`} className="ad-copy-item"><p><b>{item}</b></p><CopyText text={item} /></div>)}
      {copy.description && <><b className="small">Description</b><div className="ad-copy-item"><p>{copy.description}</p><CopyText text={copy.description} /></div></>}
      <p className="small"><b>Button:</b> {ctaLabel[copy.callToAction] ?? copy.callToAction}</p>
    </>}
  </section>;
}

function PlanCard({ video, selected, working, onToggle, onEdit, onSceneImages, onWriteAdCopy, onSaveAdCopy }: Readonly<{ video: any; selected: boolean; working: boolean; onToggle: () => void; onEdit: () => void; onWriteAdCopy: () => void; onSaveAdCopy: (copy: unknown) => void; onSceneImages: (scenes?: number[]) => void }>) {
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
      <dt>Builds on</dt><dd>{plan.keepsFromWinner || "—"}</dd>
      <dt>What's new</dt><dd>{plan.changes || "—"}</dd>
      <dt>Hook (first 3s)</dt><dd><b>{plan.hookText}</b></dd>
      <dt>Call to action</dt><dd>{plan.ctaText}</dd>
    </dl>
    <details open><summary>Voiceover and scenes</summary>
      <p className="voiceover">"{plan.voiceover}"</p>
      <ol className="plan-scenes">{plan.scenes.map((scene: any, index: number) => <li key={index}><a href={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${hasAiImage(scene) ? scene.sceneImageAssetId : scene.photoAssetId}`} alt="" /></a><div><b>{scene.caption || "No caption"}</b><small>{seconds(scene.durationMs)}{scene.shotType ? ` · ${scene.shotType}` : ""} · {motionLabel[scene.motion] ?? scene.motion}{index > 0 && scene.transition ? ` · ${transitionLabel[scene.transition]}` : ""}{scene.sceneVideoAssetId ? " · Kling video" : hasAiImage(scene) ? " · AI image" : ""}</small>
          {scene.voiceLine && <small className="voice-line">"{scene.voiceLine}"</small>}
          {scene.imageStatus === "GENERATING" && <small className="muted">Making AI image…</small>}
          {scene.imageStatus === "FAILED" && <small className="error">AI image failed: {scene.imageError}</small>}
          {canMakeImages && scene.imagePrompt && <button type="button" className="link-button" disabled={working} onClick={() => onSceneImages([index])}>{hasAiImage(scene) || scene.imageStatus === "FAILED" ? "Make AI image again" : "Make AI image"}</button>}</div>
        <CopyPrompt label="AI image: this scene" text={scene.imagePrompt} rules={IMAGE_RULES} /><CopyPrompt label="Kling / Seedance video: this scene" text={scene.videoPrompt} rules={VIDEO_RULES} /></li>)}</ol>
    </details>
    {canMakeImages && <button type="button" disabled={working} onClick={() => onSceneImages()}>{aiCount ? `Make all ${plan.scenes.length} AI scene images again` : `Make AI scene images (${plan.scenes.length})`}</button>}
    {busyImages && <p className="muted small">OpenAI is making one image per scene from the product photo chosen for that scene. This takes about 1–2 minutes and refreshes automatically.</p>}
    {editable && <button type="button" onClick={onEdit}>{video.status === "READY" ? "Edit and make again" : "Edit photos and scenes"}</button>}
    <AdCopy key={video.id} video={video} working={working} onWrite={onWriteAdCopy} onSave={onSaveAdCopy} />
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

/**
 * Writes new video plans, then makes the chosen ones on the server. With referenceId the plans follow that winner's style,
 * for the winner's own product (winnerProductId) or another product picked here; with productId alone they come from the product only.
 */
export function MakeVideos({ referenceId, winnerProductId, productId, reportReady }: Readonly<{ referenceId?: string; winnerProductId?: string; productId?: string; reportReady: boolean }>) {
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
  const [target, setTarget] = useState(winnerProductId ?? "");
  const load = useCallback(async () => setBatches(await api(`/api/video-batches?${referenceId ? `referenceId=${encodeURIComponent(referenceId)}` : `productId=${encodeURIComponent(productId ?? "")}`}`)), [referenceId, productId]);
  const productName = (id: string) => products.find((product: any) => product.id === id)?.name ?? "another product";
  const start = () => referenceId
    ? api(`/api/creative-references/${referenceId}/video-plans`, "POST", { count, durationSeconds: length, style, ...(target ? { productId: target } : {}) })
    : api(`/api/products/${productId}/video-plans`, "POST", { count, durationSeconds: length, style });
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
    <div className="plan-panel-header"><span className="muted small">Plan {openEntry.video.ordinal} · {openEntry.batch.targetDurationMs / 1000}s</span><div className="scene-row">
      <button type="button" className="danger" disabled={working} onClick={() => { if (window.confirm(`Delete plan "${openEntry.video.plan.title}" with its made video, AI images and clips? This cannot be undone.`)) void run(async () => { await api(`/api/videos/${openEntry.video.id}`, "DELETE"); setOpen(""); setEditing(""); }, "Could not delete this plan."); }}>Delete plan</button>
      <button type="button" onClick={() => { setOpen(""); setEditing(""); }}>Close</button>
    </div></div>
    {editing === openEntry.video.id
      ? <PlanEditor key={openEntry.video.id} video={openEntry.video} photos={photosOf(openEntry.batch.productId)} targetMs={openEntry.batch.targetDurationMs} onCancel={() => setEditing("")} onSaved={async () => { setEditing(""); await load(); }} />
      : <PlanCard key={openEntry.video.id} video={openEntry.video} working={working} selected={selected.includes(openEntry.video.id)} onEdit={() => setEditing(openEntry.video.id)} onWriteAdCopy={() => void run(() => api(`/api/videos/${openEntry.video.id}/ad-copy`, "POST", {}), "Could not write the ad copy.")} onSaveAdCopy={(copy) => void run(() => api(`/api/videos/${openEntry.video.id}/ad-copy`, "PUT", copy), "Could not save the ad copy.")} onSceneImages={(scenes) => void run(() => api(`/api/videos/${openEntry.video.id}/scene-images`, "POST", scenes ? { scenes } : {}), "Could not start the AI scene images.")} onToggle={() => toggle(openEntry.video.id)} />}
  </div>;

  return <section className="card make-videos">
    <h3>{referenceId ? "Make new videos from this winner" : "Make videos for this product"}</h3>
    {!reportReady ? <p className="muted">{referenceId ? "Available once the analysis report is ready." : "Add at least one product photo first."}</p> : <>
      <p className="muted">Claude works like a marketing director: it writes a creative brief (buyers, angles, hooks) for you to approve, then full shot-by-shot scripts in different formats, and a critic reviews and improves each one. You choose which videos to make.{referenceId ? "" : " There is no winner here, so the ideas come from the product's description, facts and photos. If a similar product has a winning ad, open that winner and choose this product there to borrow its style."}</p>
      <div className="make-controls">
        {referenceId && <label>Make videos for<select value={target} onChange={(event) => setTarget(event.target.value)}>{!winnerProductId && <option value="">Choose a product…</option>}{products.map((product: any) => <option key={product.id} value={product.id}>{product.name}{product.id === winnerProductId ? " (this winner's product)" : ""}</option>)}</select></label>}
        <label>How many<select value={count} onChange={(event) => setCount(Number(event.target.value) as 3 | 6 | 12)}><option value={3}>3 videos</option><option value={6}>6 videos</option><option value={12}>12 videos</option></select></label>
        <label>Length<select value={length} onChange={(event) => setLength(Number(event.target.value) as 15 | 30)}><option value={15}>15 seconds</option><option value={30}>30 seconds</option></select></label>
        <label>Style<select value={style} onChange={(event) => setStyle(event.target.value as "PHOTO_MOTION" | "STOP_MOTION")}><option value="PHOTO_MOTION">Photo motion (smooth zoom and pan)</option><option value="STOP_MOTION">Stop motion (hand-made jumps)</option></select></label>
        <button className="primary" disabled={working || writing || Boolean(referenceId && !target)} onClick={() => void run(start, "Could not start writing plans.")}>{writing ? "Claude is working…" : `Start creative brief for ${count} videos`}</button>
      </div>
      {referenceId && target && target !== winnerProductId && <p className="muted small">Claude borrows only this winner's style (hook, pacing, shots, voice, call to action). Words, facts and photos come from {productName(target)}.</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {batches.map(({ batch, videos }) => {
      const chosen = videos.filter((video: any) => selected.includes(video.id));
      return <div className="plan-batch" key={batch.id}>
        <div className="plan-batch-header"><b>{batch.requestedCount} plans · {batch.targetDurationMs / 1000}s{referenceId && batch.productId !== winnerProductId ? ` · for ${productName(batch.productId)}` : ""}</b><span className="muted small">{new Date(batch.createdAt).toLocaleString()} <button type="button" className="danger compact" disabled={working || batch.status === "WRITING" || batch.status === "WRITING_BRIEF"} onClick={() => { if (window.confirm(`Delete this set of ${videos.length || batch.requestedCount} plans, with their made videos, AI images and clips? This cannot be undone.`)) void run(async () => { await api(`/api/video-batches/${batch.id}`, "DELETE"); if (videos.some((video: any) => video.id === open)) setOpen(""); }, "Could not delete this set."); }}>Delete set</button></span></div>
        {batch.status === "WRITING_BRIEF" && <p className="muted">Claude is studying {referenceId ? "the winner" : "the product"} and writing the creative brief. This takes about 1–2 minutes and refreshes automatically.</p>}
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
