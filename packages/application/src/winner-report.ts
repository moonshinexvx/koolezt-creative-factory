import { DomainError, WINNER_AWARENESS_LEVELS, WINNER_BEATS, WINNER_CLAIM_STATUSES, WINNER_EVIDENCE_SOURCES, WINNER_HOOK_TYPES, WINNER_TEST_TYPES } from "@koolezt/domain";
import type { CreativeDnaAnalysisInput, CreativePerformanceContext, WinnerEvidence, WinnerMeasurements, WinnerReport } from "@koolezt/domain";

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const strings = (value: unknown, maxItems: number, max = 200) => [...new Set(list(value).map((item) => str(item, max)).filter(Boolean))].slice(0, maxItems);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Timestamps the model reports are clamped into the ad's real duration; anything else is dropped. */
function msWithin(value: unknown, durationMs: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(durationMs, Math.max(0, Math.round(value))) : undefined;
}

function evidence(value: unknown, durationMs: number): WinnerEvidence[] {
  return list(value).flatMap((raw) => {
    const item = record(raw);
    const detail = str(item.detail, 300);
    if (!detail) return [];
    const timestampMs = msWithin(item.timestampMs, durationMs);
    const endTimestampMs = msWithin(item.endTimestampMs, durationMs);
    return [{ source: oneOf(item.source, WINNER_EVIDENCE_SOURCES, "FRAME"), detail, ...(timestampMs !== undefined ? { timestampMs } : {}), ...(endTimestampMs !== undefined && endTimestampMs >= (timestampMs ?? 0) ? { endTimestampMs } : {}) }];
  }).slice(0, 4);
}

export function canonicalizeWinnerReport(value: unknown, input: CreativeDnaAnalysisInput): WinnerReport {
  const durationMs = input.mediaMetadata.durationMs;
  const root = record(value);
  const verdict = record(root.verdict);
  const reasons = list(verdict.reasons).flatMap((raw) => {
    const item = record(raw);
    const title = str(item.title, 120);
    const explanation = str(item.explanation, 600);
    return title && explanation ? [{ title, explanation, confidence: oneOf(item.confidence, ["HIGH", "MEDIUM", "LOW"] as const, "LOW"), evidence: evidence(item.evidence, durationMs) }] : [];
  }).slice(0, 6);
  if (!reasons.length) throw new DomainError("WINNER_REPORT_INVALID", "The Winner Analysis report contained no evidence-backed reasons.");
  const hook = record(root.hook);
  const angle = record(root.angle);
  const voice = record(root.voice);
  const editing = record(root.editing);
  const brief = record(root.nextCreativeBrief);
  const productFirstVisibleMs = msWithin(hook.productFirstVisibleMs, durationMs);
  const ctaTimestampMs = msWithin(angle.ctaTimestampMs, durationMs);
  const timeline = list(root.timeline).flatMap((raw) => {
    const item = record(raw);
    const startMs = msWithin(item.startMs, durationMs);
    const endMs = msWithin(item.endMs, durationMs);
    if (startMs === undefined || endMs === undefined || endMs < startMs) return [];
    return [{ startMs, endMs, beat: oneOf(item.beat, WINNER_BEATS, "OTHER"), visual: str(item.visual, 300), voiceLine: str(item.voiceLine, 300), onScreenText: str(item.onScreenText, 200), purpose: str(item.purpose, 300) }];
  }).sort((a, b) => a.startMs - b.startMs).slice(0, 20);
  return {
    verdict: { summary: str(verdict.summary, 700), reasons },
    hook: { visualHook: str(hook.visualHook, 400), textHook: str(hook.textHook, 200), spokenHook: str(hook.spokenHook, 300), hookType: oneOf(hook.hookType, WINNER_HOOK_TYPES, "OTHER"), ...(productFirstVisibleMs !== undefined ? { productFirstVisibleMs } : {}), whyItStops: str(hook.whyItStops, 500), strength: oneOf(hook.strength, ["STRONG", "AVERAGE", "WEAK"] as const, "AVERAGE") },
    angle: { coreAngle: str(angle.coreAngle, 400), buyerMotivation: str(angle.buyerMotivation, 300), desireOrProblem: str(angle.desireOrProblem, 300), emotionalTriggers: strings(angle.emotionalTriggers, 6, 80), awarenessLevel: oneOf(angle.awarenessLevel, WINNER_AWARENESS_LEVELS, "PRODUCT_AWARE"), promise: str(angle.promise, 300), proof: str(angle.proof, 300), offer: str(angle.offer, 300), objectionsHandled: strings(angle.objectionsHandled, 6, 160), cta: str(angle.cta, 200), ...(ctaTimestampMs !== undefined ? { ctaTimestampMs } : {}) },
    timeline,
    voice: { deliveryStyle: str(voice.deliveryStyle, 300), scriptStructure: str(voice.scriptStructure, 400), keyPhrases: strings(voice.keyPhrases, 8, 120) },
    editing: { format: str(editing.format, 200), captionStyle: str(editing.captionStyle, 300), productProminence: str(editing.productProminence, 300), soundOffComprehension: str(editing.soundOffComprehension, 300), pacingAssessment: str(editing.pacingAssessment, 300) },
    claimsCheck: list(root.claimsCheck).flatMap((raw) => { const item = record(raw); const claim = str(item.claim, 200); return claim ? [{ claim, status: oneOf(item.status, WINNER_CLAIM_STATUSES, "NOT_IN_CURRENT_PRODUCT"), note: str(item.note, 300) }] : []; }).slice(0, 10),
    performanceRead: str(root.performanceRead, 600),
    nextCreativeBrief: { keep: strings(brief.keep, 6), test: list(brief.test).flatMap((raw) => { const item = record(raw); const idea = str(item.idea, 200); return idea ? [{ idea, hypothesis: str(item.hypothesis, 300), type: oneOf(item.type, WINNER_TEST_TYPES, "HOOK") }] : []; }).slice(0, 5), avoid: strings(brief.avoid, 6) }
  };
}

function derivedPerformance(performance: CreativePerformanceContext | undefined): WinnerMeasurements["performance"] {
  if (!performance) return undefined;
  const { spend, purchases, revenue } = performance;
  const cpa = performance.purchaseCpa ?? (spend !== undefined && purchases ? round(spend / purchases) : undefined);
  const roas = performance.roas ?? (spend && revenue !== undefined ? round(revenue / spend) : undefined);
  const values = { spend, purchases, revenue, cpa, roas, linkCtr: performance.linkCtr, cpc: performance.cpc, cpm: performance.cpm, currency: performance.currency, dateStart: performance.dateStart, dateEnd: performance.dateEnd, metricSource: performance.metricSource, impressions: performance.impressions, threeSecondViews: performance.threeSecondViews, thruPlays: performance.thruPlays, hookRate: performance.hookRate, holdRate: performance.holdRate };
  return Object.fromEntries(Object.entries(values).filter(([, item]) => item !== undefined)) as WinnerMeasurements["performance"];
}

/** Facts measured by the application from FFmpeg, the transcript, and operator figures. */
export function measureWinner(input: CreativeDnaAnalysisInput, performance?: CreativePerformanceContext): WinnerMeasurements {
  const { durationMs, width, height, hasAudio } = input.mediaMetadata;
  const transcript = input.audioTranscript;
  const segments = transcript?.status === "TRANSCRIBED" ? transcript.segments : [];
  const speechMs = segments.reduce((total, segment) => total + Math.max(0, Math.min(segment.endMs, durationMs) - segment.startMs), 0);
  const words = segments.reduce((total, segment) => total + segment.text.split(/\s+/).filter(Boolean).length, 0);
  const firstSegment = segments[0];
  const derived = derivedPerformance(performance);
  return {
    durationMs, width, height, frameCount: input.frames.length,
    sceneCutsMs: input.pacing?.sceneCutsMs ?? [],
    ...(input.pacing ? { shotCount: input.pacing.shotCount, averageShotMs: input.pacing.averageShotMs, ...(input.pacing.firstCutMs !== undefined ? { firstCutMs: input.pacing.firstCutMs } : {}) } : {}),
    hasAudio,
    transcriptStatus: transcript?.status ?? "NOT_REQUESTED",
    ...(transcript?.status === "TRANSCRIBED" ? { transcriptModel: transcript.model, transcriptText: transcript.text } : {}),
    transcriptSegments: segments,
    ...(segments.length && durationMs > 0 ? { speechCoverage: round(Math.min(1, speechMs / durationMs), 3) } : {}),
    ...(speechMs > 0 ? { wordsPerMinute: Math.round(words / (speechMs / 60_000)) } : {}),
    ...(firstSegment ? { timeToFirstWordMs: firstSegment.startMs } : {}),
    ...(input.audioLevels ? { audioPresentRatio: input.audioLevels.audioPresentRatio, ...(input.audioLevels.integratedLufs !== undefined ? { integratedLufs: input.audioLevels.integratedLufs } : {}) } : {}),
    ...(derived && Object.keys(derived).length ? { performance: derived } : {})
  };
}
