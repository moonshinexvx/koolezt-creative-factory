import { assessVoiceTiming, calculateSceneTimeline, estimateNarrationDurationMs } from "@koolezt/domain";
import { describe, expect, it } from "vitest";

describe("render timing", () => {
  it("adds soft-dissolve overlap back into source durations while preserving the target output", () => {
    expect(calculateSceneTimeline(15_000, 3, 500)).toEqual([5_334, 5_333, 5_333]);
    expect(calculateSceneTimeline(20_000, 3, 500).reduce((sum, duration) => sum + duration, 0) - 1_000).toBe(20_000);
  });

it("estimates narration before TTS without treating the estimate as authoritative", () => {
    expect(estimateNarrationDurationMs("one two three four five six seven")).toBe(3_000);
    expect(estimateNarrationDurationMs("")).toBe(0);
  });

  it("classifies narration against the duration-aware target and never applies extreme atempo", () => {
    expect(assessVoiceTiming(15_000, 13_600)).toMatchObject({ minimumMs: 13_001, maximumMs: 14_201, leadInMs: 401, classification: "GOOD", atempo: 1 });
    expect(assessVoiceTiming(15_000, 9_000)).toMatchObject({ classification: "TOO_SHORT", atempo: 1 });
    expect(assessVoiceTiming(15_000, 12_500).atempo).toBeGreaterThanOrEqual(0.92);
    expect(assessVoiceTiming(15_000, 14_600).atempo).toBeLessThanOrEqual(1.08);
  });
});