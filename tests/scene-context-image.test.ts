import { describe, expect, it } from "vitest";
import { buildSceneContextImagePrompt } from "@koolezt/domain";



describe("scene context image workflow", () => {
  it("compiles a still-image prompt anchored to Product authority without asking the image model for overlays", () => {
    const prompt = buildSceneContextImagePrompt({
      productName: "Personalized Address Sign",
      purpose: "Show the installed Product immediately",
      generationPrompt: "Mount the supplied sign beside a front door.",
      accuracyRequirements: ["Keep the number 4107 unchanged"]
    });
    expect(prompt).toContain("9:16 BACKGROUND PLATE");
    expect(prompt).toContain("DO NOT draw, recreate, reinterpret, personalize, mount, or include the Product");
    expect(prompt).toContain("Mount the supplied sign beside a front door");
    expect(prompt).toContain("Keep the number 4107 unchanged");
    expect(prompt).toContain("the authoritative Product and deterministic overlays are added later");
  });

});
