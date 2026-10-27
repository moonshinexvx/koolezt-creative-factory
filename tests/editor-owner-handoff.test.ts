import { afterEach, describe, expect, it } from "vitest";
import type { CreativeProject } from "@koolezt/domain";
import { fixture } from "./support/factory-fixture.js";

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

async function createScenesInReview() {
  const setup = await fixture();
  disposals.push(setup.dispose);
  let project = await setup.service.createProject({
    productId: setup.product.id,
    selectedProductAssetIds: ["mockup-1"],
    preferredVoiceProfileId: "marin",
    actor: "editor"
  });
  project = await setup.service.generateConcept(project.id, "editor");
  project = await setup.service.approveConcept(project.id, "editor");
  for (const scene of project.scenes) project = await setup.service.setSceneGenerationMethod(project.id, scene.id, "API", "editor");
  await setup.service.processAllPendingJobs(project.id);
  return { ...setup, project: await setup.service.getProject(project.id) };
}

async function acceptAllScenes(setup: Awaited<ReturnType<typeof createScenesInReview>>): Promise<CreativeProject> {
  let project = setup.project;
  for (const scene of project.scenes) {
    const current = (await setup.service.getProject(project.id)).scenes.find((candidate) => candidate.id === scene.id)!;
    project = await setup.service.approveScene(project.id, scene.id, current.attempts.at(-1)!.id, "editor");
  }
  return project;
}

async function acceptVoice(setup: Awaited<ReturnType<typeof createScenesInReview>>, project: CreativeProject): Promise<CreativeProject> {
  project = await setup.service.generateVoice(project.id, "editor");
  await setup.service.processAllPendingJobs(project.id);
  project = await setup.service.getProject(project.id);
  return setup.service.approveVoice(project.id, project.currentVoiceGenerationId!, "editor");
}

describe("editor to owner render handoff", () => {
  it("blocks editor completion until all scenes and voice are accepted and QA-passed", async () => {
    const setup = await createScenesInReview();
    await expect(setup.service.markEditorWorkComplete(setup.project.id, "editor")).rejects.toThrow("Mark editor work complete is not allowed");

    const scenesAccepted = await acceptAllScenes(setup);
    expect(scenesAccepted.state).toBe("VOICE_REVIEW");
    await expect(setup.service.markEditorWorkComplete(scenesAccepted.id, "editor")).rejects.toThrow("accepted QA-passed narration");
  });

  it("marks editor work complete without creating a render and requires an explicit owner render action", async () => {
    const setup = await createScenesInReview();
    let project = await acceptAllScenes(setup);
    project = await acceptVoice(setup, project);
    expect(project.state).toBe("VOICE_REVIEW");
    expect(project.renders).toHaveLength(0);
    expect((await setup.service.listJobs(project.id)).filter((job) => job.type === "COMPOSE_RENDER")).toHaveLength(0);

    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    expect(project.state).toBe("READY_FOR_RENDER");
    expect(project.renders).toHaveLength(0);
    expect(project.auditEvents.at(-1)?.type).toBe("EDITOR_WORK_COMPLETED");
    expect((await setup.service.listJobs(project.id)).filter((job) => job.type === "COMPOSE_RENDER")).toHaveLength(0);
    await expect(setup.service.markEditorWorkComplete(project.id, "editor")).rejects.toThrow("not allowed");

    project = await setup.service.renderFinal(project.id, "owner", "fake");
    expect(project.state).toBe("RENDERING");
    expect(project.renders).toHaveLength(1);
    expect((await setup.service.listJobs(project.id)).filter((job) => job.type === "COMPOSE_RENDER")).toHaveLength(1);
    await expect(setup.service.renderFinal(project.id, "owner", "fake")).rejects.toThrow("not allowed");
    expect((await setup.service.getProject(project.id)).renders).toHaveLength(1);
  });

  it("keeps completed READY projects closed to editor handoff changes", async () => {
    const setup = await createScenesInReview();
    let project = await acceptAllScenes(setup);
    project = await acceptVoice(setup, project);
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "owner", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    project = await setup.service.approveAndSave(project.id, "owner");
    expect(project.state).toBe("READY");
    await expect(setup.service.markEditorWorkComplete(project.id, "editor")).rejects.toThrow("not allowed");
    expect((await setup.service.getProject(project.id)).state).toBe("READY");
  });

  it("keeps a READY published final live while an immutable candidate is rendered, replaced, or discarded", async () => {
    const setup = await createScenesInReview();
    let project = await acceptAllScenes(setup);
    project = await acceptVoice(setup, project);
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "owner", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.approveAndSave(project.id, "owner");
    const publishedRenderId = project.currentRenderId!;
    const publishedReadyFile = project.readyFile!;

    project = await setup.service.renderFinal(project.id, "owner", "fake");
    const candidateId = project.candidateRenderId!;
    expect(project.state).toBe("READY");
    expect(project.currentRenderId).toBe(publishedRenderId);
    expect(project.readyFile).toEqual(publishedReadyFile);
    expect(project.renders).toHaveLength(2);
    const duplicate = await setup.service.renderFinal(project.id, "owner", "fake");
    expect(duplicate.candidateRenderId).toBe(candidateId);
    expect(duplicate.renders).toHaveLength(2);

    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("READY");
    expect(project.currentRenderId).toBe(publishedRenderId);
    expect(project.candidateRenderId).toBe(candidateId);
    expect(project.renders.find((render) => render.id === candidateId)?.status).toBe("SUCCEEDED");

    project = await setup.service.approveAndSave(project.id, "owner");
    expect(project.state).toBe("READY");
    expect(project.currentRenderId).toBe(candidateId);
    expect(project.candidateRenderId).toBeUndefined();
    expect(project.publishedRenderIds).toEqual([publishedRenderId, candidateId]);

    project = await setup.service.renderFinal(project.id, "owner", "fake");
    const discardedCandidateId = project.candidateRenderId!;
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.discardCandidateRender(project.id, "owner");
    expect(project.state).toBe("READY");
    expect(project.currentRenderId).toBe(candidateId);
    expect(project.candidateRenderId).toBeUndefined();
    expect(project.renders.find((render) => render.id === discardedCandidateId)?.status).toBe("REJECTED");
  });
  it("requires explicit editor submission before owner approval and preserves the exact reviewed candidate", async () => {
    const setup = await createScenesInReview();
    let project = await acceptAllScenes(setup);
    project = await acceptVoice(setup, project);
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "editor", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.getProject(project.id);
    expect(project.state).toBe("FINAL_REVIEW");
    const renderId = project.currentRenderId!;
    const outputSha256 = project.renders.find((render) => render.id === renderId)!.outputSha256;

    project = await setup.service.submitForOwnerReview(project.id, "editor");
    expect(project.state).toBe("OWNER_REVIEW");
    expect(project.ownerReviewRenderId).toBe(renderId);
    expect(project.renders.find((render) => render.id === renderId)?.outputSha256).toBe(outputSha256);

    project = await setup.service.approveAndSave(project.id, "owner");
    expect(project.state).toBe("READY");
    expect(project.currentRenderId).toBe(renderId);
    expect(project.ownerReviewRenderId).toBeUndefined();
  });

  it("lets the owner request another version without deleting accepted scenes, voice, or candidate history", async () => {
    const setup = await createScenesInReview();
    let project = await acceptAllScenes(setup);
    project = await acceptVoice(setup, project);
    const acceptedScenes = project.scenes.map((scene) => scene.approvedAttemptId);
    const acceptedVoice = project.currentVoiceGenerationId;
    project = await setup.service.markEditorWorkComplete(project.id, "editor");
    project = await setup.service.renderFinal(project.id, "editor", "fake");
    await setup.service.processAllPendingJobs(project.id);
    project = await setup.service.submitForOwnerReview(project.id, "editor");
    const candidateId = project.ownerReviewRenderId!;

    project = await setup.service.requestAnotherVersion(project.id, "owner");
    expect(project.state).toBe("READY_FOR_RENDER");
    expect(project.ownerReviewRenderId).toBeUndefined();
    expect(project.currentVoiceGenerationId).toBe(acceptedVoice);
    expect(project.scenes.map((scene) => scene.approvedAttemptId)).toEqual(acceptedScenes);
    expect(project.renders.find((render) => render.id === candidateId)?.status).toBe("REJECTED");
  });
});
