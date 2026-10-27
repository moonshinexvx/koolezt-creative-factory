import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("three-pane creative workspace", () => {
  it("keeps persistent navigation, project browser, and peer workspace tabs", async () => {
    const source = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    expect(source).toContain('className="app-shell"');
    expect(source).toContain('className="global-sidebar"');
    expect(source).toContain('className="project-browser"');
    expect(source).toContain('role="tablist"');
    for (const tab of ["Creative Brief", "Scene Review", "Voice", "Published Final", "Creative Variants"]) expect(source).toContain(tab);
    for (const campaignAction of ["+ Create Campaign", "+ Create Project", "Winner Analysis", "Concepts"]) expect(source).toContain(campaignAction);
    expect(source.match(/\+ Create Project/g)).toHaveLength(1);
    expect(source).toContain("campaignWorkspaceView ? campaignTabs : executionTabs");
    expect(source).toContain("const openCampaign = () =>");
    expect(source).toContain("collapsedCampaignIds");
    expect(source).not.toContain("campaign-tool-actions");
    expect(source).toContain("Generate Background Plate Only");
    expect(source).toContain("Copy Background Prompt");
    expect(source).toContain("fidelity-confirmed final composite");
    expect(source).toContain("Ready for video");
    expect(source).toContain("disabled={!attempt?.inputAssetId || !contextProductFidelityConfirmed || videoPromptChanged}");
    expect(source).toContain('history.pushState({}, "", `/projects/${project.id}/${nextTab}`)');
    expect(source).toContain('document.querySelectorAll<HTMLMediaElement>("video,audio")');
  });

  it("retains safe batch deletion and selectable direct variant download controls", async () => {
    const source = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    expect(source).toContain("Download Selected");
    expect(source).toContain("/api/variants/${variant.id}/download");
    expect(source).toContain("Select for download");
    expect(source).toContain("Delete Batch");
    expect(source).toContain("variant-grid");
    expect(source).toContain("variant-tile");
    expect(source).toContain("creative-package-grid");
    expect(source).toContain("variant-voice-grid");
    expect(source).toContain("Voice style for next generation");
    expect(source).toContain("schedule its variant MP4s for cleanup");
  });

  it("moves winning-creative upload and analysis to the Winner Analysis page", async () => {
    const main = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    const page = await readFile(new URL("../apps/web/src/winners.tsx", import.meta.url), "utf8");
    expect(main).toContain(">Winner Analysis</button>");
    expect(main).toContain('history.pushState({}, "", "/winners")');
    expect(main).not.toContain('id="panel-dna"');
    expect(main).not.toContain('["dna", "Winning Creative"]');
    expect(main).toContain('parts[2] === "dna" ? "strategy" : parts[2]');
    expect(page).toContain("Product (required)");
    expect(page).toContain('accept="video/mp4,video/webm,.mp4,.webm"');
    expect(page).toContain("/api/products/${upload.productId}/creative-references");
    expect(page).toContain('request.open("PUT", url)');
    expect(page).toContain('crypto.subtle.digest("SHA-256"');
    expect(page).toContain("Upload and analyze");
    expect(page).toContain('mode: "REPORT"');
    expect(page).toContain("Why it likely won");
    expect(page).toContain("Music and sound effects cannot be analyzed");
    expect(page).toContain("Open campaign with this winner");
  });
});
