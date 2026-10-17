import { describe, expect, it } from "vitest";
import { FakeCreativeProvider } from "@koolezt/providers";

describe("variant creative package copy provider", () => {
  it("returns exactly four distinct manual-reviewable packages only when explicitly invoked", async () => {
    const provider = new FakeCreativeProvider();
    expect(provider.calls).toHaveLength(0);
    const result = await provider.generateVariantPackages!({ productName: "Personalized pet ornament", productDetails: "Photo and name", scenes: [], targetDurationMs: 15_000 }, { operationKey: "explicit-copy", projectId: "project-a", targetId: "packages" });
    expect(provider.calls).toHaveLength(1);
    expect(result.packages.map(item => item.slot)).toEqual(["A","B","C","D"]);
    expect(new Set(result.packages.map(item => item.angleName)).size).toBe(4);
    expect(new Set(result.packages.map(item => item.hook)).size).toBe(4);
    expect(new Set(result.packages.map(item => item.narrationText)).size).toBe(4);
    expect(new Set(result.packages.map(item => item.cta)).size).toBe(4);
    expect(result.packages.every(item => item.hook.split(/\s+/).length <= 8)).toBe(true);
  });
});