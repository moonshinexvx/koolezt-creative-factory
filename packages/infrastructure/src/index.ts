import { DomainError } from "@koolezt/domain";
import type {
  ConceptProviderOperationEvidence,
  CreativeProject,
  FactoryRepository,
  Product,
  WorkflowJob
} from "@koolezt/domain";

export {
  createDatabase,
  createPostgresPool,
  PostgresFactoryRepository,
  PostgresMediaAssetCatalog,
  PostgresExternalMediaStagingStore,
  PostgresOutboxStore
} from "./postgres.js";
export { PostgresDurableMediaAssetCatalog } from "./durable-media.js";
export {
  createRedisConnection,
  createWorkflowWorker,
  OutboxDispatcher,
  WORKFLOW_QUEUE_NAME
} from "./queue.js";
export {
  DESKTOP_RENDER_PROTOCOL_VERSION,
  DesktopCompositionProvider,
  PostgresDesktopRenderJobStore
} from "./desktop-render.js";
export type { DesktopRenderClaim, DesktopRenderJob, DesktopRenderJobState, DesktopRenderJobStore } from "./desktop-render.js";
export { InMemoryRenderWorkerIdentityStore, PostgresRenderWorkerIdentityStore } from "./render-worker-auth.js";
export { PostgresVariantFactoryStore } from "./variant-factory.js";
export { PostgresProjectArchiveStore } from "./project-archive.js";
export { PostgresVariantCreativePackageStore } from "./variant-creative-packages.js";
export { PostgresCreativeStrategyStore } from "./creative-strategy.js";
export { InMemoryCreativeStrategyStore } from "./creative-strategy-memory.js";
export { PostgresCreativeDnaStore, InMemoryCreativeDnaStore } from "./creative-dna.js";
export type { VariantBatch, VariantBatchStatus, CreativeVariant, CreativeVariantStatus } from "./variant-factory.js";
export type { VariantCreativePackage, VariantPackageRevision, VariantPackageVoice, VariantPackageVoiceStatus, VariantPackageSource } from "./variant-creative-packages.js";
export type { RenderWorkerEnrollment, RenderWorkerEnrollmentResult, RenderWorkerIdentity, RenderWorkerIdentityStore } from "./render-worker-auth.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryFactoryRepository implements FactoryRepository {
  private projectNumber = 0;
  private readonly products = new Map<string, Product>();
  private readonly projects = new Map<string, CreativeProject>();
  private readonly jobs = new Map<string, WorkflowJob>();
  private readonly jobsByDedupeKey = new Map<string, string>();
  private readonly conceptOperations = new Map<string, ConceptProviderOperationEvidence>();

  async nextProjectNumber(): Promise<number> {
    this.projectNumber += 1;
    return this.projectNumber;
  }

  async saveProduct(product: Product): Promise<void> {
    this.products.set(product.id, clone(product));
  }

  async getProduct(id: string): Promise<Product> {
    const product = this.products.get(id);
    if (!product) {
      throw new DomainError("PRODUCT_NOT_FOUND", `Product ${id} was not found.`);
    }
    return clone(product);
  }

  async listProducts(): Promise<readonly Product[]> {
    return [...this.products.values()].map((product) => clone(product));
  }

  async saveProject(project: CreativeProject): Promise<void> {
    const current = this.projects.get(project.id);
    if (current && project.version <= current.version) {
      throw new DomainError(
        "STALE_PROJECT_VERSION",
        `Project ${project.publicId} has already been updated.`
      );
    }
    this.projects.set(project.id, clone(project));
  }


  async saveProductAndProject(product: Product, project: CreativeProject): Promise<void> {
    const current = this.projects.get(project.id);
    if (current && project.version <= current.version) {
      throw new DomainError("STALE_PROJECT_VERSION", `Project ${project.publicId} has already been updated.`);
    }
    this.products.set(product.id, clone(product));
    this.projects.set(project.id, clone(project));
  }


  async getProject(id: string): Promise<CreativeProject> {
    const project = this.projects.get(id);
    if (!project) {
      throw new DomainError("PROJECT_NOT_FOUND", `Project ${id} was not found.`);
    }
    return clone(project);
  }

  async listProjects(): Promise<readonly CreativeProject[]> {
    return [...this.projects.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => clone(project));
  }

  async saveConceptProviderOperation(operation: ConceptProviderOperationEvidence): Promise<void> {
    this.conceptOperations.set(operation.operationKey,clone(operation));
  }

  async getConceptProviderOperation(operationKey: string): Promise<ConceptProviderOperationEvidence | undefined> {
    const operation=this.conceptOperations.get(operationKey);
    return operation?clone(operation):undefined;
  }

  async beginConceptProviderOperation(operationKey: string): Promise<Readonly<{ operation: ConceptProviderOperationEvidence; claimed: boolean }>> {
    const operation=this.conceptOperations.get(operationKey);
    if(!operation)throw new DomainError("CONCEPT_OPERATION_NOT_FOUND","Creative Concept provider operation was not found.");
    if(operation.state!=="PENDING")return {operation:clone(operation),claimed:false};
    const claimed={...operation,state:"SUBMITTING" as const};
    this.conceptOperations.set(operationKey,clone(claimed));
    return {operation:clone(claimed),claimed:true};
  }

  async enqueueJob(job: WorkflowJob): Promise<WorkflowJob> {
    const existingId = this.jobsByDedupeKey.get(job.dedupeKey);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing) {
        throw new DomainError("CORRUPT_JOB_INDEX", "Job dedupe index is inconsistent.");
      }
      return clone(existing);
    }
    this.jobs.set(job.id, clone(job));
    this.jobsByDedupeKey.set(job.dedupeKey, job.id);
    return clone(job);
  }

  async getJobByDedupeKey(dedupeKey: string): Promise<WorkflowJob | undefined> {
    const id = this.jobsByDedupeKey.get(dedupeKey);
    const job = id ? this.jobs.get(id) : undefined;
    return job ? clone(job) : undefined;
  }

  async getJob(id: string): Promise<WorkflowJob> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new DomainError("JOB_NOT_FOUND", `Workflow job ${id} was not found.`);
    }
    return clone(job);
  }

  async saveJob(job: WorkflowJob): Promise<void> {
    if (!this.jobs.has(job.id)) {
      throw new DomainError("JOB_NOT_FOUND", `Workflow job ${job.id} was not found.`);
    }
    this.jobs.set(job.id, clone(job));
  }

  async listJobs(projectId: string): Promise<readonly WorkflowJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .map((job) => clone(job));
  }
}
