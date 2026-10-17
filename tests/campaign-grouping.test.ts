import { describe, expect, it } from "vitest";
import { groupProjectsIntoCampaigns, projectConceptName, type CampaignProject } from "../apps/web/src/campaigns.js";

const project = (id: string, options: Partial<CampaignProject> = {}): CampaignProject => ({
  id, publicId: `CF-${id}`, productId: "product-1", state: "DRAFT", ...options
});

describe("Video Maker Campaign grouping", () => {
  it("presents six Strategy executions as one Campaign without merging their records", () => {
    const children = Array.from({ length: 6 }, (_, index) => project(String(index + 1), {
      strategyOrigin: { batchId: "batch-1", conceptId: `concept-${index + 1}`, conceptRevisionId: `revision-${index + 1}` },
      creativeInputSnapshot: { input: { selectedStrategy: { conceptName: `Concept ${index + 1}` } } }
    }));
    const grouped = groupProjectsIntoCampaigns(children, () => "Pet Address Sign");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "CAMPAIGN", batchId: "batch-1", productName: "Pet Address Sign" });
    if (grouped[0]?.kind !== "CAMPAIGN") throw new Error("Expected campaign");
    expect(grouped[0].projects.map((item) => item.id)).toEqual(children.map((item) => item.id));
    expect(new Set(grouped[0].projects.map((item) => item.strategyOrigin?.conceptRevisionId)).size).toBe(6);
  });

  it("places the authority-owning source workspace at Campaign level", () => {
    const owner = project("source");
    const children = [project("one", {
      strategyOrigin: { batchId: "batch-1", conceptId: "concept-1", conceptRevisionId: "revision-1", sourceProjectId: owner.id }
    }), project("two", {
      strategyOrigin: { batchId: "batch-1", conceptId: "concept-2", conceptRevisionId: "revision-2", sourceProjectId: owner.id }
    })];
    const grouped = groupProjectsIntoCampaigns([owner, ...children], () => "Pet Address Sign");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "CAMPAIGN", owner: { id: "source" }, projects: [{ id: "one" }, { id: "two" }] });
  });

  it("recovers the authority owner for historical batch-only handoffs without rewriting history", () => {
    const owner = project("source", {
      campaignStrategyBatchIds: ["batch-1"],
      strategyOrigin: { batchId: "batch-1", conceptId: "concept-1", conceptRevisionId: "revision-1" }
    });
    const sibling = project("sibling", {
      strategyOrigin: { batchId: "batch-1", conceptId: "concept-2", conceptRevisionId: "revision-2" }
    });
    const grouped = groupProjectsIntoCampaigns([sibling, owner], () => "Pet Address Sign");
    expect(grouped).toMatchObject([{ kind: "CAMPAIGN", owner: { id: "source" }, projects: [{ id: "sibling" }, { id: "source" }] }]);
  });

  it("shows a new Campaign before any concepts are handed off", () => {
    const owner = project("source", { campaignWorkspace: true });
    const grouped = groupProjectsIntoCampaigns([owner], () => "Pet Address Sign");
    expect(grouped).toMatchObject([{ kind: "CAMPAIGN", owner: { id: "source" }, projects: [] }]);
  });

  it("keeps multiple Strategy batches under their one Campaign owner", () => {
    const owner = project("source", { campaignWorkspace: true });
    const grouped = groupProjectsIntoCampaigns([owner,
      project("one", { strategyOrigin: { batchId: "batch-1", conceptId: "concept-1", conceptRevisionId: "revision-1", sourceProjectId: owner.id } }),
      project("two", { strategyOrigin: { batchId: "batch-2", conceptId: "concept-2", conceptRevisionId: "revision-2", sourceProjectId: owner.id } })
    ], () => "Pet Address Sign");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "CAMPAIGN", owner: { id: "source" }, projects: [{ id: "one" }, { id: "two" }] });
  });

  it("folds legacy batch-only executions into a source Campaign identified by a newer batch", () => {
    const owner = project("source", {
      campaignWorkspace: true,
      campaignStrategyBatchIds: ["legacy-batch", "new-batch"],
      strategyOrigin: { batchId: "legacy-batch", conceptId: "legacy-one", conceptRevisionId: "legacy-revision-one" }
    });
    const grouped = groupProjectsIntoCampaigns([
      project("new-two", { strategyOrigin: { batchId: "new-batch", conceptId: "new-two", conceptRevisionId: "new-revision-two", sourceProjectId: owner.id } }),
      owner,
      project("legacy-two", { strategyOrigin: { batchId: "legacy-batch", conceptId: "legacy-two", conceptRevisionId: "legacy-revision-two" } }),
      project("new-one", { strategyOrigin: { batchId: "new-batch", conceptId: "new-one", conceptRevisionId: "new-revision-one", sourceProjectId: owner.id } })
    ], () => "Pet Address Sign");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "CAMPAIGN", owner: { id: "source" } });
    if (grouped[0]?.kind !== "CAMPAIGN") throw new Error("Expected campaign");
    expect(grouped[0].projects.map((item) => item.id)).toEqual(["new-two", "source", "legacy-two", "new-one"]);
  });

  it("keeps direct Video Maker projects at the top level", () => {
    const grouped = groupProjectsIntoCampaigns([
      project("direct"),
      project("strategy", { strategyOrigin: { batchId: "batch-1", conceptId: "concept-1", conceptRevisionId: "revision-1" } })
    ], () => "Pet Address Sign");
    expect(grouped.map((item) => item.kind)).toEqual(["PROJECT", "CAMPAIGN"]);
  });

  it("does not combine different Strategy batches for the same Product", () => {
    const grouped = groupProjectsIntoCampaigns([
      project("one", { strategyOrigin: { batchId: "batch-1", conceptId: "concept-1", conceptRevisionId: "revision-1" } }),
      project("two", { strategyOrigin: { batchId: "batch-2", conceptId: "concept-2", conceptRevisionId: "revision-2" } })
    ], () => "Pet Address Sign");
    expect(grouped).toHaveLength(2);
    expect(grouped.every((item) => item.kind === "CAMPAIGN")).toBe(true);
  });

  it("uses the immutable Strategy name and falls back to the Creative Brief topic", () => {
    expect(projectConceptName(project("one", {
      creativeBrief: { creativeTopic: "Fallback Name: fallback angle" },
      creativeInputSnapshot: { input: { selectedStrategy: { conceptName: "Canonical Name" } } }
    }))).toBe("Canonical Name");
    expect(projectConceptName(project("two", { creativeBrief: { creativeTopic: "Fallback Name: fallback angle" } }))).toBe("Fallback Name");
  });
});
