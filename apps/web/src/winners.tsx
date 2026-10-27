import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";
import "./winners.css";

type Props = Readonly<{
  sidebar: ReactNode;
  products: readonly any[];
  projects: readonly any[];
  isOwner: boolean;
  onUseInCampaign: (campaign: any, dnaRevisionId: string) => void;
}>;

const emptyUpload = { metaAccountId: "", metaAdId: "", productId: "", displayName: "", platform: "Meta / Facebook", dateStart: "", dateEnd: "", spend: "", purchases: "", revenue: "", linkCtr: "", cpc: "", cpm: "", currency: "USD", operatorNotes: "", operatorTranscript: "" };
const performanceFields = [["spend", "Spend"], ["purchases", "Purchases"], ["revenue", "Revenue"], ["linkCtr", "Link CTR %"], ["cpc", "CPC"], ["cpm", "CPM"]] as const;

const ACRONYMS = new Set(["cta", "ugc", "ai"]);
const humanize = (value: string) => value.toLowerCase().split("_").map((word, index) => (ACRONYMS.has(word) ? word.toUpperCase() : index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(" ");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const money = (value: number, currency?: string) => `${currency && currency !== "USD" ? `${currency} ` : "$"}${value.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;

function statusOf(entry: any): Readonly<{ label: string; tone: "working" | "ready" | "failed" | "idle" }> {
  const report = entry.winnerReport;
  if (entry.reference.analysisStatus === "ANALYZING" || report?.status === "PENDING") return { label: "Analyzing", tone: "working" };
  if (report?.status === "READY") return { label: entry.reference.analysisStatus === "APPROVED" ? "Report ready · Approved for new ideas" : "Report ready", tone: "ready" };
  if (report?.status === "FAILED" || ["FAILED", "SUBMISSION_UNKNOWN", "RESULT_UNAVAILABLE"].includes(entry.reference.analysisStatus)) return { label: "Needs attention", tone: "failed" };
  return { label: entry.reference.analysisStatus === "NOT_ANALYZED" ? "Not analyzed" : "No report yet", tone: "idle" };
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = 30 * 60 * 1000;
    for (const [header, value] of Object.entries(headers)) request.setRequestHeader(header, value);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100))); };
    request.onerror = () => reject(new Error("Video upload failed. Check the connection and try again."));
    request.ontimeout = () => reject(new Error("Video upload timed out. Please try again."));
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Video upload failed with HTTP ${request.status}.`)));
    request.send(file);
  });
}

/** Beats, voice, and cuts on one shared time axis. Beat identity is carried by labels, not color. */
function TimelineStrip({ report, measurements, durationMs, onSeek }: Readonly<{ report: any; measurements: any; durationMs: number; onSeek: (ms: number) => void }>) {
  const [hover, setHover] = useState<Readonly<{ x: number; text: string }> | undefined>();
  const position = (ms: number) => `${Math.min(100, Math.max(0, (ms / durationMs) * 100))}%`;
  const width = (startMs: number, endMs: number) => `${Math.max(0.6, ((endMs - startMs) / durationMs) * 100)}%`;
  const show = (event: React.MouseEvent<HTMLElement>, text: string) => {
    const box = event.currentTarget.closest(".timeline-strip")!.getBoundingClientRect();
    setHover({ x: event.clientX - box.left, text });
  };
  const segments = measurements?.transcriptSegments ?? [];
  return <div className="timeline-strip" onMouseLeave={() => setHover(undefined)}>
    <div className="timeline-legend" aria-hidden="true"><span><i className="legend-beat" />Beat</span>{segments.length > 0 && <span><i className="legend-voice" />Voice speaking</span>}<span><i className="legend-cut" />Scene cut</span></div>
    <div className="timeline-row" aria-label="Beats">
      {report.timeline.map((beat: any, index: number) => <button type="button" key={index} className="timeline-beat" style={{ left: position(beat.startMs), width: width(beat.startMs, beat.endMs) }} onClick={() => onSeek(beat.startMs)} onMouseMove={(event) => show(event, `${seconds(beat.startMs)}–${seconds(beat.endMs)} · ${humanize(beat.beat)}${beat.purpose ? ` · ${beat.purpose}` : ""}`)} aria-label={`${humanize(beat.beat)} from ${seconds(beat.startMs)}`}><span>{humanize(beat.beat)}</span></button>)}
      {(measurements?.sceneCutsMs ?? []).map((cut: number) => <i key={cut} className="timeline-cut" style={{ left: position(cut) }} onMouseMove={(event) => show(event, `Scene cut at ${seconds(cut)}`)} />)}
    </div>
    {segments.length > 0 && <div className="timeline-row timeline-voice" aria-label="Voice">
      {segments.map((segment: any, index: number) => <button type="button" key={index} className="timeline-speech" style={{ left: position(segment.startMs), width: width(segment.startMs, segment.endMs) }} onClick={() => onSeek(segment.startMs)} onMouseMove={(event) => show(event, `${seconds(segment.startMs)} · "${segment.text}"`)} aria-label={`Voice at ${seconds(segment.startMs)}: ${segment.text}`} />)}
    </div>}
    <div className="timeline-axis" aria-hidden="true"><span>0s</span><span>{seconds(durationMs / 2)}</span><span>{seconds(durationMs)}</span></div>
    {hover && <div className="timeline-tooltip" role="status" style={{ left: hover.x }}>{hover.text}</div>}
  </div>;
}

function Stat({ label, value, note }: Readonly<{ label: string; value: string | undefined; note?: string | undefined }>) {
  return value === undefined ? null : <div className="stat-tile"><span>{label}</span><b>{value}</b>{note && <small>{note}</small>}</div>;
}

function MetaResults({ link, reportUpdatedAt, working, onRefresh }: Readonly<{ link: any; reportUpdatedAt?: string; working: boolean; onRefresh: () => void }>) {
  const m = link.metrics ?? {};
  const currency = link.currency;
  const stale = reportUpdatedAt && link.syncedAt && link.syncedAt > reportUpdatedAt;
  return <section className="card meta-results">
    <div className="meta-results-header"><h3>Results from Meta <small className="muted">lifetime{link.dateStart ? ` · ${link.dateStart} to ${link.dateEnd}` : ""}</small></h3>
      <div className="winner-actions"><span className="muted small">{link.syncedAt ? `Synced ${new Date(link.syncedAt).toLocaleString()}` : "Not synced yet"}</span><button disabled={working} onClick={onRefresh}>Refresh from Meta</button></div></div>
    {link.syncError && <p className="error small">Last refresh failed: {link.syncError}</p>}
    <div className="stat-grid">
      <Stat label="Spend" value={m.spend !== undefined ? money(m.spend, currency) : undefined} />
      <Stat label="Purchases" value={m.purchases !== undefined ? String(m.purchases) : undefined} />
      <Stat label="Revenue" value={m.purchaseValue !== undefined ? money(m.purchaseValue, currency) : undefined} />
      <Stat label="ROAS" value={m.roas !== undefined ? `${m.roas.toFixed(2)}x` : undefined} />
      <Stat label="CPA" value={m.cpa !== undefined ? money(m.cpa, currency) : undefined} />
      <Stat label="Hook rate" value={m.hookRate !== undefined ? percent(m.hookRate) : undefined} note="3-second views ÷ impressions" />
      <Stat label="Hold rate" value={m.holdRate !== undefined ? percent(m.holdRate) : undefined} note="ThruPlays ÷ 3-second views" />
      <Stat label="Link CTR" value={m.linkCtr !== undefined ? `${(m.linkCtr * 100).toFixed(2)}%` : undefined} />
      <Stat label="CPM" value={m.cpm !== undefined ? money(m.cpm, currency) : undefined} />
      <Stat label="Impressions" value={m.impressions !== undefined ? m.impressions.toLocaleString() : undefined} />
    </div>
    {stale && <p className="muted small">These numbers changed after the report was written. Regenerate the report to re-interpret them.</p>}
    <p className="muted small">Ad: {link.adName} · ID {link.adId}</p>
  </section>;
}

function WinnerReportView({ entry, campaigns, working, onRegenerate, onAnalyze, onApprove, onSaveDna, onUseInCampaign, onRefreshMeta, onDelete }: Readonly<{
  entry: any; campaigns: readonly any[]; working: boolean;
  onRegenerate: () => void; onAnalyze: () => void; onApprove: (revisionId: string) => void; onSaveDna: (text: string) => void; onUseInCampaign: (campaign: any, revisionId: string) => void; onRefreshMeta: () => void; onDelete?: () => void;
}>) {
  const video = useRef<HTMLVideoElement>(null);
  const [dnaText, setDnaText] = useState<string | undefined>();
  const [campaignId, setCampaignId] = useState("");
  const reference = entry.reference;
  const record = entry.winnerReport;
  const report = record?.report;
  const m = record?.measurements;
  const latest = entry.revisions.at(-1);
  const approved = entry.revisions.find((revision: any) => revision.id === reference.approvedRevisionId);
  const durationMs = m?.durationMs ?? latest?.mediaMetadata?.durationMs ?? entry.sourceMedia?.durationMs ?? 0;
  const status = statusOf(entry);
  const seek = (ms: number) => { if (!video.current) return; video.current.currentTime = ms / 1000; void video.current.play().catch(() => undefined); };
  const At = ({ ms }: Readonly<{ ms?: number }>) => (ms === undefined ? null : <button type="button" className="time-link" onClick={() => seek(ms)}>{seconds(ms)}</button>);
  const editableDna = latest ? JSON.stringify(Object.fromEntries(Object.entries(latest).filter(([key]) => !["id", "creativeReferenceId", "revision", "status", "source", "mediaMetadata", "providerMetadata", "createdBy", "createdAt", "operatorNotes"].includes(key))), null, 2) : "";
  const performance = m?.performance;
  const canRegenerate = ["DRAFT", "APPROVED"].includes(reference.analysisStatus) && record?.status !== "PENDING";
  const canAnalyze = ["NOT_ANALYZED", "FAILED", "SUBMISSION_UNKNOWN", "RESULT_UNAVAILABLE"].includes(reference.analysisStatus);

  return <article className="winner-report">
    <header className="winner-report-header">
      <div><p className="eyebrow">{entry.productName ?? "Product"} · {reference.platform ?? "Platform not set"}{durationMs ? ` · ${seconds(durationMs)}` : ""}</p><h2>{reference.displayName}</h2><span className={`winner-status ${status.tone}`}>{status.label}</span></div>
      <div className="winner-actions">
        {canAnalyze && <button className="primary" disabled={working} onClick={onAnalyze}>Analyze this video</button>}
        {canRegenerate && <button disabled={working} onClick={onRegenerate}>{report ? "Regenerate report" : "Generate report"}</button>}
        {onDelete && <button className="danger" disabled={working || status.tone === "working"} title={status.tone === "working" ? "Wait for the analysis to finish" : ""} onClick={onDelete}>Delete winner</button>}
      </div>
    </header>

    <section className="winner-top">
      <video ref={video} controls preload="metadata" src={`/api/assets/${reference.sourceAssetId}`} />
      <div className="winner-verdict">
        <h3>Why it likely won</h3>
        {record?.status === "PENDING" && <p className="muted">Claude is watching the frames and reading the voiceover. This usually takes 1–2 minutes and refreshes automatically.</p>}
        {record?.status === "FAILED" && <p className="error">The report could not be produced: {record.failureMessage ?? "unknown error"}. {canRegenerate ? "Try Regenerate report." : ""}</p>}
        {!record && !canAnalyze && <p className="muted">This video was analyzed before Winner Analysis existed. Generate its report to see the breakdown.</p>}
        {report && <>
          <p className="verdict-summary">{report.verdict.summary}</p>
          <ol className="reasons">{report.verdict.reasons.map((reason: any, index: number) => <li key={index}><div><b>{reason.title}</b><span className={`confidence ${reason.confidence.toLowerCase()}`}>{humanize(reason.confidence)} confidence</span></div><p>{reason.explanation}</p><p className="evidence">{reason.evidence.map((item: any, i: number) => <span key={i}><At ms={item.timestampMs} /> {item.detail}</span>)}</p></li>)}</ol>
          <p className="muted small">Reasons are evidence-based hypotheses from one ad, not proven causes. Test them before relying on them.</p>
        </>}
      </div>
    </section>

    {entry.metaLink && <MetaResults link={entry.metaLink} reportUpdatedAt={record?.updatedAt} working={working} onRefresh={onRefreshMeta} />}

    {m && <section className="stat-grid" aria-label="Measured facts">
      <Stat label="Shots" value={m.shotCount !== undefined ? String(m.shotCount) : undefined} note={m.averageShotMs ? `avg ${seconds(m.averageShotMs)} per shot` : undefined} />
      <Stat label="First cut" value={m.firstCutMs !== undefined ? seconds(m.firstCutMs) : "No cuts"} />
      <Stat label="Product first visible" value={report?.hook.productFirstVisibleMs !== undefined ? seconds(report.hook.productFirstVisibleMs) : undefined} note="AI estimate" />
      <Stat label="First spoken word" value={m.timeToFirstWordMs !== undefined ? seconds(m.timeToFirstWordMs) : undefined} />
      <Stat label="Voice coverage" value={m.speechCoverage !== undefined ? percent(m.speechCoverage) : undefined} note="share of runtime with speech" />
      <Stat label="Speaking pace" value={m.wordsPerMinute !== undefined ? `${m.wordsPerMinute} wpm` : undefined} />
      <Stat label="Audio present" value={m.audioPresentRatio !== undefined ? percent(m.audioPresentRatio) : undefined} note={m.speechCoverage !== undefined && m.audioPresentRatio !== undefined && m.audioPresentRatio - m.speechCoverage > 0.2 ? "sound beyond the voice, likely music" : undefined} />
      <Stat label="Loudness" value={m.integratedLufs !== undefined ? `${m.integratedLufs.toFixed(1)} LUFS` : undefined} />
      <Stat label="CTA" value={report?.angle.ctaTimestampMs !== undefined ? seconds(report.angle.ctaTimestampMs) : undefined} note={report?.angle.cta} />
    </section>}

    {performance && !entry.metaLink && <section className="stat-grid performance" aria-label="Performance you entered">
      <Stat label="Spend" value={performance.spend !== undefined ? money(performance.spend, performance.currency) : undefined} />
      <Stat label="Purchases" value={performance.purchases !== undefined ? String(performance.purchases) : undefined} />
      <Stat label="Revenue" value={performance.revenue !== undefined ? money(performance.revenue, performance.currency) : undefined} />
      <Stat label="CPA" value={performance.cpa !== undefined ? money(performance.cpa, performance.currency) : undefined} />
      <Stat label="ROAS" value={performance.roas !== undefined ? `${performance.roas.toFixed(2)}x` : undefined} />
      <Stat label="Link CTR" value={performance.linkCtr !== undefined ? `${performance.linkCtr}%` : undefined} />
      <Stat label="CPC" value={performance.cpc !== undefined ? money(performance.cpc, performance.currency) : undefined} />
      <Stat label="CPM" value={performance.cpm !== undefined ? money(performance.cpm, performance.currency) : undefined} />
    </section>}

    {report && <>
      <section className="card"><h3>Timeline</h3>
        {durationMs > 0 && <TimelineStrip report={report} measurements={m} durationMs={durationMs} onSeek={seek} />}
        <table className="beat-table"><thead><tr><th>Time</th><th>Beat</th><th>What we see</th><th>Voice</th><th>On-screen text</th><th>Purpose</th></tr></thead>
          <tbody>{report.timeline.map((beat: any, index: number) => <tr key={index}><td><At ms={beat.startMs} />–{seconds(beat.endMs)}</td><td>{humanize(beat.beat)}</td><td>{beat.visual}</td><td>{beat.voiceLine ? `"${beat.voiceLine}"` : "—"}</td><td>{beat.onScreenText || "—"}</td><td>{beat.purpose}</td></tr>)}</tbody></table>
      </section>

      <div className="report-columns">
        <section className="card"><h3>Hook (first 3 seconds) <span className={`hook-strength ${report.hook.strength.toLowerCase()}`}>{humanize(report.hook.strength)}</span></h3>
          <dl><dt>Type</dt><dd>{humanize(report.hook.hookType)}</dd><dt>Visual</dt><dd>{report.hook.visualHook}</dd><dt>On-screen text</dt><dd>{report.hook.textHook || "None"}</dd><dt>Spoken</dt><dd>{report.hook.spokenHook ? `"${report.hook.spokenHook}"` : "None"}</dd><dt>Why it stops the scroll</dt><dd>{report.hook.whyItStops}</dd></dl>
        </section>
        <section className="card"><h3>Angle & message</h3>
          <dl><dt>Core angle</dt><dd>{report.angle.coreAngle}</dd><dt>Buyer motivation</dt><dd>{report.angle.buyerMotivation}</dd><dt>Desire / problem</dt><dd>{report.angle.desireOrProblem}</dd><dt>Awareness level</dt><dd>{humanize(report.angle.awarenessLevel)}</dd><dt>Emotional triggers</dt><dd>{report.angle.emotionalTriggers.join(", ") || "—"}</dd><dt>Promise</dt><dd>{report.angle.promise}</dd><dt>Proof</dt><dd>{report.angle.proof}</dd><dt>Offer</dt><dd>{report.angle.offer || "No offer shown"}</dd><dt>Objections handled</dt><dd>{report.angle.objectionsHandled.join("; ") || "—"}</dd><dt>CTA</dt><dd>{report.angle.cta} <At ms={report.angle.ctaTimestampMs} /></dd></dl>
        </section>
      </div>

      <div className="report-columns">
        <section className="card"><h3>Voice & script</h3>
          <dl><dt>Delivery</dt><dd>{report.voice.deliveryStyle}</dd><dt>Script structure</dt><dd>{report.voice.scriptStructure}</dd></dl>
          {report.voice.keyPhrases.length > 0 && <p className="chips">{report.voice.keyPhrases.map((phrase: string) => <span key={phrase}>{phrase}</span>)}</p>}
          {m?.transcriptSegments?.length > 0 ? <details><summary>Full transcript ({m.transcriptModel})</summary><ol className="transcript">{m.transcriptSegments.map((segment: any, index: number) => <li key={index}><At ms={segment.startMs} /> {segment.text}</li>)}</ol></details> : <p className="muted small">{m?.transcriptStatus === "NO_AUDIO" ? "This video has no audio track." : m?.transcriptStatus === "DISABLED" ? "Voice transcription is turned off on the server." : m?.transcriptStatus === "FAILED" ? "Voice transcription failed for this video." : "No speech was detected."}</p>}
          <p className="muted small">Music and sound effects cannot be analyzed; only speech is transcribed.</p>
        </section>
        <section className="card"><h3>Editing & format</h3>
          <dl><dt>Format</dt><dd>{report.editing.format}</dd><dt>Captions</dt><dd>{report.editing.captionStyle}</dd><dt>Product prominence</dt><dd>{report.editing.productProminence}</dd><dt>Sound-off viewing</dt><dd>{report.editing.soundOffComprehension}</dd><dt>Pacing</dt><dd>{report.editing.pacingAssessment}</dd></dl>
        </section>
      </div>

      <div className="report-columns">
        <section className="card"><h3>Claims check</h3>
          {report.claimsCheck.length ? <table className="claims-table"><tbody>{report.claimsCheck.map((claim: any, index: number) => <tr key={index}><td>{claim.claim}</td><td><span className={`claim-status ${claim.status.toLowerCase()}`}>{claim.status === "MATCHES_CURRENT_PRODUCT" ? "✓ Matches product" : claim.status === "HISTORICAL_OFFER" ? "Historical offer" : "⚠ Not in product facts"}</span></td><td>{claim.note}</td></tr>)}</tbody></table> : <p className="muted">No factual product claims were found in the ad.</p>}
        </section>
        <section className="card"><h3>Performance read</h3><p>{report.performanceRead}</p>{!performance && <p className="muted small">Add spend, purchases, and revenue when uploading to get CPA and ROAS here.</p>}</section>
      </div>

      <section className="card brief"><h3>Brief for the next creatives</h3>
        <div className="brief-columns">
          <div><h4>Keep</h4><ul>{report.nextCreativeBrief.keep.map((item: string) => <li key={item}>{item}</li>)}</ul></div>
          <div><h4>Avoid</h4><ul>{report.nextCreativeBrief.avoid.map((item: string) => <li key={item}>{item}</li>)}</ul></div>
        </div>
        <h4>Test next</h4>
        <ol className="test-ideas">{report.nextCreativeBrief.test.map((test: any, index: number) => <li key={index}><span className="test-type">{humanize(test.type)}</span><b>{test.idea}</b><p>{test.hypothesis}</p></li>)}</ol>
      </section>
    </>}

    {latest && <section className="card dna-section"><h3>Use this winner for new creatives</h3>
      {approved ? <>
        <p>Approved. This winner now guides new ideas for {entry.productName ?? "this product"}.</p>
        {campaigns.length ? <div className="use-in-campaign"><select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}><option value="">Choose a campaign…</option>{campaigns.map((campaign: any) => <option key={campaign.id} value={campaign.id}>{campaign.publicId} · {campaign.creativeTopic ?? "Campaign"}</option>)}</select><button className="primary" disabled={!campaignId} onClick={() => onUseInCampaign(campaigns.find((campaign: any) => campaign.id === campaignId), approved.id)}>Open campaign with this winner</button></div> : <p className="muted">Create a campaign for this product to use this winner.</p>}
      </> : <p>Approve this winner to let it guide new ideas. You can check its rules below first.</p>}
      <details><summary>Rules the AI learned from this ad (version {latest.revision}, {latest.status.toLowerCase()})</summary>
        <p className="muted small">These are the rules the AI follows when it creates new ideas from this winner. Advanced: edit the text to correct them; saving creates a new version.</p>
        <textarea rows={14} value={dnaText ?? editableDna} onChange={(event) => setDnaText(event.target.value)} />
        <div className="winner-actions"><button disabled={working || dnaText === undefined} onClick={() => { onSaveDna(dnaText!); setDnaText(undefined); }}>Save as new version</button>{latest.status !== "APPROVED" && <button className="primary" disabled={working} onClick={() => onApprove(latest.id)}>Approve this winner</button>}</div>
      </details>
    </section>}
  </article>;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const daysAgo = (days: number) => isoDay(new Date(Date.now() - days * 86_400_000));
const metaSorts = [["spend", "Spend"], ["roas", "ROAS"], ["purchases", "Purchases"], ["hookRate", "Hook rate"], ["holdRate", "Hold rate"], ["cpa", "Lowest CPA"]] as const;

function MetaImport({ products, working, onImport }: Readonly<{ products: readonly any[]; working: boolean; onImport: (ad: any, productId: string) => void }>) {
  const [status, setStatus] = useState<any>();
  const [accountId, setAccountId] = useState("");
  const [since, setSince] = useState(daysAgo(30));
  const [until, setUntil] = useState(isoDay(new Date()));
  const [sort, setSort] = useState<(typeof metaSorts)[number][0]>("spend");
  const [productId, setProductId] = useState("");
  const [ads, setAds] = useState<any[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api("/api/meta/status").then((next) => { setStatus(next); if (next.accounts?.[0]) setAccountId(next.accounts[0].id); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not reach Meta."));
  }, []);
  const load = async () => {
    setLoading(true); setError("");
    try { setAds(await api(`/api/meta/top-ads?accountId=${encodeURIComponent(accountId)}&since=${since}&until=${until}`)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load ads."); } finally { setLoading(false); }
  };
  const sorted = useMemo(() => [...(ads ?? [])].sort((a, b) => sort === "cpa" ? (a.metrics.cpa ?? Infinity) - (b.metrics.cpa ?? Infinity) : (b.metrics[sort] ?? -1) - (a.metrics[sort] ?? -1)), [ads, sort]);
  const currency = status?.accounts?.find((account: any) => account.id === accountId)?.currency;
  if (status && !status.configured) return <section className="card"><h2>Import from Meta</h2><p>The Meta Ads integration is not configured yet. Add <code>META_ADS_ACCESS_TOKEN</code> and <code>META_AD_ACCOUNT_IDS</code> to the server environment and restart.</p></section>;
  return <section className="card meta-import"><h2>Import from Meta</h2>
    <p className="muted">Find your best-performing ads, then import one. Creative Factory downloads its video, pulls its lifetime results, and starts the analysis. Read-only: nothing in your ad account is changed.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="meta-filters">
      <label>Ad account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{status?.accounts?.map((account: any) => <option key={account.id} value={account.id}>{account.name}{account.currency ? ` (${account.currency})` : ""}</option>)}</select></label>
      <label>Range<select value="" onChange={(event) => { if (event.target.value) { setSince(daysAgo(Number(event.target.value))); setUntil(isoDay(new Date())); } }}><option value="">Preset…</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select></label>
      <label>From<input type="date" value={since} onChange={(event) => setSince(event.target.value)} /></label>
      <label>To<input type="date" value={until} onChange={(event) => setUntil(event.target.value)} /></label>
      <button className="primary" disabled={loading || !accountId} onClick={() => void load()}>{loading ? "Loading…" : "Show top ads"}</button>
    </div>
    {ads && <>
      <div className="meta-filters">
        <label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>{metaSorts.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Import as product (required)<select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose the product these ads sell…</option>{products.map((product: any) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      </div>
      <p className="muted small">Top {ads.length} ads by spend for {since} to {until}. Hook rate = 3-second views ÷ impressions; hold rate = ThruPlays ÷ 3-second views.</p>
      <div className="meta-table-wrap"><table className="beat-table meta-table"><thead><tr><th>Ad</th><th>Spend</th><th>Purch.</th><th>ROAS</th><th>CPA</th><th>CTR</th><th>Hook</th><th>Hold</th><th /></tr></thead>
        <tbody>{sorted.map((ad) => <tr key={ad.adId}><td><b>{ad.adName}</b><br /><small className="muted">{ad.campaignName}</small></td><td>{money(ad.metrics.spend, currency)}</td><td>{ad.metrics.purchases}</td><td>{ad.metrics.roas !== undefined ? `${ad.metrics.roas.toFixed(2)}x` : "—"}</td><td>{ad.metrics.cpa !== undefined ? money(ad.metrics.cpa, currency) : "—"}</td><td>{ad.metrics.linkCtr !== undefined ? `${(ad.metrics.linkCtr * 100).toFixed(2)}%` : "—"}</td><td>{ad.metrics.hookRate !== undefined ? percent(ad.metrics.hookRate) : "—"}</td><td>{ad.metrics.holdRate !== undefined ? percent(ad.metrics.holdRate) : "—"}</td>
          <td>{ad.importedReferenceId ? <span className="winner-status ready">Imported</span> : <button className="primary" disabled={working || !productId} title={productId ? "" : "Choose a product first"} onClick={() => onImport(ad, productId)}>Import</button>}</td></tr>)}</tbody></table></div>
      {ads.length === 0 && <p className="empty">No ads with delivery in this range.</p>}
    </>}
  </section>;
}

export function WinnerAnalysis({ sidebar, products, projects, isOwner, onUseInCampaign }: Props) {
  const [entries, setEntries] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get("winner") ?? undefined);
  const [productFilter, setProductFilter] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState(emptyUpload);
  const [file, setFile] = useState<File | undefined>();
  const [progress, setProgress] = useState<number | undefined>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const next = await api("/api/creative-references") as any[];
    setEntries([...next].sort((a, b) => String(b.reference.createdAt).localeCompare(String(a.reference.createdAt))));
  }, []);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load winners.")); }, [load]);
  const busy = entries.some((entry) => entry.reference.analysisStatus === "ANALYZING" || entry.winnerReport?.status === "PENDING");
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const visible = useMemo(() => entries.filter((entry) => !productFilter || entry.reference.productId === productFilter), [entries, productFilter]);
  const selected = entries.find((entry) => entry.reference.id === selectedId) ?? visible[0];
  const select = (id: string) => { setSelectedId(id); history.replaceState({}, "", `/winners?winner=${id}`); };
  const campaignsFor = (productId: string | undefined) => projects.filter((project: any) => project.productId === productId && !project.strategyOrigin);
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setWorking(true); setError("");
    try { await action(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : failure); } finally { setWorking(false); }
  };

  const importFromMeta = (ad: any, productId: string) => void run(async () => {
    setNotice("");
    const result = await api("/api/meta/import", "POST", { accountId: ad.accountId, adId: ad.adId, productId, displayName: ad.adName.slice(0, 160) });
    if (result.status === "IMPORTED") { setShowMeta(false); select(result.referenceId); setNotice(`Imported "${ad.adName}". Analysis started.`); return; }
    setUpload({ ...emptyUpload, productId, displayName: ad.adName.slice(0, 160), metaAccountId: ad.accountId, metaAdId: ad.adId });
    setShowMeta(false); setShowUpload(true);
  }, "Could not import this ad.");

  const submitUpload = async () => {
    if (!file || !upload.productId || !upload.displayName.trim()) { setError("Choose a product, give the winner a name, and select its video."); return; }
    const performanceEntries = performanceFields.flatMap(([key]) => (upload[key].trim() ? [[key, Number(upload[key])]] as const : []));
    if (performanceEntries.some(([, value]) => !Number.isFinite(value) || value < 0)) { setError("Performance figures must be positive numbers."); return; }
    const metadata = {
      ...(upload.metaAccountId && upload.metaAdId ? { metaAccountId: upload.metaAccountId, metaAdId: upload.metaAdId } : {}),
      displayName: upload.displayName.trim(), operatorStatus: "WINNER", ...(upload.platform.trim() ? { platform: upload.platform.trim() } : {}),
      ...(upload.dateStart ? { dateStart: upload.dateStart } : {}), ...(upload.dateEnd ? { dateEnd: upload.dateEnd } : {}),
      ...(upload.operatorNotes.trim() ? { operatorNotes: upload.operatorNotes.trim() } : {}), ...(upload.operatorTranscript.trim() ? { operatorTranscript: upload.operatorTranscript.trim() } : {}),
      ...(performanceEntries.length ? { performance: { ...Object.fromEntries(performanceEntries), currency: upload.currency || "USD", metricSource: "operator entered", ...(upload.dateStart ? { dateStart: upload.dateStart } : {}), ...(upload.dateEnd ? { dateEnd: upload.dateEnd } : {}) } } : {})
    };
    await run(async () => {
      setProgress(0);
      const base = `/api/products/${upload.productId}/creative-references`;
      let reference: any;
      try {
        const target = await api(`${base}/upload`, "POST", { filename: file.name, mimeType: file.type, byteSize: file.size, sha256: await sha256Hex(file) });
        await putWithProgress(target.url, target.headers, file, setProgress);
        setProgress(100);
        reference = await api(`${base}/complete`, "POST", { assetId: target.assetId, ...metadata });
      } catch (reason) {
        // Local development stores media without S3 direct upload; fall back to a multipart post.
        if (!(reason instanceof Error) || !reason.message.includes("Direct durable upload is not enabled")) throw reason;
        const form = new FormData();
        for (const [key, value] of Object.entries(metadata)) form.append(key, typeof value === "string" ? value : JSON.stringify(value));
        form.append("file", file);
        const response = await fetch(base, { method: "POST", headers: { "x-koolezt-actor": "web-user" }, body: form });
        reference = await response.json();
        if (!response.ok) throw new Error(reference.message ?? "Upload failed.");
      }
      await api(`/api/creative-references/${reference.id}/analyze`, "POST", { requestId: crypto.randomUUID() });
      setUpload(emptyUpload); setFile(undefined); setShowUpload(false);
      if (fileInput.current) fileInput.current.value = "";
      select(reference.id);
    }, "Upload failed.");
    setProgress(undefined);
  };

  const library = <aside className="project-browser winner-library">
    <div className="project-browser-header"><h2>Winning creatives</h2><button className="primary" onClick={() => { setShowMeta(false); setUpload(emptyUpload); setShowUpload(true); }}>+ Add winner</button></div>
    <button className={showMeta ? "nav-active meta-import-button" : "meta-import-button"} onClick={() => { setShowUpload(false); setShowMeta(true); }}>Import from Meta</button>
    <select value={productFilter} onChange={(event) => setProductFilter(event.target.value)} aria-label="Filter by product"><option value="">All products</option>{products.map((product: any) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
    <div className="winner-list">{visible.map((entry) => {
      const status = statusOf(entry);
      const roas = entry.metaLink?.metrics?.roas ?? entry.winnerReport?.measurements?.performance?.roas;
      return <button key={entry.reference.id} className={`winner-card ${selected?.reference.id === entry.reference.id && !showUpload && !showMeta ? "active" : ""}`} onClick={() => { setShowUpload(false); setShowMeta(false); select(entry.reference.id); }}>
        <b>{entry.reference.displayName}</b><span>{entry.productName ?? "Unknown product"}</span>
        <small><span className={`winner-status ${status.tone}`}>{status.label}</span>{roas !== undefined ? ` · ROAS ${roas.toFixed(2)}x` : ""}</small>
      </button>;
    })}{visible.length === 0 && <p className="empty">No winning creatives yet. Add one to see why it worked.</p>}</div>
  </aside>;

  return <main className="app-shell">{sidebar}{library}<section className="workspace workspace-static winner-workspace"><div className="workspace-panel">
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {showMeta ? <MetaImport products={products} working={working} onImport={importFromMeta} />
      : showUpload ? <section className="card winner-upload"><h2>Add a winning creative</h2>
      {upload.metaAdId && <p className="notice">Linked to Meta ad {upload.metaAdId}. Meta did not allow downloading this video with the current token, so download it from Ads Manager and upload it here. Its results will be pulled from Meta automatically.</p>}
      <p className="muted">Upload the ad video. Claude analyzes its frames, scene cuts, and on-screen text; OpenAI transcribes the voiceover. Analysis starts when you click the button and costs a few cents.</p>
      <div className="form-grid">
        <label>Product (required)<select required value={upload.productId} onChange={(event) => setUpload({ ...upload, productId: event.target.value })}><option value="">Choose the product this ad sells…</option>{products.map((product: any) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
        <label>Name<input required maxLength={160} value={upload.displayName} placeholder="Dog address sign, Oct UGC" onChange={(event) => setUpload({ ...upload, displayName: event.target.value })} /></label>
        <label>Platform<input maxLength={80} value={upload.platform} onChange={(event) => setUpload({ ...upload, platform: event.target.value })} /></label>
        <label>Ran from<input type="date" value={upload.dateStart} onChange={(event) => setUpload({ ...upload, dateStart: event.target.value })} /></label>
        <label>Ran until<input type="date" value={upload.dateEnd} onChange={(event) => setUpload({ ...upload, dateEnd: event.target.value })} /></label>
        <label>Currency<input maxLength={3} value={upload.currency} onChange={(event) => setUpload({ ...upload, currency: event.target.value.toUpperCase() })} /></label>
      </div>
      {!upload.metaAdId && <><h4>Results (optional, recommended)</h4>
      <div className="form-grid">{performanceFields.map(([key, label]) => <label key={key}>{label}<input inputMode="decimal" value={upload[key]} onChange={(event) => setUpload({ ...upload, [key]: event.target.value })} /></label>)}</div></>}
      <label>Notes for the analysis<textarea rows={2} value={upload.operatorNotes} placeholder="Audience, placement, anything you know about why it worked" onChange={(event) => setUpload({ ...upload, operatorNotes: event.target.value })} /></label>
      <label>Exact voiceover script (optional; overrides the automatic transcript)<textarea rows={2} value={upload.operatorTranscript} onChange={(event) => setUpload({ ...upload, operatorTranscript: event.target.value })} /></label>
      <label>Video (MP4 or WebM)<input ref={fileInput} type="file" accept="video/mp4,video/webm,.mp4,.webm" disabled={working} onChange={(event) => setFile(event.target.files?.[0])} /></label>
      {progress !== undefined && <div className="upload-progress" aria-live="polite"><progress max={100} value={progress} /><span>{progress < 100 ? `Uploading… ${progress}%` : "Upload complete. Starting analysis…"}</span></div>}
      <div className="winner-actions"><button className="primary" disabled={working || !file || !upload.productId} onClick={() => void submitUpload()}>{working ? "Working…" : "Upload and analyze"}</button><button disabled={working} onClick={() => setShowUpload(false)}>Cancel</button></div>
    </section>
      : selected ? <WinnerReportView key={selected.reference.id} entry={selected} campaigns={campaignsFor(selected.reference.productId)} working={working}
        onAnalyze={() => void run(() => api(`/api/creative-references/${selected.reference.id}/analyze`, "POST", { requestId: crypto.randomUUID() }), "Could not start the analysis.")}
        onRegenerate={() => void run(() => api(`/api/creative-references/${selected.reference.id}/analyze`, "POST", { requestId: crypto.randomUUID(), mode: "REPORT" }), "Could not start the report.")}
        onApprove={(revisionId) => void run(() => api(`/api/creative-references/${selected.reference.id}/dna/${revisionId}/approve`, "POST", {}), "Could not approve this winner.")}
        onSaveDna={(text) => void run(async () => api(`/api/creative-references/${selected.reference.id}/dna`, "PUT", JSON.parse(text)), "Could not save the rules.")}
        onUseInCampaign={onUseInCampaign}
        onRefreshMeta={() => void run(() => api(`/api/creative-references/${selected.reference.id}/meta/refresh`, "POST", {}), "Could not refresh from Meta.")}
        {...(isOwner ? { onDelete: () => {
          if (!window.confirm(`Delete "${selected.reference.displayName}" from Winner Analysis?\n\nIt disappears from this page and from campaign winner lists. Campaigns that already used it keep their copy. An administrator can restore it.`)) return;
          void run(async () => { await api(`/api/creative-references/${selected.reference.id}`, "DELETE"); setSelectedId(undefined); history.replaceState({}, "", "/winners"); setNotice(`Deleted "${selected.reference.displayName}".`); }, "Could not delete this winner.");
        } } : {})} />
      : <section className="card"><h2>Winner Analysis</h2><p>Upload a winning ad to see why it worked: the hook, angle, beat-by-beat timeline, voiceover, editing, claims check, and a brief for your next creatives.</p><button className="primary" onClick={() => setShowUpload(true)}>+ Add winner</button></section>}
  </div></section></main>;
}
