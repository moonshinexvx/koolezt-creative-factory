import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFile(new URL(`../apps/web/src/${name}`, import.meta.url), "utf8");

describe("winner-to-video web app", () => {
  it("offers only the three pages of the simplified workflow", async () => {
    const main = await source("main.tsx");
    for (const label of ['"Winners"', '"Products"', '"All videos"']) expect(main).toContain(label);
    for (const retired of ["Create Campaign", "Render Workers", "/api/projects", "strategy-batches"]) expect(main).not.toContain(retired);
  });

  it("writes plans from a winner and makes only the ticked ones", async () => {
    const make = await source("make-videos.tsx");
    expect(make).toContain("/api/creative-references/${referenceId}/video-plans");
    expect(make).toContain("/api/video-batches/${batch.id}/make");
    expect(make).toContain("Make this video");
    const winners = await source("winners.tsx");
    expect(winners).toContain("<MakeVideos referenceId={reference.id}");
    expect(winners).not.toContain("Open campaign with this winner");
    expect(winners).not.toContain("Use this winner for new creatives");
  });

  it("keeps product facts and photos as the only material for new videos", async () => {
    const products = await source("products.tsx");
    expect(products).toContain("Facts the ads may say (one per line)");
    expect(products).toContain("/api/products/${selected.id}/assets");
    expect(products).toContain("Make main");
  });
});
