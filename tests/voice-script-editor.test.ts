import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "./support/factory-fixture.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map((dispose) => dispose())); });

async function projectAtVoiceReview() {
  const setup = await fixture(); disposals.push(setup.dispose);
  let project = await setup.service.createProject({ productId: setup.product.id, selectedProductAssetIds: ["mockup-1"], preferredVoiceProfileId: "marin", actor: "editor" });
  project = await setup.service.generateConcept(project.id, "editor");
  project = await setup.service.approveConcept(project.id, "editor");
  for (const scene of project.scenes) project = await setup.service.setSceneGenerationMethod(project.id, scene.id, "API", "editor");
  await setup.service.processAllPendingJobs(project.id);
  for (const scene of (await setup.service.getProject(project.id)).scenes) {
    const current = (await setup.service.getProject(project.id)).scenes.find((item) => item.id === scene.id)!;
    project = await setup.service.approveScene(project.id, scene.id, current.attempts.at(-1)!.id, "editor");
  }
  return { ...setup, project: await setup.service.getProject(project.id) };
}

async function readyProject() {
  const setup = await projectAtVoiceReview();
  let project = await setup.service.generateVoice(setup.project.id, "editor");
  await setup.service.processAllPendingJobs(project.id);
  project = await setup.service.getProject(project.id);
  project = await setup.service.approveVoice(project.id, project.currentVoiceGenerationId!, "editor");
  project = await setup.service.markEditorWorkComplete(project.id, "editor");
  project = await setup.service.renderFinal(project.id, "owner", "fake");
  await setup.service.processAllPendingJobs(project.id);
  project = await setup.service.approveAndSave(project.id, "owner");
  return { ...setup, project };
}

describe("voice script revisions and timing fit", () => {
  it("persists free manual scripts without provider calls, then explicitly rewrites and generates immutable attempts", async () => {
    const setup = await projectAtVoiceReview();
    const initialCreativeCalls = setup.creativeProvider.calls.length;
    const initialVoiceSubmissions = setup.voiceProvider.submissions.length;
    const script = "Turn your favorite pet photo into a Christmas keepsake made just for them. Add their name and create a personalized ornament you will love seeing on the tree.";

    let project = await setup.service.saveNarrationScript(setup.project.id, script, "editor");
    expect(project.narrationRevisions).toHaveLength(1);
    expect(project.narrationRevisions?.[0]).toMatchObject({ script, source: "MANUAL" });
    expect(setup.creativeProvider.calls).toHaveLength(initialCreativeCalls);
    expect(setup.voiceProvider.submissions).toHaveLength(initialVoiceSubmissions);

    project = await setup.service.rewriteNarrationToFit(project.id, script, "editor");
    expect(project.narrationRevisions).toHaveLength(2);
    expect(project.narrationRevisions?.at(-1)).toMatchObject({ source: "AI_REWRITE", script, parentRevisionId: project.narrationRevisions?.[0]?.id });
    expect(setup.creativeProvider.calls).toHaveLength(initialCreativeCalls + 1);
    expect(setup.voiceProvider.submissions).toHaveLength(initialVoiceSubmissions);

    project = await setup.service.generateVoice(project.id, "editor", { script });
    const attemptId = project.currentVoiceGenerationId!;
    expect(project.voiceGenerations.at(-1)).toMatchObject({ id: attemptId, sourceScript: script, narrationRevisionId: project.currentNarrationRevisionId });
    const duplicateInitialGeneration = await setup.service.generateVoice(project.id, "editor", { script });
    expect(duplicateInitialGeneration.voiceGenerations).toHaveLength(1);
    expect(duplicateInitialGeneration.currentVoiceGenerationId).toBe(attemptId);
    expect(setup.voiceProvider.submissions).toHaveLength(initialVoiceSubmissions);
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.voiceGenerations.find((voice) => voice.id === attemptId)?.inspection).toMatchObject({ passed: true, durationMs: 1 });
    project = await setup.service.approveVoice(project.id, attemptId, "editor");
    expect(project.currentVoiceGenerationId).toBe(attemptId);
  });

  it("keeps a READY published final intact while a candidate voice is generated, rejected, accepted, and snapshotted", async () => {
    const setup = await readyProject();
    const publishedRenderId = setup.project.currentRenderId!;
    const publishedVoiceId = setup.project.currentVoiceGenerationId!;
    const publishedSnapshotVoiceId = setup.project.renders.find((render) => render.id === publishedRenderId)!.inputSnapshot.narration.voiceGenerationId;
    const revised = "A warm personalized keepsake made from your favorite pet photo. Add their name and make this Christmas ornament a treasured part of your tree.";

    let project = await setup.service.saveNarrationScript(setup.project.id, revised, "owner");
    expect(project.state).toBe("READY");
    expect(project.currentVoiceGenerationId).toBe(publishedVoiceId);
    expect(project.currentRenderId).toBe(publishedRenderId);

    project = await setup.service.generateVoice(project.id, "owner", { script: revised });
    const candidateVoiceId = project.candidateVoiceGenerationId!;
    expect(project.state).toBe("READY");
    expect(project.currentVoiceGenerationId).toBe(publishedVoiceId);
    expect(project.voiceGenerations).toHaveLength(2);
    const duplicate = await setup.service.generateVoice(project.id, "owner", { script: revised });
    expect(duplicate.voiceGenerations).toHaveLength(2);
    expect(duplicate.candidateVoiceGenerationId).toBe(candidateVoiceId);

    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("READY");
    expect(project.currentVoiceGenerationId).toBe(publishedVoiceId);
    expect(project.voiceGenerations.find((voice) => voice.id === candidateVoiceId)?.status).toBe("REVIEW");
    project = await setup.service.rejectVoice(project.id, candidateVoiceId, "owner");
    expect(project.currentVoiceGenerationId).toBe(publishedVoiceId);
    expect(project.candidateVoiceGenerationId).toBeUndefined();

    project = await setup.service.generateVoice(project.id, "owner", { script: revised });
    const acceptedVoiceId = project.candidateVoiceGenerationId!;
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    project = await setup.service.approveVoice(project.id, acceptedVoiceId, "owner");
    expect(project.state).toBe("READY");
    expect(project.currentVoiceGenerationId).toBe(acceptedVoiceId);
    expect(project.currentRenderId).toBe(publishedRenderId);
    expect(project.renders.find((render) => render.id === publishedRenderId)?.inputSnapshot.narration.voiceGenerationId).toBe(publishedSnapshotVoiceId);

    project = await setup.service.renderFinal(project.id, "owner", "fake");
    const candidateRender = project.renders.find((render) => render.id === project.candidateRenderId)!;
    expect(candidateRender.voiceGenerationId).toBe(acceptedVoiceId);
    expect(candidateRender.inputSnapshot.narration.voiceGenerationId).toBe(acceptedVoiceId);
    expect(candidateRender.inputSnapshot.narration.assetId).toBe(project.voiceGenerations.find((voice) => voice.id === acceptedVoiceId)?.outputAssetId);
  });
});