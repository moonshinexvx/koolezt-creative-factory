import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@koolezt/domain";
import type { CreativeProject, ProviderSubmission, StrategyBatch, StrategyBatchStatus, StrategyConcept, StrategyConceptRevision, StrategyHistoryEntry, StrategyProviderConceptDraft, StrategyProviderOperation, StrategyRepository, StrategyRequestedCount } from "@koolezt/domain";

const parse = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown) => new Date(String(value)).toISOString();
const json = (value: unknown) => JSON.stringify(value);
const nullable = <T>(value: T | undefined): T | null => value ?? null;
const projectNumber = (publicId: string) => Number(publicId.replace(/^CF-/, ""));
const publicProjectId = (value: number) => `CF-${String(value).padStart(6, "0")}`;
const revisionSha = (revision: StrategyConceptRevision) => {
  const { providerMetadata: _providerMetadata, validationFindings: _validationFindings, ...snapshot } = revision;
  void _providerMetadata;
  void _validationFindings;
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
};

const mapBatch = (row: QueryResultRow): StrategyBatch => ({
  id: String(row.id), sourceProjectId: String(row.source_project_id), productId: String(row.product_id), revision: Number(row.revision), requestedCount: Number(row.requested_count) as StrategyRequestedCount,
  operationKey: String(row.operation_key), inputSnapshot: parse(row.input_snapshot), historySnapshot: parse(row.history_snapshot), historySha256: String(row.history_sha256),
  status: row.status as StrategyBatchStatus, providerRequestCount: Number(row.provider_request_count), automaticRepairAttempted: Boolean(row.automatic_repair_attempted),
  validationSummary: parse(row.validation_summary), providerMetadata: parse(row.provider_metadata), createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
});

const mapRevision = (row: QueryResultRow): StrategyConceptRevision => ({
  id: String(row.revision_id ?? row.id), conceptId: String(row.concept_id), batchId: String(row.batch_id), revision: Number(row.revision), ordinal: Number(row.ordinal),
  conceptName: String(row.concept_name), conceptFamily: String(row.concept_family), buyerPersona: String(row.buyer_persona), customerDesireOrProblem: String(row.customer_desire_or_problem),
  awarenessLevel: String(row.awareness_level), coreAngle: String(row.core_angle), emotionalTerritory: String(row.emotional_territory), primaryPromise: String(row.primary_promise), hook: String(row.hook),
  openingVisualPattern: String(row.opening_visual_pattern), creativeFormat: String(row.creative_format), primaryProductionMethod: row.primary_production_method,
  supportingProductionMethods: parse(row.supporting_production_methods), proofMechanism: String(row.proof_mechanism), offerFraming: String(row.offer_framing), ctaStrategy: String(row.cta_strategy),
  differentiationSummary: String(row.differentiation_summary), creativeVisualExecutionNotes: String(row.creative_visual_execution_notes ?? ""), productTruthConstraints: parse(row.product_truth_constraints), visualFidelityRequirements: parse(row.visual_fidelity_requirements),
  requiredRealAssetCapabilities: parse(row.required_real_asset_capabilities), ugcRepresentation: row.ugc_representation,
  source: row.source, diversityState: row.diversity_state, productionSafetyState: row.production_safety_state, validationFindings: parse(row.validation_findings),
  providerMetadata: parse(row.provider_metadata), createdBy: String(row.created_by), createdAt: iso(row.created_at)
});

const mapOperation = (row: QueryResultRow): StrategyProviderOperation => ({
  id: String(row.id), batchId: String(row.batch_id), kind: row.kind, operationKey: String(row.operation_key), status: row.status,
  ...(row.response_id ? { responseId: String(row.response_id) } : {}), ...(row.model ? { model: String(row.model) } : {}),
  ...(row.submitted_at ? { submittedAt: iso(row.submitted_at) } : {}), ...(row.latest_provider_status ? { latestProviderStatus: row.latest_provider_status } : {}),
  ...(row.latest_poll_at ? { latestPollAt: iso(row.latest_poll_at) } : {}), ...(row.terminal_at ? { terminalAt: iso(row.terminal_at) } : {}),
  ...(row.result_sha256 ? { resultSha256: String(row.result_sha256) } : {}), providerMetadata: parse(row.provider_metadata),
  ...(row.result_payload ? { result: parse(row.result_payload) } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
});

export class PostgresCreativeStrategyStore implements StrategyRepository {
  constructor(private readonly pool: Pool, private readonly id: () => string = randomUUID) {}

  async createBatch(input: Parameters<StrategyRepository["createBatch"]>[0]): Promise<StrategyBatch> {
    const q = await this.pool.query(`INSERT INTO creative_strategy_batches(id,source_project_id,product_id,requested_count,operation_key,input_snapshot,history_snapshot,history_sha256,status,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'PENDING',$9,$10,$10) ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING *`, [input.id,input.sourceProjectId,input.productId,input.inputSnapshot.requestedCount,input.operationKey,json(input.inputSnapshot),json(input.historySnapshot),input.historySha256,input.actor,input.timestamp]);
    return mapBatch(q.rows[0]);
  }
  async getBatch(id: string): Promise<StrategyBatch> { const q=await this.pool.query("SELECT * FROM creative_strategy_batches WHERE id=$1",[id]); if(!q.rows[0]) throw new DomainError("STRATEGY_BATCH_NOT_FOUND","Strategy batch was not found."); return mapBatch(q.rows[0]); }
  async setBatchState(id:string,status:StrategyBatchStatus,timestamp:string):Promise<void>{await this.pool.query("UPDATE creative_strategy_batches SET status=$2,updated_at=$3 WHERE id=$1",[id,status,timestamp]);}
  async listBatches(projectId:string){const q=await this.pool.query("SELECT * FROM creative_strategy_batches WHERE source_project_id=$1 ORDER BY created_at DESC",[projectId]);return Promise.all(q.rows.map(async row=>({batch:mapBatch(row),concepts:await this.listConcepts(String(row.id))})));}
  async listConcepts(batchId:string):Promise<readonly StrategyConcept[]>{const q=await this.pool.query(`SELECT c.*,r.*,r.id revision_id,c.id concept_id,c.created_at concept_created_at,c.updated_at concept_updated_at FROM creative_strategy_concepts c JOIN creative_strategy_concept_revisions r ON r.id=c.current_revision_id WHERE c.batch_id=$1 ORDER BY c.ordinal`,[batchId]);return q.rows.map(row=>({id:String(row.concept_id),batchId:String(row.batch_id),ordinal:Number(row.ordinal),currentRevision:mapRevision(row),status:row.status,createdAt:iso(row.concept_created_at),updatedAt:iso(row.concept_updated_at)}));}
  async getRevision(id:string):Promise<StrategyConceptRevision>{const q=await this.pool.query(`SELECT r.*,c.ordinal FROM creative_strategy_concept_revisions r JOIN creative_strategy_concepts c ON c.id=r.concept_id WHERE r.id=$1`,[id]);if(!q.rows[0])throw new DomainError("STRATEGY_REVISION_NOT_FOUND","Strategy revision was not found.");return mapRevision(q.rows[0]);}
  async listProductHistory(productId:string,excludeBatchId?:string):Promise<readonly StrategyHistoryEntry[]>{const q=await this.pool.query(`WITH recent_batches AS (SELECT id,created_at FROM creative_strategy_batches WHERE product_id=$1 AND ($2::uuid IS NULL OR id<>$2::uuid) ORDER BY created_at DESC,id DESC LIMIT 4) SELECT r.*,c.ordinal,b.created_at batch_created_at FROM recent_batches b JOIN creative_strategy_concepts c ON c.batch_id=b.id JOIN creative_strategy_concept_revisions r ON r.id=c.current_revision_id ORDER BY b.created_at DESC,b.id DESC,c.ordinal LIMIT 48`,[productId,excludeBatchId??null]);return q.rows.map(row=>({conceptRevisionId:String(row.id),conceptFamily:String(row.concept_family),buyerPersona:String(row.buyer_persona),customerDesireOrProblem:String(row.customer_desire_or_problem),coreAngle:String(row.core_angle),emotionalTerritory:String(row.emotional_territory),openingVisualPattern:String(row.opening_visual_pattern),creativeFormat:String(row.creative_format),primaryProductionMethod:row.primary_production_method,supportingProductionMethods:parse(row.supporting_production_methods),proofMechanism:String(row.proof_mechanism),offerFraming:String(row.offer_framing),differentiationSummary:String(row.differentiation_summary)}));}

  async getOrCreateOperation(input:Parameters<StrategyRepository["getOrCreateOperation"]>[0]):Promise<StrategyProviderOperation>{const q=await this.pool.query(`INSERT INTO creative_strategy_provider_operations(id,batch_id,kind,operation_key,status,created_at,updated_at) VALUES($1,$2,$3,$4,'PENDING',$5,$5) ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING *`,[input.id,input.batchId,input.kind,input.operationKey,input.timestamp]);return mapOperation(q.rows[0]);}
  async beginOperation(id:string):Promise<Readonly<{operation:StrategyProviderOperation;claimed:boolean}>>{const c=await this.pool.connect();try{await c.query("BEGIN");const current=await c.query("SELECT * FROM creative_strategy_provider_operations WHERE id=$1 FOR UPDATE",[id]);if(!current.rows[0])throw new DomainError("STRATEGY_OPERATION_NOT_FOUND","Strategy provider operation was not found.");if(current.rows[0].status!=="PENDING") {await c.query("COMMIT");return {operation:mapOperation(current.rows[0]),claimed:false};}const q=await c.query("UPDATE creative_strategy_provider_operations SET status='SUBMITTING',updated_at=now() WHERE id=$1 RETURNING *",[id]);await c.query("UPDATE creative_strategy_batches SET provider_request_count=provider_request_count+1,updated_at=now() WHERE id=$1",[current.rows[0].batch_id]);await c.query("COMMIT");return {operation:mapOperation(q.rows[0]),claimed:true};}catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}}
  async recordOperationSubmission(id:string,input:Parameters<StrategyRepository["recordOperationSubmission"]>[1]):Promise<void>{
    await this.pool.query(`UPDATE creative_strategy_provider_operations SET status='POLLING',response_id=$2,model=$3,submitted_at=$4,latest_provider_status=$5,latest_poll_at=$4,provider_metadata=provider_metadata||$6::jsonb,updated_at=$4 WHERE id=$1`,[id,input.response.responseId,input.response.model,input.submittedAt,input.response.status,json({provider:input.response.provider,model:input.response.model,responseId:input.response.responseId,latestStatus:input.response.status,...input.response.usage})]);
    await this.pool.query(`UPDATE creative_strategy_batches b SET validation_summary=b.validation_summary||$2::jsonb,updated_at=$3 FROM creative_strategy_provider_operations o WHERE o.id=$1 AND b.id=o.batch_id`,[id,json({providerExecution:{state:"BACKGROUND_RUNNING",status:input.response.status}}),input.submittedAt]);
  }
  async recordOperationPoll(id:string,input:Parameters<StrategyRepository["recordOperationPoll"]>[1]):Promise<void>{
    await this.pool.query(`UPDATE creative_strategy_provider_operations SET latest_provider_status=$2,latest_poll_at=$3,provider_metadata=provider_metadata||$4::jsonb,updated_at=$3 WHERE id=$1`,[id,input.response.status,input.polledAt,json({latestStatus:input.response.status,...input.response.usage})]);
    await this.pool.query(`UPDATE creative_strategy_batches b SET validation_summary=b.validation_summary||$2::jsonb,updated_at=$3 FROM creative_strategy_provider_operations o WHERE o.id=$1 AND b.id=o.batch_id`,[id,json({providerExecution:{state:"BACKGROUND_RUNNING",status:input.response.status}}),input.polledAt]);
  }
  async recordOperationPollFailure(id:string,input:Parameters<StrategyRepository["recordOperationPollFailure"]>[1]):Promise<void>{await this.pool.query("UPDATE creative_strategy_provider_operations SET latest_poll_at=$2,failure_message=$3,updated_at=$2 WHERE id=$1",[id,input.polledAt,input.message.slice(0,1000)]);}
  async completeOperation(id:string,result:Readonly<{concepts:readonly StrategyProviderConceptDraft[];submission:ProviderSubmission}>):Promise<void>{
    const submission=result.submission;
    const metadata={provider:submission.provider,model:submission.model,providerTaskId:submission.providerTaskId,requestId:submission.requestId,...submission.metadata};
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const resultSha256=createHash("sha256").update(json(result)).digest("hex");
      await client.query("UPDATE creative_strategy_provider_operations SET status='SUCCEEDED',latest_provider_status='completed',provider_metadata=$2::jsonb,result_payload=$3::jsonb,result_sha256=$4,terminal_at=now(),failure_message=NULL,updated_at=now() WHERE id=$1",[id,json(metadata),json(result),resultSha256]);
      await client.query(`UPDATE creative_strategy_batches b SET provider_metadata=b.provider_metadata||jsonb_build_array($2::jsonb),updated_at=now() FROM creative_strategy_provider_operations o WHERE o.id=$1 AND b.id=o.batch_id`,[id,json(metadata)]);
      await client.query(`INSERT INTO usage_costs(id,provider,model,operation_type,project_id,provider_request_id,status,currency,cost_json,created_at)
        SELECT $2,$3,$4,'STRATEGY',b.source_project_id,$5,'UNAVAILABLE','USD',$6::jsonb,now()
        FROM creative_strategy_provider_operations o JOIN creative_strategy_batches b ON b.id=o.batch_id WHERE o.id=$1
        ON CONFLICT(provider,provider_request_id,operation_type) DO NOTHING`,[id,this.id(),submission.provider,submission.model,submission.requestId,json(metadata)]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async failOperation(id:string,status:"FAILED"|"SUBMISSION_UNKNOWN"|"RESULT_UNAVAILABLE",message:string):Promise<void>{await this.pool.query("UPDATE creative_strategy_provider_operations SET status=$2,failure_message=$3,terminal_at=now(),updated_at=now() WHERE id=$1",[id,status,message.slice(0,1000)]);}

  async saveGeneratedConcepts(input:Parameters<StrategyRepository["saveGeneratedConcepts"]>[0]):Promise<void>{const c=await this.pool.connect();try{await c.query("BEGIN");for(const draft of input.concepts){const concept=await c.query("SELECT * FROM creative_strategy_concepts WHERE batch_id=$1 AND ordinal=$2 FOR UPDATE",[input.batchId,draft.ordinal]);let conceptId:string;if(!concept.rows[0]){conceptId=this.id();await c.query("INSERT INTO creative_strategy_concepts(id,batch_id,ordinal,status,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',$4,$4)",[conceptId,input.batchId,draft.ordinal,input.timestamp]);}else conceptId=String(concept.rows[0].id);const next=await c.query("SELECT COALESCE(MAX(revision),0)+1 value FROM creative_strategy_concept_revisions WHERE concept_id=$1",[conceptId]);const revisionId=this.id();await c.query(`INSERT INTO creative_strategy_concept_revisions(id,concept_id,batch_id,revision,concept_name,concept_family,buyer_persona,customer_desire_or_problem,awareness_level,core_angle,emotional_territory,primary_promise,hook,opening_visual_pattern,creative_format,primary_production_method,supporting_production_methods,proof_mechanism,offer_framing,cta_strategy,differentiation_summary,creative_visual_execution_notes,product_truth_constraints,visual_fidelity_requirements,required_real_asset_capabilities,ugc_representation,source,provider_metadata,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25::jsonb,$26,$27,$28::jsonb,$29,$30)`,[revisionId,conceptId,input.batchId,Number(next.rows[0].value),draft.conceptName,draft.conceptFamily,draft.buyerPersona,draft.customerDesireOrProblem,draft.awarenessLevel,draft.coreAngle,draft.emotionalTerritory,draft.primaryPromise,draft.hook,draft.openingVisualPattern,draft.creativeFormat,draft.primaryProductionMethod,json(draft.supportingProductionMethods),draft.proofMechanism,draft.offerFraming,draft.ctaStrategy,draft.differentiationSummary,draft.creativeVisualExecutionNotes,json(draft.productTruthConstraints),json(draft.visualFidelityRequirements),json(draft.requiredRealAssetCapabilities),draft.ugcRepresentation,input.source,json(input.providerMetadata),input.actor,input.timestamp]);await c.query("UPDATE creative_strategy_concepts SET current_revision_id=$2,status='ACTIVE',updated_at=$3 WHERE id=$1",[conceptId,revisionId,input.timestamp]);}await c.query("COMMIT");}catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}}
  async saveValidation(input:Parameters<StrategyRepository["saveValidation"]>[0]):Promise<void>{const c=await this.pool.connect();try{await c.query("BEGIN");for(const result of input.results)await c.query("UPDATE creative_strategy_concept_revisions SET diversity_state=$2,production_safety_state=$3,validation_findings=$4::jsonb WHERE id=$1",[result.revisionId,result.diversityState,result.productionSafetyState,json(result.findings)]);await c.query("UPDATE creative_strategy_batches SET status=$2,automatic_repair_attempted=$3,validation_summary=$4::jsonb,updated_at=$5 WHERE id=$1",[input.batchId,input.status,input.automaticRepairAttempted,json(input.summary),input.timestamp]);await c.query("COMMIT");}catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}}

  private async insertProject(client:PoolClient,project:CreativeProject):Promise<void>{await client.query(`INSERT INTO creative_projects(id,project_number,public_id,product_id,state,additional_instructions,preferred_voice_profile_id,current_concept_id,current_voice_generation_id,current_render_id,ready_path,ready_sha256,ready_byte_size,ready_at,version,created_at,updated_at,strategy_required,strategy_batch_id,strategy_concept_revision_id,winner_creative_reference_id,winner_dna_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$8,$9,$10,true,$11,$12,$13,$14)`,[project.id,projectNumber(project.publicId),project.publicId,project.productId,project.state,project.additionalInstructions,project.preferredVoiceProfileId,project.version,project.createdAt,project.updatedAt,project.strategyOrigin!.batchId,project.strategyOrigin!.conceptRevisionId,nullable(project.winnerDnaOrigin?.creativeReferenceId),nullable(project.winnerDnaOrigin?.revisionId)]);await client.query("INSERT INTO creative_project_snapshots(project_id,aggregate,updated_at) VALUES($1,$2::jsonb,$3)",[project.id,json(project),project.updatedAt]);for(const assetId of project.selectedProductAssetIds)await client.query("INSERT INTO creative_project_assets(project_id,product_asset_id,role,selected_at) VALUES($1,$2,'REFERENCE',$3) ON CONFLICT DO NOTHING",[project.id,assetId,project.createdAt]);}
  async createHandoff(input: Parameters<StrategyRepository["createHandoff"]>[0]): Promise<readonly CreativeProject[]> {
    const operationKey = `strategy-handoff:${input.batchId}:${input.requestId}`;
    const prior = await this.pool.query(`SELECT s.aggregate FROM creative_strategy_handoffs h JOIN creative_project_snapshots s ON s.project_id=h.video_project_id WHERE h.operation_key=$1 ORDER BY h.selection_order`, [operationKey]);
    if (prior.rows.length) return prior.rows.map((row) => parse<CreativeProject>(row.aggregate));
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const batchQ = await c.query("SELECT * FROM creative_strategy_batches WHERE id=$1 FOR UPDATE", [input.batchId]);
      if (!batchQ.rows[0]) throw new DomainError("STRATEGY_BATCH_NOT_FOUND", "Strategy batch was not found.");
      const batch = mapBatch(batchQ.rows[0]);
      const sourceQ = await c.query(`SELECT p.*,s.aggregate FROM creative_projects p JOIN creative_project_snapshots s ON s.project_id=p.id WHERE p.id=$1 FOR UPDATE`, [batch.sourceProjectId]);
      if (!sourceQ.rows[0]) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found.");
      const source = parse<CreativeProject>(sourceQ.rows[0].aggregate);
      const revisions: StrategyConceptRevision[] = [];
      for (const id of input.revisionIds) {
        const q = await c.query(`SELECT r.*,c.ordinal FROM creative_strategy_concept_revisions r JOIN creative_strategy_concepts c ON c.id=r.concept_id WHERE r.id=$1 AND c.batch_id=$2 AND c.current_revision_id=r.id AND r.diversity_state='DISTINCT' AND r.production_safety_state='PRODUCTION_SAFE'`, [id, input.batchId]);
        if (!q.rows[0]) throw new DomainError("STRATEGY_SELECTION_NOT_READY", "Only current distinct and production-safe revisions can be handed off.");
        revisions.push(mapRevision(q.rows[0]));
      }
      const projects: CreativeProject[] = [];
      for (const [index, revision] of revisions.entries()) {
        const checksum = revisionSha(revision);
        const origin = { batchId: batch.id, conceptId: revision.conceptId, conceptRevisionId: revision.id, revisionSha256: checksum, sourceProjectId: source.id };
        const winnerDnaOrigin = input.winnerDna ? { creativeReferenceId: input.winnerDna.creativeReferenceId, revisionId: input.winnerDna.id, revisionSha256: input.winnerDna.revisionSha256 } : undefined;
        const creativeInputSnapshot = input.inputSnapshots?.find((item) => item.revisionId === revision.id)?.snapshot;
        const shared = {
          strategyRequired: true as const,
          strategyOrigin: origin,
          ...(winnerDnaOrigin ? { winnerDnaOrigin, winnerDnaSnapshot: input.winnerDna } : {}),
          ...(creativeInputSnapshot ? { creativeInputSnapshot } : {}),
          creativeBrief: { creativeTopic: `${revision.conceptName}: ${revision.coreAngle}`, productDetails: source.creativeBrief?.productDetails ?? batch.inputSnapshot.productDescription, targetDurationSeconds: Math.round(batch.inputSnapshot.targetDurationMs / 1000) },
          additionalInstructions: `Authoritative strategy ${revision.id}: ${revision.differentiationSummary}`
        };
        const numberQ = await c.query("SELECT nextval('project_number_sequence')::text value");
        const project: CreativeProject = {
          ...shared,
          id: this.id(),
          publicId: publicProjectId(Number(numberQ.rows[0].value)),
          productId: source.productId,
          selectedProductAssetIds: [...source.selectedProductAssetIds],
          preferredVoiceProfileId: source.preferredVoiceProfileId,
          state: "DRAFT",
          concepts: [], scenes: [], narrationRevisions: [], voiceGenerations: [], renders: [], approvals: [], usageCosts: [], auditEvents: [],
          version: 1, createdAt: input.timestamp, updatedAt: input.timestamp
        };
        await this.insertProject(c, project);
        projects.push(project);
        await c.query("INSERT INTO creative_strategy_handoffs(batch_id,concept_revision_id,video_project_id,revision_sha256,operation_key,selection_order,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [batch.id, revision.id, project.id, checksum, operationKey, index + 1, input.actor, input.timestamp]);
        await c.query("UPDATE creative_strategy_concepts SET status='HANDED_OFF',updated_at=$2 WHERE id=$1", [revision.conceptId, input.timestamp]);
      }
      await c.query("UPDATE creative_strategy_batches SET status='HANDED_OFF',updated_at=$2 WHERE id=$1", [batch.id, input.timestamp]);
      await c.query("COMMIT");
      return projects;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
}
