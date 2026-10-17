import { describe, expect, it } from "vitest";
import { VARIANT_DIVERSITY_MATRIX } from "@koolezt/domain";

describe("Creative Diversity B02+ matrix", () => {
  it("pins the exact 3 × 4 package, treatment, and opening-scene distribution", () => {
    expect(VARIANT_DIVERSITY_MATRIX).toHaveLength(12);
    expect(["A","B","C","D"].map(slot => VARIANT_DIVERSITY_MATRIX.filter(item => item.slot === slot).length)).toEqual([3,3,3,3]);
    expect(["PUSH_IN","REFRAME_PAN","ALTERNATE_ZOOM","FAST_HOOK"].map(treatment => VARIANT_DIVERSITY_MATRIX.filter(item => item.treatment === treatment).length)).toEqual([3,3,3,3]);
    expect([1,2,3].map(scene => VARIANT_DIVERSITY_MATRIX.filter(item => item.openingScene === scene).length)).toEqual([4,4,4]);
    expect(VARIANT_DIVERSITY_MATRIX.map(item => `${item.openingScene}:${item.slot}:${item.treatment}`)).toEqual([
      "1:A:PUSH_IN","1:B:REFRAME_PAN","1:C:ALTERNATE_ZOOM","1:D:FAST_HOOK",
      "2:A:PUSH_IN","2:B:REFRAME_PAN","2:C:ALTERNATE_ZOOM","2:D:FAST_HOOK",
      "3:A:PUSH_IN","3:B:REFRAME_PAN","3:C:ALTERNATE_ZOOM","3:D:FAST_HOOK"
    ]);
  });
});