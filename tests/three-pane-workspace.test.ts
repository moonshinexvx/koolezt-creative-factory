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
    for (const campaignAction of ["+ Create Campaign", "+ Create Project", "Winning Creative", "Concepts"]) expect(source).toContain(campaignAction);
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

  it("shows an explicit guarded Creative Reference source-video upload workflow", async () => {
    const source = await readFile(new URL("../apps/web/src/main.tsx", import.meta.url), "utf8");
    expect(source).toContain("Source video (required)");
    expect(source).toContain('type="file" accept="video/mp4,video/webm,.mp4,.webm"');
    expect(source).toContain("No source video selected. Choose an MP4 or WebM file.");
    expect(source).toContain("Remove selected video");
    expect(source).toContain("Create Creative Reference");
    expect(source).toContain("disabled={dnaWorking||!referenceVideo}");
    expect(source).toContain("Uploading source video…");
    expect(source).toContain("new XMLHttpRequest()");
    expect(source).toContain("/creative-references/upload");
    expect(source).toContain("/creative-references/complete");
    expect(source).toContain('request.open("PUT",target.url)');
    expect(source).toContain('crypto.subtle.digest("SHA-256",bytes)');
    expect(source).not.toContain('request.open("POST",`/api/projects/${selected.id}/creative-references`)');
    expect(source).toContain("Analyze Creative DNA (OpenAI)");
    expect(source).not.toContain('<input hidden type="file" accept="video/mp4,video/webm"');
  });
});
