import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CreativeDnaService, CreativeFactoryService, CreativeStrategyService, canonicalizeCreativeDna } from "@koolezt/application";
import { InMemoryCreativeDnaStore, InMemoryCreativeStrategyStore, InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { creativeDnaSampleTimestamps, FakeExternalMediaDeliveryProvider, FfmpegCreativeDnaPreprocessor, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";
import { DomainError } from "@koolezt/domain";
import type { CreativeDnaAnalysisInput, CreativeDnaPreprocessor, CreativeProvider, GeneratedAsset } from "@koolezt/domain";

const mediaMetadata = { durationMs: 15_000, width: 720, height: 1280, frameRate: 30, hasAudio: true, mimeType: "video/mp4" };
const frames = [
  { timestampMs: 0, mimeType: "image/jpeg" as const, bytesBase64: "a", sha256: "first-frame" },
  { timestampMs: 14_900, mimeType: "image/jpeg" as const, bytesBase64: "b", sha256: "last-frame" }
];
const preprocessor: CreativeDnaPreprocessor = { async preprocess(asset: GeneratedAsset) { void asset; return { mediaMetadata, frames }; } };

async function harness(provider: CreativeProvider = new FakeCreativeProvider()) {
  const root = await mkdtemp(join(tmpdir(), "creative-dna-"));
  const repository = new InMemoryFactoryRepository();
  const strategies = new InMemoryCreativeStrategyStore(repository);
  const dna = new InMemoryCreativeDnaStore();
  const storage = new LocalStorageProvider(join(root, "media"));
  const videoProvider = new FakeVideoGenerationProvider();
  const voiceProvider = new FakeVoiceProvider();
  const compositionProvider = new FakeCompositionProvider();
  const factory = new CreativeFactoryService({
    repository, strategyRepository: strategies, creativeDnaRepository: dna, creativeProvider: provider,
    videoProvider, voiceProvider, compositionProvider, externalMediaDelivery: new FakeExternalMediaDeliveryProvider(),
    compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage,
    mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  const strategy = new CreativeStrategyService({ repository, strategies, creativeDna: dna, creativeProvider: provider });
  const service = new CreativeDnaService({ repository, dna, provider, storage, preprocessor });
  const project = await factory.createProjectFromBrief({
    requestId: crypto.randomUUID(), name: "Personalized address sign", creativeTopic: "Distinct advertising",
    productDetails: "A personalized address sign using supplied reference images.",
    verifiedClaims: ["Displays operator-supplied address numbers"], targetDurationSeconds: 15, actor: "editor"
  });
  const asset = await storage.put("history/winner.mp4", { bytes: new Uint8Array([0, 1, 2]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
  return { root, repository, strategies, dna, storage, factory, strategy, service, provider, videoProvider, voiceProvider, compositionProvider, project, asset, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function register(setup: Awaited<ReturnType<typeof harness>>) {
  return setup.service.register({
    projectId: setup.project.id, assetId: setup.asset.id, displayName: "Historical winner A",
    operatorStatus: "WINNER", actor: "owner", platform: "Meta", dateStart: "2025-01-01", dateEnd: "2025-01-31",
    operatorTranscript: "Optional operator transcript.", performance: { spend: 100, purchases: 4, purchaseCpa: 25, currency: "USD", metricSource: "operator supplied" }
  });
}

describe("Winning Creative DNA", () => {
  it("registers a historical video without automatically running paid analysis", async () => {
    const provider = new FakeCreativeProvider();
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      expect(reference).toMatchObject({ analysisStatus: "NOT_ANALYZED", operatorStatus: "WINNER", platform: "Meta" });
      expect(provider.calls).toHaveLength(0);
      expect((await setup.dna.listReferences())[0]!.revisions).toHaveLength(0);
    } finally { await setup.dispose(); }
  });

  it("keeps Winning Creative and approved DNA isolated to their owning Campaign", async () => {
    const setup = await harness(new FakeCreativeProvider());
    try {
      const first = await register(setup);
      const secondProject = await setup.factory.createProjectFromBrief({
        requestId: crypto.randomUUID(), name: "Second campaign", creativeTopic: "A separate direction",
        productDetails: "A different campaign Product.", verifiedClaims: [], targetDurationSeconds: 15, actor: "editor"
      });
      const secondAsset = await setup.storage.put("history/second-winner.mp4", { bytes: new Uint8Array([3, 4, 5]), mimeType: "video/mp4", extension: "mp4", metadata: {} });
      const second = await setup.service.register({ projectId: secondProject.id, assetId: secondAsset.id, displayName: "Second campaign winner", operatorStatus: "WINNER", actor: "owner" });

      expect((await setup.service.list(setup.project.id)).map((entry) => entry.reference.id)).toEqual([first.id]);
      expect((await setup.service.list(secondProject.id)).map((entry) => entry.reference.id)).toEqual([second.id]);

      for (const reference of [first, second]) {
        const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
        await setup.service.processJob(job.id);
        const revision = (await setup.service.list(reference.sourceProjectId))[0]!.revisions[0]!;
        await setup.service.approve(reference.id, revision.id, "owner");
      }
      expect((await setup.service.listApproved(undefined, setup.project.id)).map((entry) => entry.reference.id)).toEqual([first.id]);
      expect((await setup.service.listApproved(undefined, secondProject.id)).map((entry) => entry.reference.id)).toEqual([second.id]);
    } finally { await setup.dispose(); }
  });

  it("uses bounded hook-heavy frame sampling and always includes a final frame", () => {
    const timestamps = creativeDnaSampleTimestamps(30_000);
    expect(timestamps.length).toBeLessThanOrEqual(30);
    expect(timestamps.filter((value) => value <= 3_000).length).toBeGreaterThanOrEqual(7);
    expect(timestamps[0]).toBe(0);
    expect(timestamps.at(-1)).toBe(29_900);
  });

  it("extracts objective media metadata and bounded timestamped frames with local FFmpeg", async () => {
    const root = await mkdtemp(join(tmpdir(), "creative-dna-media-"));
    try {
      const storage = new LocalStorageProvider(root);
      const fixture = await readFile("tests/fixtures/vertical-1080x1920.mp4");
      const asset = await storage.put("history/fixture.mp4", { bytes: fixture, mimeType: "video/mp4", extension: "mp4", metadata: {} });
      const platform = process.platform;
      const architecture = process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64";
      const ffmpeg = resolve(`node_modules/ffmpeg-static/ffmpeg${platform === "win32" ? ".exe" : ""}`);
      const ffprobe = resolve(`node_modules/ffprobe-static/bin/${platform}/${architecture}/ffprobe${platform === "win32" ? ".exe" : ""}`);
      const result = await new FfmpegCreativeDnaPreprocessor(storage, ffmpeg, ffprobe).preprocess(asset);
      expect(result.mediaMetadata).toMatchObject({ width: 1080, height: 1920, hasAudio: true, mimeType: "video/mp4" });
      expect(result.mediaMetadata.durationMs).toBeGreaterThan(14_000);
      expect(result.frames.length).toBeLessThanOrEqual(30);
      expect(result.pacing).toMatchObject({ shotCount: (result.pacing?.sceneCutsMs.length ?? 0) + 1, detectionThreshold: 0.3 });
      expect(result.audioTranscript).toEqual({ status: "DISABLED" });
      expect(result.frames.filter((frame) => frame.timestampMs <= 3_000).length).toBeGreaterThanOrEqual(7);
      expect(result.frames.every((frame) => frame.sha256.length === 64 && frame.bytesBase64.length > 0)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("runs analysis only after the explicit action and persists a structured draft", async () => {
    const provider = new FakeCreativeProvider();
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      expect(provider.calls).toHaveLength(0);
      expect((await setup.service.processJob(job.id)).status).toBe("COMPLETED");
      expect(provider.calls).toHaveLength(1);
      const record = (await setup.service.list())[0]!;
      expect(record.reference.analysisStatus).toBe("DRAFT");
      expect(record.revisions[0]).toMatchObject({ revision: 1, status: "DRAFT", source: "AI_PROVIDER", openingProductVisible: true });
      expect(record.revisions[0]!.sourceEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ timestampMs: 0, frameSha256: "first-frame" }),
        expect.objectContaining({ timestampMs: 14_900, frameSha256: "last-frame" })
      ]));
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    } finally { await setup.dispose(); }
  });

  it("resumes polling a known response without creating another paid response", async () => {
    const base = new FakeCreativeProvider();
    let creates = 0;
    let retrieves = 0;
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitCreativeDnaAnalysis: async () => { creates += 1; return { responseId: "resp-known", status: "queued", provider: "fake-openai", model: "fake-dna" }; },
      retrieveCreativeDnaAnalysis: async (responseId) => {
        void responseId;
        retrieves += 1;
        const input: CreativeDnaAnalysisInput = { referenceId: "r", displayName: "winner", mediaMetadata, frames };
        const completed = await base.submitCreativeDnaAnalysis!(input, { operationKey: "completion", projectId: "p", targetId: "r" });
        return { ...completed, responseId: "resp-known" };
      }
    };
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      const completed = await setup.service.processJob(job.id);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.lastError).toBeUndefined();
      expect((await setup.repository.getJob(job.id)).lastError).toBeUndefined();
      expect({ creates, retrieves }).toEqual({ creates: 1, retrieves: 1 });
    } finally { await setup.dispose(); }
  });

  it.each([
    {
      name: "terminal provider failure",
      submit: async () => ({ responseId: "resp-failed", status: "failed" as const, provider: "fake-openai", model: "fake-dna", safeError: { code: "PROVIDER_FAILED", message: "Safe provider failure." } }),
      expectedReferenceStatus: "FAILED",
      expectedError: "Creative DNA provider did not complete successfully."
    },
    {
      name: "ambiguous submission before a response ID",
      submit: async () => { throw new DomainError("OPENAI_DNA_SUBMISSION_UNKNOWN", "Creative DNA submission outcome is unknown; do not retry automatically."); },
      expectedReferenceStatus: "SUBMISSION_UNKNOWN",
      expectedError: "Creative DNA submission outcome is unknown"
    }
  ])("retains a safe last_error for $name", async ({ submit, expectedReferenceStatus, expectedError }) => {
    const base = new FakeCreativeProvider();
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitCreativeDnaAnalysis: submit,
      retrieveCreativeDnaAnalysis: base.retrieveCreativeDnaAnalysis.bind(base)
    };
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      const failed = await setup.service.processJob(job.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.lastError).toContain(expectedError);
      expect((await setup.repository.getJob(job.id)).lastError).toContain(expectedError);
      expect((await setup.dna.getReference(reference.id)).analysisStatus).toBe(expectedReferenceStatus);
    } finally { await setup.dispose(); }
  });

  it("retains RESULT_UNAVAILABLE context for a known response that can no longer be retrieved", async () => {
    const base = new FakeCreativeProvider();
    let creates = 0;
    const provider: CreativeProvider = {
      generateConcept: base.generateConcept.bind(base),
      submitCreativeDnaAnalysis: async () => { creates += 1; return { responseId: "resp-lost", status: "queued", provider: "fake-openai", model: "fake-dna" }; },
      retrieveCreativeDnaAnalysis: async () => { throw new DomainError("PROVIDER_DNA_RESULT_UNAVAILABLE", "The known Creative DNA response is no longer retrievable; it will not be resubmitted."); }
    };
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      expect((await setup.service.processJob(job.id)).status).toBe("PENDING");
      const failed = await setup.service.processJob(job.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.lastError).toContain("no longer retrievable");
      expect((await setup.repository.getJob(job.id)).lastError).toContain("no longer retrievable");
      expect((await setup.dna.getReference(reference.id)).analysisStatus).toBe("RESULT_UNAVAILABLE");
      expect(creates).toBe(1);
    } finally { await setup.dispose(); }
  });

  it("creates editable revisions and never mutates an approved revision", async () => {
    const setup = await harness();
    try {
      const reference = await register(setup);
      const job = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      await setup.service.processJob(job.id);
      const first = (await setup.service.list())[0]!.revisions[0]!;
      const approved = await setup.service.approve(reference.id, first.id, "owner");
      const edited = await setup.service.edit(reference.id, { ...approved, openingPattern: "Operator-corrected product opening" }, "owner");
      expect(approved).toMatchObject({ revision: 1, status: "APPROVED", openingPattern: "Product-led opening" });
      expect(edited).toMatchObject({ revision: 2, status: "DRAFT", openingPattern: "Operator-corrected product opening" });
      expect(await setup.dna.getRevision(first.id)).toMatchObject({ status: "APPROVED", openingPattern: "Product-led opening" });
    } finally { await setup.dispose(); }
  });

  it("keeps historical offer text and visual observations out of current Product truth", () => {
    const input: CreativeDnaAnalysisInput = { referenceId: "r", displayName: "Old winner", mediaMetadata, frames, currentProduct: { name: "Sign", description: "Current product", verifiedClaims: [] } };
    const raw = {
      openingPattern: "Old price appears immediately", openingProductVisible: true, visualHookMechanism: "$31.49 overlay",
      productProminence: "High", personalizationVisibility: "Visible", repeatedExamplePattern: "Three examples", pacingPattern: "Fast",
      beatStructure: "Hook to CTA", overlayTextPattern: "10% OFF remains visible", offerVisibilityPattern: "Old offer visible",
      ctaPattern: "Shop now", proofPattern: "Visual examples", visualFormat: "Vertical", lifestyleVsProductBalance: "Product-led",
      soundOffComprehension: "High", directResponsePattern: "Direct", closingPattern: "CTA", preserveTraits: ["Prominent offer treatment"],
      safeToVaryTraits: ["Current offer content"], avoidTraits: [], sourceEvidence: [{ kind: "VISIBLE_TEXT", observation: "$31.49 and 10% OFF are visible historical text" }]
    };
    const result = canonicalizeCreativeDna(raw, input);
    expect(result.offerVisibilityPattern).toContain("Old offer");
    expect(input.currentProduct!.verifiedClaims).toEqual([]);
    expect(result).not.toHaveProperty("verifiedClaims");
  });
  it("blocks unsupported Winner variation before creating a provider job or paid submission", async () => {
    const provider=new FakeCreativeProvider();
    const setup=await harness(provider);
    try{
      const reference=await register(setup);
      const dnaJob=await setup.service.requestAnalysis(reference.id,crypto.randomUUID());
      await setup.service.processJob(dnaJob.id);
      const dnaDraft=(await setup.service.list())[0]!.revisions[0]!;
      const approved=await setup.service.approve(reference.id,dnaDraft.id,"owner");
      const batch=await setup.strategy.createBatch(setup.project.id,crypto.randomUUID(),"owner",3);
      const strategyJob=(await setup.repository.listJobs(setup.project.id)).find((item)=>item.type==="GENERATE_STRATEGY")!;
      await setup.strategy.processJob(strategyJob.id);
      const concept=(await setup.strategies.listConcepts(batch.id))[0]!;
      const [project]=await setup.strategy.handoff(batch.id,[concept.currentRevision.id],crypto.randomUUID(),"owner",approved.id);
      const callsBefore=provider.calls.length;
      await expect(setup.factory.generateConcept(project!.id,"owner")).rejects.toMatchObject({code:"CONCEPT_EXECUTION_UNSUPPORTED"});
      expect((await setup.repository.listJobs(project!.id)).filter((item)=>item.type==="GENERATE_CONCEPT")).toHaveLength(0);
      expect((await setup.repository.getProject(project!.id)).state).toBe("DRAFT");
      expect(provider.calls).toHaveLength(callsBefore);
      expect(setup.videoProvider.submissions).toHaveLength(0);
      expect(setup.voiceProvider.submissions).toHaveLength(0);
      expect(setup.compositionProvider.submissions).toHaveLength(0);
    }finally{await setup.dispose();}
  });


  it("links one approved DNA revision to handoff while Strategy remains authoritative", async () => {
    const provider = new FakeCreativeProvider();
    const setup = await harness(provider);
    try {
      const reference = await register(setup);
      const dnaJob = await setup.service.requestAnalysis(reference.id, crypto.randomUUID());
      await setup.service.processJob(dnaJob.id);
      const dnaDraft = (await setup.service.list())[0]!.revisions[0]!;
      const compatibleDraft = await setup.service.edit(reference.id, { ...dnaDraft, openingProductVisible:false, repeatedExamplePattern:"", approximateExampleCount:1, preserveTraits:["Direct-response simplicity"] }, "owner");
      const approved = await setup.service.approve(reference.id, compatibleDraft.id, "owner");
      const batch = await setup.strategy.createBatch(setup.project.id, crypto.randomUUID(), "owner", 3);
      const strategyJob = (await setup.repository.listJobs(setup.project.id)).find((item) => item.type === "GENERATE_STRATEGY")!;
      await setup.strategy.processJob(strategyJob.id);
      const concept = (await setup.strategies.listConcepts(batch.id))[0]!;
      const handoffRequestId=crypto.randomUUID();
      const callsBeforeHandoff=provider.calls.length;
      const [project] = await setup.strategy.handoff(batch.id, [concept.currentRevision.id], handoffRequestId, "owner", approved.id);
      const [duplicate] = await setup.strategy.handoff(batch.id, [concept.currentRevision.id], handoffRequestId, "owner", approved.id);
      expect(project!.strategyOrigin!.conceptRevisionId).toBe(concept.currentRevision.id);
      expect(project!.winnerDnaOrigin).toMatchObject({ creativeReferenceId: reference.id, revisionId: approved.id });
      expect(project!.creativeInputSnapshot).toMatchObject({
        id: duplicate!.creativeInputSnapshot!.id,
        sha256: duplicate!.creativeInputSnapshot!.sha256,
        input: {
          selectedStrategy: { id: concept.currentRevision.id, coreAngle: concept.currentRevision.coreAngle },
          selectedWinnerDna: { id: approved.id, revisionSha256: project!.winnerDnaOrigin!.revisionSha256 },
          productionCapabilities: []
        }
      });
      expect(project!.creativeInputSnapshot!.sha256).toHaveLength(64);
      expect(project!.creativeInputSnapshot!.input.claims.some((claim)=>claim.text.includes("$31.49")||claim.text.includes("10% OFF"))).toBe(false);
      expect(project!.concepts).toHaveLength(0);
      expect(provider.calls).toHaveLength(callsBeforeHandoff);
      const replacement = await setup.service.edit(reference.id, { ...approved, openingPattern: "New future reference revision" }, "owner");
      await setup.service.approve(reference.id, replacement.id, "owner");
      expect((await setup.dna.getRevision(approved.id)).status).toBe("ARCHIVED");
      expect((await setup.repository.getProject(project!.id)).creativeInputSnapshot).toEqual(project!.creativeInputSnapshot);
      await setup.factory.generateConcept(project!.id, "owner");
      const conceptJob=(await setup.repository.listJobs(project!.id)).find((item)=>item.type==="GENERATE_CONCEPT")!;
      await setup.factory.processJob(conceptJob.id);
      const generated = await setup.repository.getProject(project!.id);
      const generatedConcept = generated.concepts.find((item) => item.id === generated.currentConceptId)!;
      expect(generatedConcept.inputSnapshot.selectedStrategy!.coreAngle).toBe(concept.currentRevision.coreAngle);
      expect(generatedConcept.inputSnapshot.selectedWinnerDna).toMatchObject({
        id: approved.id, preserveTraits: approved.preserveTraits, safeToVaryTraits: approved.safeToVaryTraits
      });
      expect(generatedConcept.angle).toBe(concept.currentRevision.coreAngle);
    } finally { await setup.dispose(); }
  });
});
