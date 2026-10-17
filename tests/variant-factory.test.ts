import { describe, expect, it } from "vitest";
import { VARIANT_ORDER_MATRIX, VARIANT_TREATMENT_MATRIX } from "@koolezt/domain";

describe("Variant Factory matrix", () => {
  it("creates exactly twelve deterministic, balanced recipes", () => {
    expect(VARIANT_ORDER_MATRIX).toHaveLength(12); expect(VARIANT_TREATMENT_MATRIX).toHaveLength(12);
    expect([1,2,3].map((scene) => VARIANT_ORDER_MATRIX.filter((order) => order[0] === scene).length)).toEqual([4,4,4]);
    expect(new Set(VARIANT_ORDER_MATRIX.map((order) => order.join("-"))).size).toBe(6);
    expect(["PUSH_IN","REFRAME_PAN","ALTERNATE_ZOOM","FAST_HOOK"].map((treatment) => VARIANT_TREATMENT_MATRIX.filter((value) => value === treatment).length)).toEqual([3,3,3,3]);
  });
});