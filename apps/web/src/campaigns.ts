export type CampaignProject = Readonly<{
  id: string;
  publicId: string;
  productId: string;
  state: string;
  creativeBrief?: Readonly<{ creativeTopic?: string }>;
  campaignWorkspace?: boolean;
  campaignStrategyBatchIds?: readonly string[];
  creativeInputSnapshot?: Readonly<{ input?: Readonly<{ selectedStrategy?: Readonly<{ conceptName?: string }> }> }>;
  strategyOrigin?: Readonly<{ batchId: string; conceptId: string; conceptRevisionId: string; sourceProjectId?: string }>;
}>;

export type ProjectCampaign = Readonly<{
  kind: "CAMPAIGN";
  id: string;
  batchId: string;
  productId: string;
  productName: string;
  owner?: CampaignProject;
  projects: readonly CampaignProject[];
}>;

export type ProjectBrowserItem = ProjectCampaign | Readonly<{ kind: "PROJECT"; project: CampaignProject }>;

export const projectConceptName = (project: CampaignProject): string => {
  const canonical = project.creativeInputSnapshot?.input?.selectedStrategy?.conceptName?.trim();
  if (canonical) return canonical;
  const topic = project.creativeBrief?.creativeTopic?.trim();
  if (!topic) return "Video Maker execution";
  return topic.split(":", 1)[0]?.trim() || topic;
};

/** Keep execution records isolated while presenting one Campaign per Strategy batch. */
export function groupProjectsIntoCampaigns(
  projects: readonly CampaignProject[],
  productNameFor: (productId: string) => string
): readonly ProjectBrowserItem[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const explicitSourceIds = new Set(
    projects.flatMap((project) => project.strategyOrigin?.sourceProjectId ? [project.strategyOrigin.sourceProjectId] : [])
  );
  // Historical executions did not persist sourceProjectId. Once a later batch
  // identifies the source workspace, its recorded batch history is the stable
  // compatibility bridge into the same Campaign container.
  const legacyBatchCampaignKeys = new Map<string, string>();
  for (const sourceId of explicitSourceIds) {
    const source = projectById.get(sourceId);
    const key = `source:${sourceId}`;
    for (const batchId of source?.campaignStrategyBatchIds ?? []) legacyBatchCampaignKeys.set(batchId, key);
    if (source?.strategyOrigin?.batchId) legacyBatchCampaignKeys.set(source.strategyOrigin.batchId, key);
  }
  const campaignKeyFor = (project: CampaignProject) => {
    const origin = project.strategyOrigin;
    if (origin?.sourceProjectId) return `source:${origin.sourceProjectId}`;
    if (origin?.batchId && legacyBatchCampaignKeys.has(origin.batchId)) return legacyBatchCampaignKeys.get(origin.batchId);
    return origin ? `batch:${origin.batchId}` : undefined;
  };
  const campaignChildren = new Map<string, CampaignProject[]>();
  const batchIds = new Map<string, string>();
  for (const project of projects) {
    const key = campaignKeyFor(project);
    if (!key) continue;
    const children = campaignChildren.get(key);
    if (children) children.push(project); else campaignChildren.set(key, [project]);
    if (!batchIds.has(key)) batchIds.set(key, project.strategyOrigin!.batchId);
  }
  const sourceCampaignKeys = new Map(
    [...campaignChildren.keys()].filter((key) => key.startsWith("source:")).map((key) => [key.slice("source:".length), key])
  );
  const order: Array<Readonly<{ kind: "CAMPAIGN" | "PROJECT"; id: string }>> = [];
  const emittedCampaigns = new Set<string>();
  for (const project of projects) {
    const key = campaignKeyFor(project) ?? sourceCampaignKeys.get(project.id) ?? (project.campaignWorkspace ? `source:${project.id}` : undefined);
    if (!key) { order.push({ kind: "PROJECT", id: project.id }); continue; }
    if (!emittedCampaigns.has(key)) { order.push({ kind: "CAMPAIGN", id: key }); emittedCampaigns.add(key); }
  }
  return order.flatMap((entry): ProjectBrowserItem[] => {
    if (entry.kind === "PROJECT") {
      const project = projectById.get(entry.id);
      return project ? [{ kind: "PROJECT", project }] : [];
    }
    const children = campaignChildren.get(entry.id) ?? [];
    const sourceId = entry.id.startsWith("source:") ? entry.id.slice("source:".length) : undefined;
    const legacyBatchId = entry.id.startsWith("batch:") ? entry.id.slice("batch:".length) : undefined;
    const owner = sourceId
      ? projectById.get(sourceId)
      : legacyBatchId
        ? projects.find((project) => project.campaignStrategyBatchIds?.includes(legacyBatchId))
        : undefined;
    const first = owner ?? children[0];
    const batchId = batchIds.get(entry.id) ?? `workspace:${first?.id ?? entry.id}`;
    return first ? [{ kind: "CAMPAIGN", id: `campaign:${entry.id}`, batchId, productId: first.productId, productName: productNameFor(first.productId), ...(owner ? { owner } : {}), projects: children }] : [];
  });
}
