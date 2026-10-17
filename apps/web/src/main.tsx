import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createLatestRequest } from "./refresh.js";
import { createNewProjectWorkflow, uploadProductReference, type NewProjectDraft } from "./project-create.js";
import { groupProjectsIntoCampaigns, projectConceptName } from "./campaigns.js";
import { assessVoiceTiming, buildSceneContextImagePrompt, estimateNarrationDurationMs } from "@koolezt/domain";
import "./style.css";
import "./campaigns.css";
import "./creative-dna.css";
import "./scene-context.css";

const variantVoicePresetDefaults = { A: "marin", B: "cedar", C: "coral", D: "alloy" } as const;
const variantVoicePresetOptions = ["marin", "cedar", "coral", "alloy"] as const;

const narrationScriptFor = (project: any): string => {
  const currentVoice = project?.voiceGenerations?.find((item: any) => item.id === project.currentVoiceGenerationId)
    ?? project?.voiceGenerations?.find((item: any) => item.status === "ACCEPTED")
    ?? project?.voiceGenerations?.at(-1);
  const revision = project?.narrationRevisions?.find((item: any) => item.id === project.currentNarrationRevisionId)
    ?? project?.narrationRevisions?.find((item: any) => item.id === currentVoice?.narrationRevisionId);
  const concept = project?.concepts?.find((item: any) => item.id === project.currentConceptId);
  return revision?.script ?? currentVoice?.sourceScript ?? concept?.voiceScript ?? "";
};

const api = async (path: string, method = "GET", payload?: unknown) => {
  const response = await fetch(path, {
    method,
    headers: { "x-koolezt-actor": "web-user", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message ?? "Request failed");
  return json;
};

function App() {
  const [projects, setProjects] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createStage, setCreateStage] = useState("");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [newProject, setNewProject] = useState<NewProjectDraft>(() => ({ requestId: crypto.randomUUID(), name: "", creativeTopic: "", productDetails: "", targetDurationSeconds: 15 }));
  const [verifiedClaimsText, setVerifiedClaimsText] = useState("");

  const [selected, setSelected] = useState<any>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [approvingConcept, setApprovingConcept] = useState(false);
  const [uploadStages, setUploadStages] = useState<Record<string, string>>({});
  const [contextImageUploadStages, setContextImageUploadStages] = useState<Record<string, string>>({});
  const [contextImageFidelityConfirmations, setContextImageFidelityConfirmations] = useState<Record<string, boolean>>({});
  const [scenePromptDrafts, setScenePromptDrafts] = useState<Record<string, string>>({});
  const [voiceScript, setVoiceScript] = useState("");
  const [voiceEditorOpen, setVoiceEditorOpen] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceRewriting, setVoiceRewriting] = useState(false);
  const [voiceGenerating, setVoiceGenerating] = useState(false);
  const [session, setSession] = useState<{ email: string; role: "OWNER" | "EDITOR" | "DEVELOPMENT" }>({ email: "", role: "DEVELOPMENT" });
  const [renderWorkers, setRenderWorkers] = useState<any[]>([]);
  const [showWorkers, setShowWorkers] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState("Editor Laptop");
  const [setupCode, setSetupCode] = useState<{ setupCode: string; expiresAt: string }>();
  const [variantBatches, setVariantBatches] = useState<any[]>([]);
  const [selectedVariantIds, setSelectedVariantIds] = useState<readonly string[]>([]);
  const [creativePackages, setCreativePackages] = useState<any[]>([]);
  const [strategyBatches, setStrategyBatches] = useState<any[]>([]);
  const [selectedStrategyRevisionIds, setSelectedStrategyRevisionIds] = useState<readonly string[]>([]);
  const [strategyWorking, setStrategyWorking] = useState(false);
  const [strategyRequestedCount, setStrategyRequestedCount] = useState<3 | 6 | 12>(6);
  const [creativeReferences,setCreativeReferences]=useState<any[]>([]);
  const [approvedWinnerDna,setApprovedWinnerDna]=useState<any[]>([]);
  const [selectedWinnerDnaRevisionId,setSelectedWinnerDnaRevisionId]=useState("");
  const [dnaWorking,setDnaWorking]=useState(false);
  const [dnaEdits,setDnaEdits]=useState<Record<string,string>>({});
  const [referenceDraft,setReferenceDraft]=useState({displayName:"",operatorStatus:"WINNER",platform:"Meta/Facebook",operatorNotes:"",operatorTranscript:"",performance:""});
  const [referenceVideo,setReferenceVideo]=useState<File>();
  const [referenceUploadProgress,setReferenceUploadProgress]=useState<number>();
  const [referenceUploadError,setReferenceUploadError]=useState("");
  const referenceVideoInput=useRef<HTMLInputElement>(null);
  const [variantVoicePresets, setVariantVoicePresets] = useState<Record<string, string>>({});
  const [variantWorking, setVariantWorking] = useState(false);
  const [creatingVariants, setCreatingVariants] = useState(false);
  const [variantCopyGenerating, setVariantCopyGenerating] = useState(false);
  const [variantCopyError, setVariantCopyError] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState<string>();
  const [immutableStructureText,setImmutableStructureText]=useState("");
  const [personalizationFieldsText,setPersonalizationFieldsText]=useState("");
  const [authorizedConfigurationsText,setAuthorizedConfigurationsText]=useState("");
  const [campaignVerifiedClaimsText,setCampaignVerifiedClaimsText]=useState("");
  const [personalizationAuthorityConfirmed,setPersonalizationAuthorityConfirmed]=useState(false);
  const [savingPersonalizationAuthority,setSavingPersonalizationAuthority]=useState(false);
  const [campaignReferenceWorking,setCampaignReferenceWorking]=useState(false);
  const [campaignReferenceStage,setCampaignReferenceStage]=useState("");
  const [workspaceTab, setWorkspaceTab] = useState<"dna" | "strategy" | "brief" | "scenes" | "voice" | "final" | "variants">("strategy");
  const [campaignWorkspaceView, setCampaignWorkspaceView] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<"ALL" | "ACTIVE" | "REVIEW" | "READY">("ALL");
  const [expandedCampaignIds, setExpandedCampaignIds] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedCampaignIds, setCollapsedCampaignIds] = useState<ReadonlySet<string>>(() => new Set());
  const [navView, setNavView] = useState<"HOME" | "CREATE" | "WORKERS" | "USERS" | "SETTINGS">("HOME");
  const selectedId = useRef<string>();
  const refresher = useRef<ReturnType<typeof createLatestRequest<string | undefined, any>>>();
  if (!refresher.current) {
    refresher.current = createLatestRequest({
      load: async (projectId) => {
        const [nextProjects, nextProducts, project, variants, creativePackages, strategies, nextSession, workers, references, approvedDna] = await Promise.all([
          api("/api/projects"),
          api("/api/products"),
          projectId ? api(`/api/projects/${projectId}`) : Promise.resolve(undefined),
          projectId ? api(`/api/projects/${projectId}/variants`) : Promise.resolve([]),
          projectId ? api(`/api/projects/${projectId}/variant-packages`) : Promise.resolve([]),
          projectId ? api(`/api/projects/${projectId}/strategy-batches`) : Promise.resolve([]),
          api("/api/session"),
          api("/api/render-workers/status"),
          projectId ? api(`/api/creative-references?projectId=${encodeURIComponent(projectId)}`) : Promise.resolve([]),
          projectId ? api(`/api/creative-references/approved?projectId=${encodeURIComponent(projectId)}`).catch(()=>[]) : Promise.resolve([])
        ]);
        return { projects: nextProjects, products: nextProducts, projectId, project, session: nextSession, workers, variants, creativePackages, strategies, references, approvedDna };
      },
      apply: (result) => {
        setProjects(result.projects);
        setProducts(result.products);
        setSession(result.session);
        setRenderWorkers(result.workers);
        setVariantBatches(result.variants ?? []);
        setCreativePackages(result.creativePackages ?? []);
        setStrategyBatches(result.strategies ?? []);
        setCreativeReferences(result.references??[]);
        setApprovedWinnerDna(result.approvedDna??[]);
        if (result.projectId === selectedId.current) setSelected(result.project);
      },
      fail: (reason) => setError(reason === undefined ? "" : reason instanceof Error ? reason.message : "Refresh failed."),
      loading: setRefreshing
    });
  }
  const refresh = useCallback((projectId = selectedId.current) => refresher.current!.run(projectId), []);
  const reconnectRenderWorker = () => {
    window.location.href = "koolezt-creative-worker://reconnect";
    window.setTimeout(() => void refresh(), 1_500);
  };
  useEffect(() => {
    const applyLocation = () => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      const tabs = new Set(["dna", "strategy", "brief", "scenes", "voice", "final", "variants"]);
      const projectId = parts[0] === "projects" ? parts[1] : undefined;
      const requestedTab = parts[2];
      if (projectId) {
        selectedId.current = projectId;
        if (requestedTab && tabs.has(requestedTab)) {
          setWorkspaceTab(requestedTab as "dna" | "strategy" | "brief" | "scenes" | "voice" | "final" | "variants");
          setCampaignWorkspaceView(requestedTab === "dna" || requestedTab === "strategy");
        }
        void refresh(projectId);
      } else {
        selectedId.current = undefined;
        void refresh(undefined);
      }
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, [refresh]);
  useEffect(() => {
    document.querySelectorAll<HTMLMediaElement>("video,audio").forEach((media) => media.pause());
  }, [workspaceTab, selected?.id]);
  useEffect(() => {
    // A direct link or browser refresh loads the project asynchronously. Keep the
    // editable field synchronized with stored narration without overwriting edits.
    if (selected) setVoiceScript(narrationScriptFor(selected));
  }, [selected?.id, selected?.currentNarrationRevisionId, selected?.currentVoiceGenerationId]);

  useEffect(()=>{
    const current=products.find((item)=>item.id===selected?.productId);
    const authority=current?.personalizationVisualAuthority;
    setImmutableStructureText(authority?.immutableStructure?.join("\n")??"");
    setPersonalizationFieldsText(authority?.authorizedPersonalizationFields?.join("\n")??"");
    setAuthorizedConfigurationsText(authority?.authorizedProductConfigurations?.join("\n")??"");
    setCampaignVerifiedClaimsText(current?.claims?.map((claim:any)=>claim.text).join("\n")??"");
    setPersonalizationAuthorityConfirmed(authority?.status==="OPERATOR_CONFIRMED");
  },[selected?.productId,products]);

  const action = async (path: string, body?: unknown): Promise<any | undefined> => {
    try {
      setError("");
      const updated = await api(path, "POST", body);
      selectedId.current = updated.id;
      setSelected(updated);
      await refresh(updated.id);
      return updated;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed.");
    }
  };
  const approveConcept = async () => {
    if (approvingConcept || selected?.state !== "CONCEPT_REVIEW") return;
    setApprovingConcept(true);
    try {
      await action(`/api/projects/${selected.id}/concept/approve`);
    } finally {
      setApprovingConcept(false);
    }
  };
  const setSceneProvider = async (sceneId: string, provider: string) => {
    try {
      setError("");
      const updated = await api(`/api/projects/${selected.id}/scenes/${sceneId}/video-provider`, "PUT", { provider });
      selectedId.current = updated.id;
      setSelected(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not select the suggested generator.");
    }
  };
  const openProject = (project: any, preferredTab?: typeof workspaceTab, asCampaignWorkspace = false) => {
    refresher.current!.cancel();
    setError("");
    setUploadStages({});
    setVoiceScript(narrationScriptFor(project));
    setVoiceEditorOpen(false);
    setSelectedStrategyRevisionIds([]);

    selectedId.current = project.id;
    setSelected(project);
    const requestedTab = preferredTab ?? workspaceTab;
    const nextTab = !asCampaignWorkspace && (requestedTab === "dna" || requestedTab === "strategy") ? "brief" : requestedTab;
    setCampaignWorkspaceView(asCampaignWorkspace);
    setWorkspaceTab(nextTab);
    setShowCreateProject(false);
    setShowWorkers(false);
    setNavView("HOME");
    history.pushState({}, "", `/projects/${project.id}/${nextTab}`);
    void refresh(project.id);
  };
  const saveVoiceScript = async () => {
    if (!selected || voiceSaving || !voiceScript.trim()) return;
    setVoiceSaving(true);
    try {
      const updated = await api(`/api/projects/${selected.id}/voice/script`, "POST", { script: voiceScript });
      selectedId.current = updated.id; setSelected(updated); setVoiceScript(narrationScriptFor(updated)); await refresh(updated.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save voice script."); }
    finally { setVoiceSaving(false); }
  };
  const rewriteVoiceScript = async () => {
    if (!selected || voiceRewriting || !voiceScript.trim()) return;
    setVoiceRewriting(true);
    try {
      const updated = await api(`/api/projects/${selected.id}/voice/rewrite`, "POST", { script: voiceScript });
      selectedId.current = updated.id; setSelected(updated); setVoiceScript(narrationScriptFor(updated)); await refresh(updated.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Narration rewrite failed."); }
    finally { setVoiceRewriting(false); }
  };
  const generateVoice = async () => {
    if (!selected || voiceGenerating || !voiceScript.trim()) return;
    setVoiceGenerating(true);
    try {
      await action(`/api/projects/${selected.id}/voice/generate`, { voiceProfileId: selected.preferredVoiceProfileId ?? "marin", script: voiceScript, instructions: "Warm, natural and engaging social-media ad voice. Friendly and conversational, with confident pacing. Avoid exaggerated announcer delivery." });
    } finally { setVoiceGenerating(false); }
  };

  const saveCreativePackage = async (slot: string, revision: any) => {
    if (!selected || variantWorking) return; setVariantWorking(true);
    try { await api(`/api/projects/${selected.id}/variant-packages/${slot}`, "POST", revision); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save creative package."); }
    finally { setVariantWorking(false); }
  };
  const generateCreativePackages = async () => {
    if (!selected || variantWorking || variantCopyGenerating) return;
    setVariantWorking(true);
    setVariantCopyGenerating(true);
    setVariantCopyError("");
    try {
      await api(`/api/projects/${selected.id}/variant-packages/generate`, "POST", {});
      await refresh(selected.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not generate creative packages.";
      setVariantCopyError(message);
      setError(message);
    } finally {
      setVariantCopyGenerating(false);
      setVariantWorking(false);
    }
  };  const rewriteVariantNarration = async (slot: string) => {
    if (!selected || variantWorking) return;
    setVariantWorking(true);
    try { await api(`/api/projects/${selected.id}/variant-packages/${slot}/rewrite`, "POST", {}); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not rewrite the variant narration."); }
    finally { setVariantWorking(false); }
  };  const generateVariantVoices = async (slot?: string) => {
    if (!selected || variantWorking) return; setVariantWorking(true);
    try {
      const selectedPreset = (packageSlot: string) => variantVoicePresets[packageSlot] ?? variantVoicePresetDefaults[packageSlot as keyof typeof variantVoicePresetDefaults];
      const payload = slot ? { voicePreset: selectedPreset(slot) } : { voicePresets: Object.fromEntries((Object.keys(variantVoicePresetDefaults) as Array<keyof typeof variantVoicePresetDefaults>).map((packageSlot) => [packageSlot, selectedPreset(packageSlot)])) };
      await api(slot ? `/api/projects/${selected.id}/variant-packages/${slot}/voice/generate` : `/api/projects/${selected.id}/variant-packages/voices/generate`, "POST", payload);
      await refresh(selected.id);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not generate variant voice."); }
    finally { setVariantWorking(false); }
  };
  const acceptVariantVoice = async (voiceId: string) => {
    if (!selected || variantWorking) return; setVariantWorking(true);
    try { await api(`/api/variant-package-voices/${voiceId}/accept`, "POST", {}); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not accept variant voice."); }
    finally { setVariantWorking(false); }
  };
  const createVariants = async () => {
    if (!selected || variantWorking) return; setVariantWorking(true);
    try { const batches = await api(`/api/projects/${selected.id}/variants`, "POST", { requestId: crypto.randomUUID() }); setVariantBatches(batches); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create variants."); }
    finally { setVariantWorking(false); }
  };  const deleteVariantBatch = async (batch: any) => {
    if (!selected || variantWorking) return;
    const label = `B${String(batch.batchSequence).padStart(2, "0")}`;
    if (window.prompt(`Type ${label} to delete this batch and schedule its variant MP4s for cleanup.`, "") !== label) return;
    setVariantWorking(true);
    try { await api(`/api/variant-batches/${batch.id}`, "DELETE", { confirmation: label }); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete the variant batch."); }
    finally { setVariantWorking(false); }
  };  const retryVariants = async (ids: readonly string[]) => {
    if (!selected || creatingVariants || ids.length === 0) return; setCreatingVariants(true);
    try { await Promise.all(ids.map((id) => api(`/api/variants/${id}/retry`, "POST", {}))); await refresh(selected.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not retry failed variants."); }
    finally { setCreatingVariants(false); }
  };
  const toggleVariantSelection = (variantId: string) => {
    setSelectedVariantIds((current) => current.includes(variantId) ? current.filter((id) => id !== variantId) : [...current, variantId]);
  };

  const generateStrategyConcepts = async () => {
    if (!selected || strategyWorking) return;
    setStrategyWorking(true);
    setError("");
    try {
      await api(`/api/projects/${selected.id}/strategy-batches`, "POST", { requestId: crypto.randomUUID(), requestedCount: strategyRequestedCount });
      await refresh(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start strategy generation.");
    } finally {
      setStrategyWorking(false);
    }
  };
  const replaceFlaggedStrategies = async (batchId: string) => {
    if (!selected || strategyWorking) return;
    setStrategyWorking(true);
    setError("");
    try {
      await api(`/api/strategy-batches/${batchId}/replace-flagged`, "POST", { requestId: crypto.randomUUID() });
      await refresh(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not request strategy replacements.");
    } finally {
      setStrategyWorking(false);
    }
  };
  const toggleStrategySelection = (revisionId: string, batchRevisionIds: readonly string[]) => {
    setSelectedStrategyRevisionIds((current) => {
      const selectedForBatch = current.filter((id) => batchRevisionIds.includes(id));
      if (selectedForBatch.includes(revisionId)) return selectedForBatch.filter((id) => id !== revisionId);
      return selectedForBatch.length >= 3 ? selectedForBatch : [...selectedForBatch, revisionId];
    });
  };
  const sendStrategiesToVideoMaker = async (batchId: string, revisionIds: readonly string[]) => {
    if (!selected || strategyWorking || revisionIds.length < 1 || revisionIds.length > 3) return;
    setStrategyWorking(true);
    setError("");
    try {
      const projects = await api(`/api/strategy-batches/${batchId}/handoff`, "POST", { requestId: crypto.randomUUID(), revisionIds, ...(selectedWinnerDnaRevisionId?{winnerDnaRevisionId:selectedWinnerDnaRevisionId}:{}) });
      const first = projects[0];
      if (first) {
        selectedId.current = first.id;
        setSelected(first);
        setSelectedStrategyRevisionIds([]);
        setCampaignWorkspaceView(false);
        setWorkspaceTab("brief");
        history.pushState({}, "", `/projects/${first.id}/brief`);
        await refresh(first.id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send selected strategies to Video Maker.");
    } finally {
      setStrategyWorking(false);
    }
  };
  const selectReferenceVideo=(file:File|undefined)=>{setReferenceUploadError("");setReferenceUploadProgress(undefined);if(!file){setReferenceVideo(undefined);return;}const extension=file.name.split(".").at(-1)?.toLowerCase();if(!["mp4","webm"].includes(extension??"")||!["video/mp4","video/webm"].includes(file.type)){setReferenceVideo(undefined);if(referenceVideoInput.current)referenceVideoInput.current.value="";setReferenceUploadError("Choose an MP4 or WebM source video.");return;}setReferenceVideo(file);};
  const clearReferenceVideo=()=>{setReferenceVideo(undefined);setReferenceUploadProgress(undefined);setReferenceUploadError("");if(referenceVideoInput.current)referenceVideoInput.current.value="";};
  const uploadCreativeReference=async()=>{if(!selected||dnaWorking)return;if(!referenceVideo){setReferenceUploadError("Choose a source video before creating the Creative Reference.");return;}setDnaWorking(true);setError("");setReferenceUploadError("");setReferenceUploadProgress(0);try{let performance:Record<string,unknown>|undefined;if(referenceDraft.performance){try{performance=JSON.parse(referenceDraft.performance) as Record<string,unknown>;}catch{throw new Error("Historical performance must be valid JSON.");}}const bytes=await referenceVideo.arrayBuffer();const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");const target=await api(`/api/projects/${selected.id}/creative-references/upload`,"POST",{filename:referenceVideo.name,mimeType:referenceVideo.type,byteSize:referenceVideo.size,sha256});await new Promise<void>((resolve,reject)=>{const request=new XMLHttpRequest();request.open("PUT",target.url);request.timeout=30*60*1000;for(const[header,value]of Object.entries(target.headers as Record<string,string>))request.setRequestHeader(header,value);request.upload.onprogress=event=>{if(event.lengthComputable)setReferenceUploadProgress(Math.min(99,Math.round(event.loaded/event.total*100)));};request.onerror=()=>reject(new Error("Direct source-video upload failed. Check the connection and try again."));request.ontimeout=()=>reject(new Error("Source-video upload timed out. Please try again."));request.onabort=()=>reject(new Error("Source-video upload was cancelled."));request.onload=()=>request.status>=200&&request.status<300?resolve():reject(new Error(`Direct source-video upload failed with HTTP ${request.status}.`));request.send(referenceVideo);});setReferenceUploadProgress(100);await api(`/api/projects/${selected.id}/creative-references/complete`,"POST",{assetId:target.assetId,displayName:referenceDraft.displayName||referenceVideo.name,operatorStatus:referenceDraft.operatorStatus,platform:referenceDraft.platform,...(referenceDraft.operatorNotes?{operatorNotes:referenceDraft.operatorNotes}:{}),...(referenceDraft.operatorTranscript?{operatorTranscript:referenceDraft.operatorTranscript}:{}),...(performance?{performance}:{})});setReferenceDraft({displayName:"",operatorStatus:"WINNER",platform:"Meta/Facebook",operatorNotes:"",operatorTranscript:"",performance:""});clearReferenceVideo();await refresh(selected.id);}catch(reason){const message=reason instanceof Error?reason.message:"Creative Reference upload failed.";setReferenceUploadError(message);setError(message);}finally{setDnaWorking(false);}};
  const analyzeCreativeDna=async(referenceId:string)=>{setDnaWorking(true);setError("");try{await api(`/api/creative-references/${referenceId}/analyze`,"POST",{requestId:crypto.randomUUID()});await refresh(selected.id);}catch(reason){setError(reason instanceof Error?reason.message:"Could not start Creative DNA analysis.");}finally{setDnaWorking(false);}};
  const saveDnaEdit=async(referenceId:string,revision:any)=>{setDnaWorking(true);setError("");try{const text=dnaEdits[revision.id]??JSON.stringify(Object.fromEntries(Object.entries(revision).filter(([key])=>!["id","creativeReferenceId","revision","status","source","mediaMetadata","providerMetadata","createdBy","createdAt","operatorNotes"].includes(key))),null,2);await api(`/api/creative-references/${referenceId}/dna`,"PUT",JSON.parse(text));await refresh(selected.id);}catch(reason){setError(reason instanceof Error?reason.message:"Could not save DNA revision.");}finally{setDnaWorking(false);}};
  const approveCreativeDna=async(referenceId:string,revisionId:string)=>{setDnaWorking(true);setError("");try{await api(`/api/creative-references/${referenceId}/dna/${revisionId}/approve`,"POST",{});await refresh(selected.id);}catch(reason){setError(reason instanceof Error?reason.message:"Could not approve DNA revision.");}finally{setDnaWorking(false);}};
  const downloadVariant = async (variant: Readonly<{ id: string; publicId: string }>) => {
    const response = await fetch(`/api/variants/${variant.id}/download`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not prepare this MP4 for download.");
    // The authenticated endpoint redirects to a signed S3 URL. Creating a blob
    // URL makes Chrome save the MP4 rather than opening its media player.
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${variant.publicId}.mp4`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  };
  const downloadSelectedVariants = async (variants: readonly Readonly<{ id: string; publicId: string }>[]) => {
    if (variants.length === 0) return;
    try {
      for (const variant of variants) await downloadVariant(variant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not download the selected MP4s.");
    }
  };
  const openDashboard = () => {
    selectedId.current = undefined;
    setSelected(undefined);
    setShowCreateProject(false);
    setShowWorkers(false);
    setNavView("HOME");
    setShowWorkers(false);
    setNavView("HOME");
    history.pushState({}, "", "/");
    void refresh(undefined);
  };

  const submitNewProject = async () => {
    if (creatingProject) return;
    setCreatingProject(true);
    setError("");
    try {
      const project = await createNewProjectWorkflow({ draft: { ...newProject, verifiedClaims: verifiedClaimsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }, files: referenceFiles, onStage: setCreateStage });
      selectedId.current = project.id;
      setSelected(project);
      setShowCreateProject(false);
      setCampaignWorkspaceView(true);
      setWorkspaceTab("dna");
      history.pushState({}, "", `/projects/${project.id}/dna`);
      await refresh(project.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project creation failed.");
    } finally {
      setCreatingProject(false);
    }
  };

  const deleteProject = async (project: any) => {
    if (session.role !== "OWNER" || !project || deletingProjectId) return;
    const confirmation = window.prompt(`Type ${project.publicId} to delete this unfinished project. This safely archives it from the dashboard; published READY projects are protected.`);
    if (confirmation !== project.publicId) {
      if (confirmation !== null) setError(`Project was not deleted. Type ${project.publicId} exactly to confirm.`);
      return;
    }
    try {
      setDeletingProjectId(project.id);
      setError("");
      await api(`/api/projects/${project.id}`, "DELETE", { confirmation });
      if (selectedId.current === project.id) openDashboard();
      else await refresh(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete project.");
    } finally {
      setDeletingProjectId(undefined);
    }
  };
  const selectWorkspace = (tab: "dna" | "strategy" | "brief" | "scenes" | "voice" | "final" | "variants") => {
    setWorkspaceTab(tab);
    if (selectedId.current) history.pushState({}, "", `/projects/${selectedId.current}/${tab}`);
  };
  const refreshButton = <button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>;
  const productNames = new Map(products.map((product) => [product.id, product.name]));
  const filteredProjects = projects.filter((project) => {
    const name = String(productNames.get(project.productId) ?? "Creative project").toLowerCase();
    const conceptName = projectConceptName(project).toLowerCase();
    const matchesQuery = !projectQuery.trim() || `${project.publicId} ${name} ${conceptName} ${project.strategyOrigin?.batchId ?? ""}`.toLowerCase().includes(projectQuery.trim().toLowerCase());
    const matchesFilter = projectFilter === "ALL" || (projectFilter === "READY" && project.state === "READY") || (projectFilter === "REVIEW" && ["CONCEPT_REVIEW", "VOICE_REVIEW", "FINAL_REVIEW", "OWNER_REVIEW"].includes(project.state)) || (projectFilter === "ACTIVE" && !["READY", "CONCEPT_REVIEW", "VOICE_REVIEW", "FINAL_REVIEW", "OWNER_REVIEW"].includes(project.state));
    return matchesQuery && matchesFilter;
  });
  const browserItems = groupProjectsIntoCampaigns(filteredProjects, (productId) => String(productNames.get(productId) ?? "Creative project"));
  const projectRow = (project: any, nested = false) => {
    const acceptedScenes = project.scenes.filter((scene: any) => Boolean(scene.approvedAttemptId)).length;
    const active = selected?.id === project.id;
    return <div className={`project-row ${nested ? "campaign-project-row" : ""} ${active ? "selected" : ""}`} key={project.id}><button className="project-open" onClick={() => openProject(project)}><b>{nested ? projectConceptName(project) : project.publicId}</b>{nested && <span>{project.publicId}</span>}{!nested && <span>{productNames.get(project.productId) ?? "Creative project"}</span>}<small>{project.state} · Scenes {acceptedScenes}/{project.scenes.length || 3}</small></button>{session.role === "OWNER" && project.state !== "READY" && <button className="danger compact" disabled={Boolean(deletingProjectId)} onClick={() => void deleteProject(project)} aria-label={`Delete ${project.publicId}`}>{deletingProjectId === project.id ? "…" : "Delete"}</button>}</div>;
  };
  const projectBrowser = <aside className="project-browser" aria-label="Campaigns and projects"><div className="project-browser-header"><h2>Campaigns</h2>{refreshButton}</div><input aria-label="Search campaigns and projects" placeholder="Search campaigns or concepts" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} /><div className="project-filters" role="group" aria-label="Project filters">{(["ALL", "ACTIVE", "REVIEW", "READY"] as const).map((filter) => <button key={filter} className={projectFilter === filter ? "active-filter" : ""} onClick={() => setProjectFilter(filter)}>{filter[0] + filter.slice(1).toLowerCase()}</button>)}</div><div className="project-list">{browserItems.map((item) => {
    if (item.kind === "PROJECT") return projectRow(item.project);
    const selectedInside = item.projects.some((project) => project.id === selected?.id) || item.owner?.id === selected?.id;
    const expanded = !collapsedCampaignIds.has(item.id) && (selectedInside || expandedCampaignIds.has(item.id));
    const readyCount = item.projects.filter((project) => project.state === "READY").length;
    const toggleCampaign = () => {
      if (expanded) setCollapsedCampaignIds((current) => new Set([...current, item.id]));
      else {
        setCollapsedCampaignIds((current) => new Set([...current].filter((id) => id !== item.id)));
        setExpandedCampaignIds((current) => new Set([...current, item.id]));
      }
    };
    const openCampaign = () => {
      setCollapsedCampaignIds((current) => new Set([...current].filter((id) => id !== item.id)));
      setExpandedCampaignIds((current) => new Set([...current, item.id]));
      if (item.owner) openProject(item.owner, "dna", true);
    };
    return <section className={`campaign-group ${selectedInside || item.owner?.id === selected?.id ? "contains-selected" : ""}`} key={item.id}><div className="campaign-header"><button className="campaign-chevron-button" aria-label={`${expanded ? "Collapse" : "Expand"} ${item.productName}`} aria-expanded={expanded} onClick={toggleCampaign}><span className="campaign-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span></button><button className="campaign-toggle" onClick={openCampaign}><span className="campaign-summary"><b>{item.productName}</b><span>Strategy Campaign</span><small>{item.projects.length} concept executions · {readyCount} ready</small></span></button></div>{expanded && <div className="campaign-projects">{item.owner && <button className="primary campaign-create-project" onClick={() => openProject(item.owner!, "strategy", true)}>+ Create Project</button>}{item.projects.map((project) => projectRow(project, true))}</div>}</section>;
  })}{browserItems.length === 0 && <p className="empty">No matching campaigns or projects.</p>}</div></aside>;
  const sidebar = <aside className="global-sidebar"><div><h1>Koolezt<br/>Creative Factory</h1><nav aria-label="Global navigation"><button className={navView === "HOME" && !selected ? "nav-active" : ""} onClick={openDashboard}>Home</button><button className="primary" onClick={() => { selectedId.current = undefined; setSelected(undefined); setShowCreateProject(true); setNavView("CREATE"); history.pushState({}, "", "/new-campaign"); }}>+ Create Campaign</button>{session.role === "OWNER" && <button className={navView === "WORKERS" ? "nav-active" : ""} onClick={() => { selectedId.current = undefined; setSelected(undefined); setShowWorkers(true); setNavView("WORKERS"); history.pushState({}, "", "/workers"); }}>Render Workers</button>}{session.role === "OWNER" && <button className={navView === "USERS" ? "nav-active" : ""} onClick={() => { selectedId.current = undefined; setSelected(undefined); setNavView("USERS"); history.pushState({}, "", "/users"); }}>Users</button>}{session.role === "OWNER" && <button className={navView === "SETTINGS" ? "nav-active" : ""} onClick={() => { selectedId.current = undefined; setSelected(undefined); setNavView("SETTINGS"); history.pushState({}, "", "/settings"); }}>Settings</button>}</nav></div><div className="session-identity"><b>{session.email || "Private session"}</b><span>{session.role}</span><small>Sign out through Cloudflare Access.</small></div></aside>;
  if (!selected) {
    return <main className="app-shell">{sidebar}{projectBrowser}<section className="workspace workspace-static"><header className="workspace-header"><div><p className="eyebrow">Production workspace</p><h2>{navView === "CREATE" ? "Create Campaign" : navView === "WORKERS" ? "Render Workers" : navView === "USERS" ? "Users" : navView === "SETTINGS" ? "Settings" : "Home"}</h2></div></header><div className="workspace-panel">{error && <p className="error" role="alert">{error}</p>}
      {navView === "HOME" && <section><h3>Production overview</h3><p>Select a project from the project browser to work without leaving this workspace.</p><p>{projects.filter((project) => project.state !== "READY").length} active projects · {projects.filter((project) => project.state === "READY").length} published projects</p></section>}
      {showWorkers && navView === "WORKERS" && session.role === "OWNER" && <section><a className="button primary" href="/api/render-worker-installer">Download Windows Installer</a><p>Each computer has an independently revocable credential. Setup codes expire after 30 minutes and work once.</p><label>Friendly name<input value={newWorkerName} maxLength={120} onChange={(event) => setNewWorkerName(event.target.value)} /></label><button className="primary" onClick={() => void api("/api/render-workers/enrollments", "POST", { displayName: newWorkerName }).then(setSetupCode).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not create setup code."))}>Add Render Worker</button>{setupCode && <div className="card"><b>Setup Code: {setupCode.setupCode}</b><p>Give this code to the editor. It expires at {new Date(setupCode.expiresAt).toLocaleTimeString()} and will not be shown again after you leave this page.</p></div>}{renderWorkers.map((worker) => <div className="card" key={worker.id}><b>{worker.displayName}</b><span>{worker.runtimeState} · Version {worker.workerVersion}</span><span>Last seen: {worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString() : "Never"}</span><button disabled={worker.revoked} onClick={() => void fetch(`/api/render-workers/${worker.id}`, { method: "DELETE" }).then((response) => { if (!response.ok) throw new Error("Could not revoke worker."); return refresh(); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not revoke worker."))}>{worker.revoked ? "Revoked" : "Revoke"}</button></div>)}</section>}
      {showCreateProject && navView === "CREATE" && <section><p>Create one Campaign workspace for shared Product authority, Creative References, and Creative Strategy. Selected concepts become isolated Video Maker executions inside it.</p><form onSubmit={(event) => { event.preventDefault(); void submitNewProject(); }}><label>Campaign / Product Name<input required maxLength={160} value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} placeholder="Vertical Pet Name Gingerbread Ornament" /></label><label>Campaign Creative Goal / Strategy Instructions<input required maxLength={1000} value={newProject.creativeTopic} onChange={(event) => setNewProject({ ...newProject, creativeTopic: event.target.value })} placeholder="Find diverse Meta-ad directions for Christmas gift shoppers" /></label><label>Campaign Product / Reference Images<input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => setReferenceFiles(Array.from(event.target.files ?? []))} /></label>{referenceFiles.map((file, index) => <span className="file" key={`${file.name}-${index}`}>{index === 0 ? "Primary" : `Reference ${index + 1}`}: {file.name}</span>)}<label>Product Details<textarea maxLength={5000} rows={6} value={newProject.productDetails} onChange={(event) => setNewProject({ ...newProject, productDetails: event.target.value })} /></label><label>Verified Product Claims (one per line)<textarea maxLength={10000} rows={5} value={verifiedClaimsText} onChange={(event)=>setVerifiedClaimsText(event.target.value)} placeholder={"Personalized with the supplied pet photo\nIncludes the customer's chosen name"} /></label><small>These Campaign inputs are shared authority. Child executions inherit immutable snapshots and cannot edit them.</small><label>Target Duration (seconds)<input type="number" required min={5} max={60} value={newProject.targetDurationSeconds} onChange={(event) => setNewProject({ ...newProject, targetDurationSeconds: Number(event.target.value) })} /></label><button className="primary" type="submit" disabled={creatingProject}>{creatingProject ? createStage || "Creating…" : "Create Campaign"}</button><button type="button" disabled={creatingProject} onClick={openDashboard}>Cancel</button></form></section>}
      {navView === "USERS" && <section><h3>Access-managed users</h3><p>Browser access and OWNER / EDITOR membership are enforced by Cloudflare Access. User changes remain an administrator action there; Creative Factory does not store separate browser credentials.</p></section>}
      {navView === "SETTINGS" && <section><h3>Settings</h3><p>Security, provider credentials, S3, and worker credentials are intentionally not editable from the browser.</p></section>}
    </div></section></main>;
  }

  const concept = selected.concepts.find((item: any) => item.id === selected.currentConceptId);
  const product = products.find((item) => item.id === selected.productId);
  const savePersonalizationAuthority=async()=>{
    if(!product||savingPersonalizationAuthority)return;
    const immutableStructure=immutableStructureText.split("\n").map((item)=>item.trim()).filter(Boolean);
    const authorizedPersonalizationFields=personalizationFieldsText.split("\n").map((item)=>item.trim()).filter(Boolean);
    const authorizedProductConfigurations=authorizedConfigurationsText.split("\n").map((item)=>item.trim()).filter(Boolean);
    const verifiedClaims=campaignVerifiedClaimsText.split("\n").map((item)=>item.trim()).filter(Boolean);
    if(!personalizationAuthorityConfirmed||immutableStructure.length===0||authorizedPersonalizationFields.length===0){
      setError("Confirm at least one immutable Product-structure rule and one authorized personalization field.");
      return;
    }
    setSavingPersonalizationAuthority(true);
    try{
      setError("");
      await api(`/api/products/${product.id}`,"PUT",{
        name:product.name,
        slug:product.slug,
        description:product.description,
        claims:verifiedClaims.map((text)=>product.claims.find((claim:any)=>claim.text===text)??{kind:"FEATURE",text}),
        defaultCta:product.defaultCta,
        ...(product.creativeNotes?{creativeNotes:product.creativeNotes}:{}),
        personalizationVisualAuthority:{
          status:"OPERATOR_CONFIRMED",
          immutableStructure,
          authorizedPersonalizationFields,
          ...(authorizedProductConfigurations.length?{authorizedProductConfigurations}:{})
        },
        assets:product.assets
      });
      await refresh(selected.id);
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not save Product visual authority.");}
    finally{setSavingPersonalizationAuthority(false);}
  };
  const productAssetsById = new Map((product?.assets ?? []).map((item: any) => [item.id, item]));
  const productReferences = selected.selectedProductAssetIds.flatMap((id: string) => {
    const asset = productAssetsById.get(id);
    return asset ? [asset] : [];
  });
  const addCampaignReference = async (file: File) => {
    setCampaignReferenceWorking(true);
    setError("");
    try {
      await uploadProductReference({
        projectId: selected.id,
        file,
        order: selected.selectedProductAssetIds.length,
        label: `Reference ${selected.selectedProductAssetIds.length + 1}`,
        onStage: setCampaignReferenceStage
      });
      await refresh(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add Campaign Product reference.");
    } finally {
      setCampaignReferenceWorking(false);
    }
  };
  const makePrimaryCampaignReference = async (assetId: string) => {
    setCampaignReferenceWorking(true);
    setError("");
    try {
      await api(`/api/projects/${selected.id}/product-references/${assetId}/primary`, "PUT");
      await refresh(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change the primary Product reference.");
    } finally {
      setCampaignReferenceWorking(false);
    }
  };
  const voice = selected.voiceGenerations.find((item: any) => item.id === selected.currentVoiceGenerationId) ?? selected.voiceGenerations.at(-1);
  const candidateVoice = selected.candidateVoiceGenerationId ? selected.voiceGenerations.find((item: any) => item.id === selected.candidateVoiceGenerationId) : undefined;
const reviewVoice = candidateVoice ?? voice;
  const reviewVoiceRevision = reviewVoice?.narrationRevisionId ? selected.narrationRevisions?.find((item: any) => item.id === reviewVoice.narrationRevisionId) : undefined;
  const targetDurationMs = concept?.targetDurationMs ?? (selected.creativeBrief?.targetDurationSeconds ?? 15) * 1000;
  const estimatedVoiceDurationMs = estimateNarrationDurationMs(voiceScript);
  const estimatedTiming = assessVoiceTiming(targetDurationMs, estimatedVoiceDurationMs || undefined);
  const voiceDurationMs = reviewVoice?.inspection?.durationMs as number | undefined;
  const actualTiming = assessVoiceTiming(targetDurationMs, voiceDurationMs);
  const voiceTiming = actualTiming.classification === "GOOD" ? "Good" : actualTiming.classification === "TOO_SHORT" ? "Too short" : actualTiming.classification === "TOO_LONG" ? "Too long" : "Unknown";
  const voiceTimingNeedsWarning = voiceTiming === "Too short" || voiceTiming === "Too long";
  const render = selected.renders.find((item: any) => item.id === selected.currentRenderId) ?? selected.renders.at(-1);
  const candidateRender = selected.candidateRenderId ? selected.renders.find((item: any) => item.id === selected.candidateRenderId) : undefined;
  const ownerReviewRender = selected.ownerReviewRenderId ? selected.renders.find((item: any) => item.id === selected.ownerReviewRenderId) : undefined;
  const onlineWorkers = renderWorkers.filter((worker) => worker.runtimeState !== "OFFLINE" && !worker.revoked);
  const compatibleVariantWorkerOnline = onlineWorkers.some((worker) => worker.capabilities?.includes("variant-effects-v1"));
  const workerReconnectControls = <div className="worker-reconnect"><button className="primary" onClick={reconnectRenderWorker}>Reconnect Render Worker</button><button onClick={() => void refresh(selected.id)}>Check Connection</button><small>Use Reconnect on the editor PC only. It opens the installed worker locally and then checks its secure heartbeat.</small></div>;
  const acceptedScenes = selected.scenes.filter((scene: any) => {
    const attempt = scene.attempts.find((candidate: any) => candidate.id === scene.approvedAttemptId);
    const imageSource = attempt?.sourceType === "PRODUCT_IMAGE" || attempt?.sourceType === "EXISTING_ASSET";
    return attempt?.status === "ACCEPTED" && attempt?.outputAssetId && (attempt?.inspection?.passed || imageSource);
  }).length;
  const voiceAccepted = voice?.status === "ACCEPTED" && voice?.outputAssetId && voice?.inspection?.passed;
const editorReady = selected.scenes.length > 0 && acceptedScenes === selected.scenes.length && Boolean(voiceAccepted);
  const showVoiceEditor = ["VOICE_REVIEW", "VOICE_GENERATING"].includes(selected.state) || (selected.state === "READY" && voiceEditorOpen);
  const uploadContextImage = async (sceneId: string, file: File) => {
    const stage = (value: string) => setContextImageUploadStages((current) => ({ ...current, [sceneId]: value }));
    if (!contextImageFidelityConfirmations[sceneId]) throw new Error("Confirm that the final composite preserves the exact authoritative finished Product before uploading.");
    stage("Uploading…");
    try {
      const bytes = await file.arrayBuffer();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const authorization = await fetch(`/api/projects/${selected.id}/scenes/${sceneId}/context-image/upload`, {
        method: "POST",
        headers: { "x-koolezt-actor": "web-user", "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size, sha256: checksum, productFidelityConfirmed: true })
      });
      const target = await authorization.json().catch(() => ({}));
      if (!authorization.ok) throw new Error(target.message ?? "Context image upload authorization failed");
      if (!target.uploaded) {
        const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: file });
        if (!put.ok) throw new Error(`Direct context image upload failed with HTTP ${put.status}.`);
        stage("Verifying…");
        const project = await api(`/api/projects/${selected.id}/scenes/${sceneId}/context-image/complete`, "POST", { assetId: target.assetId });
        selectedId.current = project.id;
        setSelected(project);
      } else await refresh(selected.id);
      stage("Ready for video");
      setContextImageFidelityConfirmations((current) => ({ ...current, [sceneId]: false }));
    } catch (reason) {
      stage("Failed");
      throw reason;
    }
  };
  const upload = async (sceneId: string, file: File, provider: string) => {
    const stage = (value: string) => setUploadStages((current) => ({ ...current, [sceneId]: value }));
    stage("Uploading…");
    try {
      const bytes = await file.arrayBuffer();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const authorization = await fetch(`/api/projects/${selected.id}/scenes/${sceneId}/manual-video/upload`, {
        method: "POST",
        headers: { "x-koolezt-actor": "web-user", "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size, sha256: checksum, provider })
      });
      const target = await authorization.json().catch(() => ({}));
      if (!authorization.ok) {
        if (target.error !== "DIRECT_UPLOAD_DISABLED") throw new Error(target.message ?? "Upload authorization failed");
        const form = new FormData();
        form.append("provider", provider);
        form.append("file", file);
        const legacy = await fetch(`/api/projects/${selected.id}/scenes/${sceneId}/manual-video`, { method: "POST", headers: { "x-koolezt-actor": "web-user" }, body: form });
        const project = await legacy.json().catch(() => ({}));
        if (!legacy.ok) throw new Error(project.message ?? "Manual video upload failed");
        selectedId.current = project.id;
        setSelected(project);
        stage("Ready");
        return;
      }
      const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: file });
      if (!put.ok) throw new Error(`Direct media upload failed with HTTP ${put.status}.`);
      stage("Verifying…");
      stage("QA…");
      const project = await api(`/api/projects/${selected.id}/scenes/${sceneId}/manual-video/complete`, "POST", { assetId: target.assetId, provider });
      selectedId.current = project.id;
      setSelected(project);
      stage("Ready");
    } catch (reason) {
      stage("Failed");
      throw reason;
    }
  };

  const campaignTabs = [["dna", "Winning Creative"], ["strategy", "Concepts"]] as const;
  const executionTabs = [["brief", "Creative Brief"], ["scenes", "Scene Review"], ["voice", "Voice"], ["final", "Published Final"], ["variants", "Creative Variants"]] as const;
  const tabs = campaignWorkspaceView ? campaignTabs : executionTabs;
  const activeStrategyOperation = strategyBatches.some((entry: any) => ["PENDING", "GENERATING", "VALIDATING"].includes(entry.batch.status));
  return <main className="app-shell">{sidebar}{projectBrowser}<section className="workspace" data-active-tab={workspaceTab}><header className="workspace-header"><div><p className="eyebrow">{selected.publicId}</p><h2>{product?.name ?? "Creative project"}</h2><span className="status-pill">{selected.state}</span></div><div className="workspace-tabs" role="tablist" aria-label="Project workspace">{tabs.map(([tab, label]) => <button key={tab} id={`tab-${tab}`} role="tab" aria-selected={workspaceTab === tab} aria-controls={`panel-${tab}`} className={workspaceTab === tab ? "tab-active" : ""} onClick={() => selectWorkspace(tab)}>{label}</button>)}</div></header><div className="workspace-panel">{error && <p className="error" role="alert">{error}</p>}
    {campaignWorkspaceView && selected.campaignWorkspace && <div className="card campaign-product-references"><h3>Campaign Product References</h3><p>The Primary image is the first visual reference sent to AI for future Strategy batches and future Video Maker snapshots.</p><div className="references">{productReferences.map((asset: any, index: number) => <div key={asset.id}><img className="thumb" src={`/api/assets/${asset.id}`} alt={asset.label} /><p><b>{index === 0 ? "Primary" : `Reference ${index + 1}`}</b></p>{index > 0 && <button disabled={campaignReferenceWorking} onClick={() => void makePrimaryCampaignReference(asset.id)}>Make Primary</button>}</div>)}</div><label>Add Product reference<input type="file" accept="image/png,image/jpeg,image/webp" disabled={campaignReferenceWorking || selected.state !== "DRAFT"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void addCampaignReference(file); event.currentTarget.value = ""; }} /></label>{campaignReferenceStage && <span> {campaignReferenceStage}</span>}<p><small>Changes apply only to future Strategy batches and handoffs. Existing immutable snapshots and historical executions are never rewritten.</small></p></div>}
    {campaignWorkspaceView && selected.campaignWorkspace && <div className="card campaign-product-authority"><h3>Campaign Product Visual Authority</h3><p>Configure personalization once for this Campaign before sending Concepts to Video Maker. These permissions are Product-specific visual authority, not factual Product claims.</p><label>Preserve - immutable Product structure (one rule per line)<textarea rows={5} value={immutableStructureText} onChange={event=>setImmutableStructureText(event.target.value)} placeholder={"Overall silhouette\nOrientation and geometry\nLayout architecture\nMounting configuration\nProduct family / SKU"} /></label><label>May vary - authorized personalization fields (one per line)<textarea rows={4} value={personalizationFieldsText} onChange={event=>setPersonalizationFieldsText(event.target.value)} placeholder={"Pet artwork/design\nHouse number\nStreet text/name"} /></label><label>Allowed Product configurations (optional, one per line)<textarea rows={3} value={authorizedConfigurationsText} onChange={event=>setAuthorizedConfigurationsText(event.target.value)} placeholder={"Wall-mounted\nGarden-stake mounted"} /></label><label>Verified Product Claims (one per line)<textarea rows={6} value={campaignVerifiedClaimsText} onChange={event=>setCampaignVerifiedClaimsText(event.target.value)} placeholder={"Optional garden stake mounting is available"} /></label><p><small>An allowed configuration must also be supported by a verified Product claim. Do not repeat allowed configurations in the Preserve list.</small></p><label><input type="checkbox" checked={personalizationAuthorityConfirmed} onChange={event=>setPersonalizationAuthorityConfirmed(event.target.checked)} /> I confirm these visual permissions for this Campaign Product.</label><button className="primary" disabled={savingPersonalizationAuthority||!personalizationAuthorityConfirmed||selected.state!=="DRAFT"} onClick={()=>void savePersonalizationAuthority()}>{savingPersonalizationAuthority?"Saving...":product?.personalizationVisualAuthority?"Update Campaign Product Authority":"Save Campaign Product Authority"}</button>{product?.personalizationVisualAuthority?<p><small>Configured. Future Strategy batches and handoffs use this authority; existing immutable snapshots are unchanged.</small></p>:<p><small>Not configured. Winner DNA that requires multiple personalized results may be blocked until authority is saved.</small></p>}</div>}
    <section id="panel-dna" role="tabpanel" aria-labelledby="tab-dna" data-workspace="dna"><h3>Creative References</h3><p>Upload historical ads, record optional historical context, then explicitly analyze their execution DNA. Uploading never calls OpenAI.</p><div className="card creative-reference-form"><label>Display name<input value={referenceDraft.displayName} onChange={e=>setReferenceDraft({...referenceDraft,displayName:e.target.value})} /></label><label>Status<select value={referenceDraft.operatorStatus} onChange={e=>setReferenceDraft({...referenceDraft,operatorStatus:e.target.value})}><option>WINNER</option><option>CONTROL</option><option>REFERENCE</option><option>LOSER</option></select></label><label>Platform<input value={referenceDraft.platform} onChange={e=>setReferenceDraft({...referenceDraft,platform:e.target.value})} /></label><label>Operator notes<textarea rows={3} value={referenceDraft.operatorNotes} onChange={e=>setReferenceDraft({...referenceDraft,operatorNotes:e.target.value})} /></label><label>Optional transcript<textarea rows={3} value={referenceDraft.operatorTranscript} onChange={e=>setReferenceDraft({...referenceDraft,operatorTranscript:e.target.value})} /></label><label>Optional historical performance JSON<textarea rows={3} placeholder='{"spend":100,"purchases":3,"currency":"USD","dateStart":"2025-01-01","dateEnd":"2025-01-31","metricSource":"operator export"}' value={referenceDraft.performance} onChange={e=>setReferenceDraft({...referenceDraft,performance:e.target.value})} /></label><label>Source video (required)<input ref={referenceVideoInput} type="file" accept="video/mp4,video/webm,.mp4,.webm" disabled={dnaWorking} onChange={e=>selectReferenceVideo(e.target.files?.[0])} /></label><p className="source-video-selection">{referenceVideo?<><b>Selected:</b> {referenceVideo.name} ({(referenceVideo.size/1024/1024).toFixed(1)} MB) <button type="button" disabled={dnaWorking} onClick={clearReferenceVideo}>Remove selected video</button></>:"No source video selected. Choose an MP4 or WebM file."}</p>{referenceUploadError&&<p className="error" role="alert">{referenceUploadError}</p>}{referenceUploadProgress!==undefined&&<div className="upload-progress" aria-live="polite"><progress max={100} value={referenceUploadProgress} /><span>{referenceUploadProgress<100?`Uploading source video… ${referenceUploadProgress}%`:"Upload complete. Registering Creative Reference…"}</span></div>}<button type="button" className="primary" disabled={dnaWorking||!referenceVideo} onClick={()=>void uploadCreativeReference()}>{dnaWorking?"Uploading…":"Create Creative Reference"}</button></div>{creativeReferences.map((entry:any)=>{const ref=entry.reference;const latest=entry.revisions.at(-1);const media=entry.sourceMedia;const durationMs=latest?.mediaMetadata?.durationMs??media?.durationMs;const editable=latest?Object.fromEntries(Object.entries(latest).filter(([key])=>!["id","creativeReferenceId","revision","status","source","mediaMetadata","providerMetadata","createdBy","createdAt","operatorNotes"].includes(key))):undefined;return <article className="card" key={ref.id}><h4>{ref.displayName}</h4><p>{ref.operatorStatus} · {ref.platform??"Platform not supplied"} · {ref.analysisStatus}</p><p><b>Source:</b> {media?.filename??"Historical source video"} · {media?.status??"AVAILABLE"}{durationMs?` · ${(durationMs/1000).toFixed(1)}s`:""}</p>{ref.performance&&<p><small>Historical operator-supplied performance ({ref.performance.dateStart??"date unknown"}–{ref.performance.dateEnd??"date unknown"}); not a prediction.</small></p>}<video controls preload="metadata" src={`/api/assets/${ref.sourceAssetId}`} />{ref.analysisStatus==="NOT_ANALYZED"&&<button className="primary" disabled={dnaWorking} onClick={()=>void analyzeCreativeDna(ref.id)}>Analyze Creative DNA (OpenAI)</button>}{ref.analysisStatus==="ANALYZING"&&<p>Analyzing Creative DNA in the background… <button onClick={()=>void refresh(selected.id)}>Refresh Status</button></p>}{["SUBMISSION_UNKNOWN","RESULT_UNAVAILABLE"].includes(ref.analysisStatus)&&<p className="error">Automatic resubmission is disabled. Preserve this operation for review.</p>}{latest&&<><p><b>Revision {latest.revision} · {latest.status}</b></p><p><b>Opening:</b> {latest.openingPattern}</p><p><b>Product prominence:</b> {latest.productProminence}</p><p><b>CTA:</b> {latest.ctaPattern}</p><p><b>Preserve:</b> {latest.preserveTraits.join(" · ")||"None identified"}</p><p><b>Safe to vary:</b> {latest.safeToVaryTraits.join(" · ")||"None identified"}</p><p><b>Avoid:</b> {latest.avoidTraits.join(" · ")||"None identified"}</p><details><summary>Review/edit structured DNA</summary><textarea rows={20} value={dnaEdits[latest.id]??JSON.stringify(editable,null,2)} onChange={e=>setDnaEdits({...dnaEdits,[latest.id]:e.target.value})} /><button disabled={dnaWorking} onClick={()=>void saveDnaEdit(ref.id,latest)}>Save as New Draft Revision</button></details>{latest.status==="DRAFT"&&<button className="primary" disabled={dnaWorking} onClick={()=>void approveCreativeDna(ref.id,latest.id)}>Approve DNA Revision</button>}</>}</article>;})}</section>
    <section id="panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" data-workspace="strategy"><h3>Creative Strategy</h3><p>Generate lightweight, AI-executable advertising directions before spending on video or voice. One initial OpenAI request is allowed, followed by at most one automatic targeted repair request.</p><div className="card"><p>{strategyBatches.length === 0 ? "No strategy batch exists yet." : activeStrategyOperation ? "Strategy generation is already active. Refresh its status instead of generating again." : "Create a new immutable Strategy batch when you are ready for another paid generation."}</p><fieldset disabled={strategyWorking || activeStrategyOperation}><legend>Concept count</legend>{([{count:3,label:"Quick"},{count:6,label:"Standard (recommended)"},{count:12,label:"Explore"}] as const).map((option) => <label key={option.count}><input type="radio" name="strategy-count" checked={strategyRequestedCount === option.count} onChange={() => setStrategyRequestedCount(option.count)} /> {option.count} — {option.label}</label>)}</fieldset><button className="primary" disabled={strategyWorking || selected.state !== "DRAFT" || activeStrategyOperation} onClick={() => void generateStrategyConcepts()}>{strategyWorking ? "Starting…" : strategyBatches.length === 0 ? `Generate ${strategyRequestedCount} Strategy Concepts` : `Generate New ${strategyRequestedCount}-Concept Batch`}</button>{selected.state !== "DRAFT" && <p><small>This legacy project has already entered Video Maker. Create a new strategy source project to preserve its workflow history.</small></p>}</div>{strategyBatches.map((entry: any, batchIndex: number) => { const batch = entry.batch; const selectable = entry.concepts.filter((item: any) => item.currentRevision.diversityState === "DISTINCT" && item.currentRevision.productionSafetyState === "PRODUCTION_SAFE"); const selectedForBatch = selectedStrategyRevisionIds.filter((id) => selectable.some((item: any) => item.currentRevision.id === id)); return <div className="card strategy-batch" key={batch.id}><div className="batch-header"><div><b>Strategy Batch {strategyBatches.length - batchIndex}</b><p>{batch.status} · {batch.validationSummary?.valid ?? 0}/{batch.requestedCount} distinct and production-safe</p></div><button disabled={refreshing} onClick={() => void refresh(selected.id)}>Refresh Status</button></div>{["PENDING","GENERATING","VALIDATING"].includes(batch.status) ? <p>Generating Strategy… {batch.validationSummary?.providerExecution?.status ? `OpenAI status: ${batch.validationSummary.providerExecution.status}. ` : ""}The background response is recoverable and no media providers are being called.</p> : batch.status === "SUBMISSION_UNKNOWN" ? <p className="error">OpenAI submission outcome is unknown. Automatic retry is disabled; this batch is preserved for audit.</p> : batch.status === "RESULT_UNAVAILABLE" ? <p className="error">The known OpenAI response is no longer retrievable. Automatic resubmission is disabled; start a new batch only after review.</p> : <><div className="strategy-grid">{entry.concepts.map((item: any) => { const revision = item.currentRevision; const ready = revision.diversityState === "DISTINCT" && revision.productionSafetyState === "PRODUCTION_SAFE"; return <article className={`strategy-card ${ready ? "strategy-ready" : "strategy-issue"}`} key={revision.id}><label className="strategy-select"><input type="checkbox" disabled={!ready || (!selectedStrategyRevisionIds.includes(revision.id) && selectedForBatch.length >= 3)} checked={selectedStrategyRevisionIds.includes(revision.id)} onChange={() => toggleStrategySelection(revision.id, selectable.map((concept: any) => concept.currentRevision.id))} /> Select</label><p className="eyebrow">Concept {item.ordinal} · {revision.conceptFamily}</p><h4>{revision.conceptName}</h4><p><b>Buyer context:</b> {revision.buyerPersona}</p><p><b>Core angle:</b> {revision.coreAngle}</p><p><b>Hook:</b> {revision.hook}</p><p><b>Opening:</b> {revision.openingVisualPattern}</p><p><b>Format:</b> {revision.creativeFormat}</p><p><b>Production:</b> {revision.primaryProductionMethod}{revision.supportingProductionMethods?.length ? ` + ${revision.supportingProductionMethods.join(", ")}` : ""}</p><p><b>Visual execution:</b> {revision.creativeVisualExecutionNotes}</p><p><b>Proof:</b> {revision.proofMechanism}</p><p><b>Why different:</b> {revision.differentiationSummary}</p><p><small>{revision.diversityState} · {revision.productionSafetyState}</small></p>{revision.validationFindings?.length ? <ul>{revision.validationFindings.map((finding: string) => <li key={finding}>{finding}</li>)}</ul> : null}</article>; })}</div>{batch.status === "REVIEW_WITH_ISSUES" && <button disabled={strategyWorking} onClick={() => void replaceFlaggedStrategies(batch.id)}>Replace Flagged Concepts (OpenAI)</button>}{batch.status === "HANDED_OFF" && <p><small>These Strategy concepts are immutable and may be sent again. Current Campaign Product authority creates a fresh Video Maker snapshot; existing projects remain unchanged.</small></p>}<button className="primary" disabled={strategyWorking || selectedForBatch.length < 1 || selectedForBatch.length > 3} onClick={() => void sendStrategiesToVideoMaker(batch.id, selectedForBatch)}>{batch.status === "HANDED_OFF" ? "Create New Video Maker Project" : "Send Selected to Video Maker"} ({selectedForBatch.length}/3)</button></>}</div>; })}</section>
    {workspaceTab==="strategy"&&<div className="card"><label>Winner Creative Reference for Video Maker<select value={selectedWinnerDnaRevisionId} onChange={event=>setSelectedWinnerDnaRevisionId(event.target.value)}><option value="">None</option>{approvedWinnerDna.map((item:any)=><option key={item.revision.id} value={item.revision.id}>{item.reference.displayName} · DNA revision {item.revision.revision}</option>)}</select></label><p><small>Optional. Only approved Winning Creative owned by this Campaign is available. Strategy controls why the customer buys; Winner DNA influences execution only and is immutably snapshotted at handoff.</small></p></div>}
    <section id="panel-brief" role="tabpanel" aria-labelledby="tab-brief" data-workspace="brief"><h3>Creative Brief</h3><p><b>Product:</b> {product?.name ?? "Creative project"}</p>
      <p><b>Angle:</b> {selected.creativeBrief?.creativeTopic ?? product?.creativeNotes ?? concept?.angle ?? "Not provided"}</p>
      <p><b>Product Details:</b> {selected.creativeBrief?.productDetails || product?.description || "Not provided"}</p>
      {!selected.campaignWorkspace&&!selected.strategyOrigin&&!selected.creativeInputSnapshot&&selected.state==="DRAFT"&&<div className="card"><h4>Personalized-Product Visual Authority</h4><p>Explicitly confirm what must stay structurally identical and which visible fields may vary. This permission is Product-specific and is not a factual Product claim.</p><label>Immutable Product structure (one rule per line)<textarea rows={5} value={immutableStructureText} onChange={event=>setImmutableStructureText(event.target.value)} placeholder={"Overall silhouette\nOrientation and geometry\nMounting configuration"} /></label><label>Authorized personalization fields (one per line)<textarea rows={4} value={personalizationFieldsText} onChange={event=>setPersonalizationFieldsText(event.target.value)} placeholder={"Pet artwork/design\nHouse number\nStreet text/name"} /></label><label><input type="checkbox" checked={personalizationAuthorityConfirmed} onChange={event=>setPersonalizationAuthorityConfirmed(event.target.checked)} /> I confirm these visual permissions for this specific Product.</label><button disabled={savingPersonalizationAuthority||!personalizationAuthorityConfirmed} onClick={()=>void savePersonalizationAuthority()}>{savingPersonalizationAuthority?"Saving…":"Save Product Visual Authority"}</button></div>}
      {product?.personalizationVisualAuthority&&<div className="card"><p><b>Operator-confirmed visual authority</b></p><p><b>Preserve:</b> {product.personalizationVisualAuthority.immutableStructure.join(" · ")}</p><p><b>May vary:</b> {product.personalizationVisualAuthority.authorizedPersonalizationFields.join(" · ")}</p>{product.personalizationVisualAuthority.authorizedProductConfigurations?.length?<p><b>Allowed configurations:</b> {product.personalizationVisualAuthority.authorizedProductConfigurations.join(" · ")}</p>:null}</div>}
      {selected.executionFeasibility&&<div className="card"><p><b>Execution feasibility:</b> {selected.executionFeasibility.status}</p>{selected.executionFeasibility.requirements.map((item:any)=><p key={item.code} className={item.resolution==="UNSUPPORTED_REQUIRED"?"error":""}><b>{item.resolution}:</b> {item.requirement}<br/><small>{item.reason}</small></p>)}</div>}
      <p><b>Duration:</b> {selected.creativeBrief?.targetDurationSeconds ?? Math.round((concept?.targetDurationMs ?? 15000) / 1000)}s</p>
      <div><b>References:</b>{productReferences.length === 0 ? " None uploaded" : productReferences.map((asset: any, index: number) => <span key={asset.id}><img className="thumb" src={`/api/assets/${asset.id}`} alt={asset.label} />{index === 0 ? "Primary" : `Reference ${index + 1}`}</span>)}</div>
      {selected.strategyOrigin && <p><b>Authoritative strategy:</b> linked immutable revision {selected.strategyOrigin.conceptRevisionId}</p>}
      {selected.winnerDnaOrigin && <p><b>Winner Creative DNA:</b> linked immutable revision {selected.winnerDnaOrigin.revisionId} (execution guidance only)</p>}
      {selected.creativeInputSnapshot&&<div className="card handoff-authority"><p><b>Creative Input Snapshot:</b> {selected.creativeInputSnapshot.id} · {selected.creativeInputSnapshot.sha256}</p><p><b>Strategy:</b> {selected.creativeInputSnapshot.input.selectedStrategy?.conceptName??"None"}</p><p><b>Winner DNA:</b> {selected.creativeInputSnapshot.input.selectedWinnerDna?`${selected.creativeInputSnapshot.input.selectedWinnerDna.referenceDisplayName} · revision ${selected.creativeInputSnapshot.input.selectedWinnerDna.revision}`:"None"}</p><p><b>Execution inheritance:</b> {selected.creativeInputSnapshot.input.selectedWinnerDna?.preserveTraits.join(" · ")||"None"}</p><p><b>Product truth:</b> {selected.creativeInputSnapshot.input.claims.length} verified claim(s); Strategy factual constraints remain authoritative.</p><p><b>Visual Product references:</b> {selected.creativeInputSnapshot.input.selectedAssets.length} selected asset(s); historical Winner visuals do not replace them.</p></div>}
      {concept ? <><p><b>Hook:</b> {concept.hook}</p><p><b>Approved angle:</b> {concept.angle}</p>{selected.state === "CONCEPT_REVIEW" && <><button className="primary" disabled={approvingConcept} onClick={() => void approveConcept()}>{approvingConcept ? "Approving…" : "Approve Concept & Continue"}</button><button disabled={approvingConcept} onClick={() => void action(`/api/projects/${selected.id}/concept/reset`)}>Discard Concept and Regenerate</button></>}{selected.scenes.length === 3 && <button onClick={() => selectWorkspace("scenes")}>Next: Review Scenes</button>}</> : selected.strategyRequired && !selected.strategyOrigin ? <p className="error">Select one to three production-safe strategies in Creative Strategy before generating a Creative Concept.</p> : selected.state === "CONCEPT_GENERATING" ? <div className="card"><p><b>Generating Creative Concept…</b></p><p>{selected.conceptGenerationStatus?.providerStatus ? `OpenAI status: ${selected.conceptGenerationStatus.providerStatus}. ` : "Waiting for provider. "}The durable background response will resume from its saved Response ID.</p><button disabled={refreshing} onClick={() => void refresh(selected.id)}>Refresh Status</button></div> : ["SUBMISSION_UNKNOWN","RESULT_UNAVAILABLE","FAILED","REJECTED"].includes(selected.conceptGenerationStatus?.operationState) ? <div className="card"><p className="error">{selected.conceptGenerationStatus.operationState === "SUBMISSION_UNKNOWN" ? "Submission outcome is unknown; automatic retry is disabled." : selected.conceptGenerationStatus.operationState === "RESULT_UNAVAILABLE" ? "The known provider result is no longer retrievable; automatic resubmission is disabled." : "The previous Creative Concept operation ended safely without an accepted concept."}</p>{selected.conceptGenerationStatus?.message && <p><small>{selected.conceptGenerationStatus.message}</small></p>}{selected.conceptGenerationStatus?.validationFindings?.length?<ul className="validation-findings">{selected.conceptGenerationStatus.validationFindings.map((finding:string)=><li key={finding}>{finding}</li>)}</ul>:null}<button className="primary" disabled={selected.state !== "DRAFT"} onClick={() => void action(`/api/projects/${selected.id}/concept`)}>Start New Explicit Creative Concept Attempt</button><button disabled={refreshing} onClick={() => void refresh(selected.id)}>Refresh Status</button></div> : <button className="primary" disabled={selected.state !== "DRAFT"} onClick={() => void action(`/api/projects/${selected.id}/concept`)}>Generate Creative Concept from Selected Strategy</button>}
    </section>{selected.scenes.length === 3 ? <section id="panel-variants" role="tabpanel" aria-labelledby="tab-variants" data-workspace="variants"><h3>Creative Variants</h3><p>Create a meaningful 3 × 4 advertising test batch. Existing published finals and historical B01 remain unchanged.</p>
      <h4>Step 1 — Creative Copy</h4><p><small>Manual edits are free. Generate 4 Creative Angles uses OpenAI only when clicked.</small></p><button disabled={variantWorking || !concept} onClick={() => void generateCreativePackages()}>{variantCopyGenerating ? "Generating Creative Angles…" : "Generate 4 Creative Angles"}</button>{variantCopyError && <p className="error" role="alert">{variantCopyError}</p>}
      <div className="creative-package-grid">{(["A","B","C","D"] as const).map((slot) => { const item=creativePackages.find((candidate:any)=>candidate.slot===slot); const revision=item?.currentRevision ?? {angleName:"",hook:"",narrationText:"",cta:"",secondaryOverlay:""}; const update=(field:string,value:string)=>setCreativePackages((items:any[])=>{const next=items.filter((candidate:any)=>candidate.slot!==slot);return [...next,{...(item??{slot}),currentRevision:{...revision,[field]:value}}].sort((a:any,b:any)=>a.slot.localeCompare(b.slot));}); return <div className="card package-card" key={slot}><b>Package {slot}</b><label>Angle<input maxLength={160} value={revision.angleName} onChange={(event)=>update("angleName",event.target.value)} /></label><label>Hook<input maxLength={160} value={revision.hook} onChange={(event)=>update("hook",event.target.value)} placeholder="3–8 words" /></label><label>Narration<textarea rows={4} maxLength={10000} value={revision.narrationText} onChange={(event)=>update("narrationText",event.target.value)} /></label><label>CTA<input maxLength={160} value={revision.cta} onChange={(event)=>update("cta",event.target.value)} /></label><label>Secondary overlay (optional)<input maxLength={160} value={revision.secondaryOverlay ?? ""} onChange={(event)=>update("secondaryOverlay",event.target.value)} /></label><p><small>Estimated narration: ~{(estimateNarrationDurationMs(revision.narrationText)/1000).toFixed(1)}s · target {(concept?.targetDurationMs ?? 15000) / 1000}s</small></p><button disabled={variantWorking || !revision.angleName || !revision.hook || !revision.narrationText || !revision.cta} onClick={()=>void saveCreativePackage(slot,revision)}>Save Package {slot}</button></div>; })}</div>
      <h4>Step 2 — Variant Voices</h4><p><small>Generate Variant Voices uses OpenAI TTS only when clicked. Each package requires its own current accepted voice.</small></p><button className="primary" disabled={variantWorking || creativePackages.length!==4} onClick={()=>void generateVariantVoices()}>Generate Variant Voices</button>
      <div className="variant-voice-grid">{creativePackages.map((item:any)=>{const newest=item.voices?.[0]; const accepted=item.voices?.find((candidate:any)=>candidate.status==="ACCEPTED"); const review=item.voices?.find((candidate:any)=>candidate.status==="REVIEW"); const current=review ?? accepted ?? newest; const voicePreset=variantVoicePresets[item.slot] ?? variantVoicePresetDefaults[item.slot as keyof typeof variantVoicePresetDefaults]; const timing=current?.durationMs ? assessVoiceTiming(concept?.targetDurationMs ?? 15000,current.durationMs) : undefined; return <div className="card variant-voice-card" key={`voice-${item.slot}`}><b>Package {item.slot} voice:</b> {review ? "Review ready" : accepted ? "Current" : current?.status ?? "Missing"}{current?.durationMs ? <span> · {(current.durationMs/1000).toFixed(1)}s · {timing?.classification === "GOOD" ? "Good" : timing?.classification === "TOO_SHORT" ? "Too short" : "Too long"}</span> : null}<label>Voice style for next generation<select value={voicePreset} disabled={variantWorking} onChange={(event)=>setVariantVoicePresets((items)=>({...items,[item.slot]:event.target.value}))}>{variantVoicePresetOptions.map((preset)=><option key={preset} value={preset}>{preset}</option>)}</select></label><p><small>{review ? `New ${review.voicePreset} voice is ready to review.` : accepted ? `Current asset uses ${accepted.voicePreset}.` : "Generate a separate voice asset for this package."}</small></p><div className="variant-voice-actions"><button disabled={variantWorking} onClick={()=>void rewriteVariantNarration(item.slot)}>Rewrite to Fit (OpenAI)</button><button disabled={variantWorking} onClick={()=>void generateVariantVoices(item.slot)}>{current ? "Regenerate Voice" : "Generate Voice"}</button>{review ? <button disabled={variantWorking} onClick={()=>void acceptVariantVoice(review.id)}>Accept Voice</button> : null}</div></div>;})}</div>
      <h4>Step 3 — Render Readiness</h4>{(()=>{const currentVoices=creativePackages.filter((item:any)=>item.voices?.some((voice:any)=>voice.status==="ACCEPTED")).length;const ready=creativePackages.length===4&&currentVoices===4;return <><p>Approved scenes: {selected.scenes.filter((scene:any)=>scene.approvedAttemptId).length}/3 · Creative packages: {creativePackages.length}/4 · Current variant voices: {currentVoices}/4 · Compatible worker: {compatibleVariantWorkerOnline?"Online":"Offline — jobs will queue"}</p><button className="primary" disabled={variantWorking || !ready} onClick={()=>void createVariants()}>{variantWorking?"Creating…":"Create & Render 12 Variants"}</button>{!compatibleVariantWorkerOnline && workerReconnectControls}{!ready?<p><small>Create all four complete packages and accept four current voices before creating a Creative Diversity batch.</small></p>:null}</>})()}
      {variantBatches.map((entry) => {
        const readyVariants = entry.variants.filter((item: any) => item.status === "READY" && item.outputAssetId);
        const readyIds = readyVariants.map((item: any) => item.id);
        const selectedIds = selectedVariantIds.filter((id) => readyIds.includes(id));
        const selectedVariants = readyVariants.filter((item: any) => selectedIds.includes(item.id));
        const allReadySelected = readyIds.length > 0 && selectedIds.length === readyIds.length;
        return <div className="card batch-card" key={entry.batch.id}>
          <div className="batch-header"><div><b>Batch B{String(entry.batch.batchSequence).padStart(2,"0")}</b><p>{entry.batch.recipeVersion} · {entry.batch.status} · {readyVariants.length}/12 ready</p></div>
            <div className="batch-actions"><a className="button" href={`/api/variant-batches/${entry.batch.id}/manifest.csv`}>Download CSV Manifest</a>{session.role === "OWNER" ? <><button className="primary" disabled={selectedIds.length === 0} onClick={() => void downloadSelectedVariants(selectedVariants)}>Download Selected ({selectedIds.length})</button><button disabled={readyIds.length === 0} onClick={() => setSelectedVariantIds((current) => allReadySelected ? current.filter((id) => !readyIds.includes(id)) : [...new Set([...current, ...readyIds])])}>{allReadySelected ? "Clear Selection" : `Select All Ready (${readyIds.length})`}</button></> : null}<button className="danger" disabled={variantWorking} onClick={() => void deleteVariantBatch(entry.batch)}>Delete Batch</button><button disabled={variantWorking || !entry.variants.some((item: any) => item.status === "FAILED")} onClick={() => void retryVariants(entry.variants.filter((item: any) => item.status === "FAILED").map((item: any) => item.id))}>Retry Failed</button></div>
          </div><p className="batch-download-note"><small>Selected videos download individually from private S3. Your browser may ask once to allow multiple downloads.</small></p>
          <div className="variant-grid">{entry.variants.map((item: any) => <article className="variant-tile" key={item.id}><div className="variant-title"><b>{item.publicId.split("-").at(-1)}</b><span>Package {item.recipe.package?.slot ?? "Legacy"} · {item.treatmentFamily}</span><small>Scene {item.openingScene} opening · {item.status}</small></div>{item.outputAssetId ? <><label className="variant-select"><input type="checkbox" checked={selectedVariantIds.includes(item.id)} onChange={() => toggleVariantSelection(item.id)} /> Select for download</label><video controls preload="metadata" src={`/api/assets/${item.outputAssetId}`} /><button onClick={() => void downloadVariant(item)}>Download MP4</button></> : <p className="empty">Video not ready.</p>}{item.status === "FAILED" ? <button disabled={variantWorking} onClick={() => void retryVariants([item.id])}>Retry Variant</button> : null}</article>)}</div>
        </div>;
      })}    </section> : null}
    <section id="panel-scenes" role="tabpanel" aria-labelledby="tab-scenes" data-workspace="scenes"><h3>{selected.scenes.length === 0 && concept ? "Planned Scenes" : "Scene Review"}</h3>
      {selected.scenes.length === 0 && concept?.scenes.map((scene: any) => <div className="card" key={`concept-scene-${scene.sceneNumber}`}><b>Planned Scene {scene.sceneNumber}</b><p>{scene.purpose}</p><p>{scene.generationPrompt}</p><p>Source: {scene.sourceType}</p><p>Accuracy: {scene.accuracyRequirements?.join("; ") || "No additional restrictions"}</p></div>)}
      {selected.scenes.map((scene: any) => {
        const attempt = scene.attempts.at(-1);
        const spec = concept?.scenes.find((item: any) => item.sceneNumber === scene.sceneNumber);
        const sourceType = attempt?.sourceType ?? spec?.sourceType;
        const manualCapable = ["AI_VIDEO", "KLING_VIDEO", "PRODUCT_IMAGE"].includes(sourceType);
        const manual = attempt?.generationMethod === "MANUAL" || (sourceType === "AI_VIDEO" && !attempt?.generationMethod);
        const provider = scene.requestedVideoProvider ?? attempt?.provider ?? "seedance";
        const savedVideoPrompt = (attempt?.prompt ?? spec?.generationPrompt ?? "").trim();
        const videoPromptDraft = attempt?.id ? scenePromptDrafts[attempt.id] ?? savedVideoPrompt : savedVideoPrompt;
        const videoPromptChanged = videoPromptDraft.trim() !== savedVideoPrompt;
        const contextProductFidelityConfirmed = attempt?.providerMetadata?.contextProductFidelityConfirmed === true;
        const contextUploadConfirmed = contextImageFidelityConfirmations[scene.id] === true;
        const contextImagePrompt = spec ? buildSceneContextImagePrompt({
          productName: product?.name ?? "Product",
          purpose: spec.purpose ?? "Create the approved scene",
          generationPrompt: spec.generationPrompt ?? attempt?.prompt ?? "",
          accuracyRequirements: spec.accuracyRequirements ?? []
        }) : "";
        const newManualAttempt = () => {
          const prompt = videoPromptDraft.trim();
          if (!prompt) {
            setError("This scene is missing its generation prompt, so a replacement attempt cannot be created.");
            return;
          }
          void action(`/api/projects/${selected.id}/scenes/${scene.id}/regenerate`, { prompt, generationMethod: "manual" });
        };
        return <div className="card" key={scene.id}>
          <b>Scene {scene.sceneNumber}: {scene.status}</b><p>{spec?.purpose}</p>
          {manualCapable && <section className="scene-input-image"><h4>1. Canonical Product Reference</h4><p>Use this raw Product as visual authority. A different personalization must first exist as an operator-approved finished Product image; an image model must not invent it.</p><div className="references">{productReferences.map((asset: any) => <img className="thumb" key={asset.id} src={`/api/assets/${asset.id}`} alt={asset.label} />)}</div><h4>2. Generate Background Plate Only</h4><p>Use an image generator for the environment only. The generated background must not contain or redraw the Product.</p><details><summary>Background-only image prompt</summary><pre className="scene-prompt">{contextImagePrompt}</pre></details><button onClick={() => void navigator.clipboard.writeText(contextImagePrompt)}>Copy Background Prompt</button><h4>3. Composite the Authoritative Finished Product</h4><p>In an image editor, place the exact canonical Product—or an operator-approved finished personalization variant—onto the background plate. Do not regenerate the Product, its artwork, numbers, text, geometry, or mounting details.</p><label><input type="checkbox" checked={contextUploadConfirmed} onChange={(event) => setContextImageFidelityConfirmations((current) => ({ ...current, [scene.id]: event.target.checked }))} /> I confirm this final composite preserves the exact authoritative finished Product and changes only the environment.</label><h4>4. Upload Final Composite Context Image</h4><label>Final Context / Input Image <input type="file" accept="image/png,image/jpeg,image/webp" disabled={attempt?.status !== "PENDING" || !contextUploadConfirmed} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadContextImage(scene.id, file).catch((reason) => setError(reason instanceof Error ? reason.message : "Context image upload failed.")); }} /></label>{contextImageUploadStages[scene.id] && <span> {contextImageUploadStages[scene.id]}</span>}{attempt?.inputAssetId ? <div className="scene-context-preview"><img src={`/api/assets/${attempt.inputAssetId}`} alt={`Scene ${scene.sceneNumber} context input`} /><p>{contextProductFidelityConfirmed ? "Ready: this fidelity-confirmed composite is bound to the current video attempt." : "This historical context image needs a new fidelity-confirmed upload before video generation."}</p></div> : <p className="empty">No fidelity-confirmed final composite selected yet. Video upload/generation remains gated.</p>}</section>}
          {manualCapable && <label>Suggested Generator <select value={provider} onChange={(event) => void setSceneProvider(scene.id, event.target.value)}><option value="seedance">Seedance</option><option value="kling">Kling</option></select></label>}
          {manual && <><h4>5. Generate Video</h4><p>Manual / External · use the fidelity-confirmed context image above as the image-to-video input.</p><label>Video generation prompt<textarea rows={8} maxLength={5000} value={videoPromptDraft} onChange={(event) => attempt?.id && setScenePromptDrafts((current) => ({ ...current, [attempt.id]: event.target.value }))} /></label><p><small>Editing does not change the approved Creative Concept or historical attempts. Save the revision as a new manual attempt before copying the prompt or uploading its video.</small></p><p>Accuracy: {spec?.accuracyRequirements?.join("; ") || "No additional restrictions"}</p><button disabled={!attempt?.inputAssetId || !contextProductFidelityConfirmed || videoPromptChanged || !savedVideoPrompt} onClick={() => void navigator.clipboard.writeText(savedVideoPrompt)}>Copy Saved Video Prompt</button>{videoPromptChanged && <p className="error"><small>The prompt has unsaved changes. Create the revised manual attempt to bind this prompt to its video provenance.</small></p>}<label>Generated Video <input type="file" accept="video/mp4,video/webm" disabled={!attempt?.inputAssetId || !contextProductFidelityConfirmed || videoPromptChanged} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(scene.id, file, provider).catch((reason) => setError(reason instanceof Error ? reason.message : "Upload failed.")); }} /></label>{uploadStages[scene.id] && <span> {uploadStages[scene.id]}</span>}</>}
          {!manual && manualCapable && <p>Use <b>New Manual Attempt</b> to upload an externally generated MP4 without calling a provider.</p>}
          <p>Attempt {attempt?.attemptNumber}: {attempt?.generationMethod?.toLowerCase() ?? "api"} · {attempt?.provider ?? "not recorded"}</p>
          {attempt?.inspection && <p>QA: {attempt.inspection.passed ? "passed" : "failed"} · {attempt.inspection.durationMs}ms · {attempt.inspection.width}x{attempt.inspection.height}</p>}
          {attempt?.outputAssetId && <video controls src={`/api/assets/${attempt.outputAssetId}`} />}
          <button disabled={attempt?.status !== "REVIEW"} onClick={() => void action(`/api/projects/${selected.id}/scenes/${scene.id}/approve`, { attemptId: attempt.id })}>Accept</button>
          <button disabled={attempt?.status !== "REVIEW"} onClick={() => void action(`/api/projects/${selected.id}/scenes/${scene.id}/reject`, { attemptId: attempt.id })}>Reject</button>
          {selected.state === "FINAL_REVIEW" && <p><small>Creating a replacement returns this project to Scene Review. The current final candidate remains recorded until you render a new candidate.</small></p>}
          <button disabled={!videoPromptDraft.trim()} onClick={newManualAttempt}>{videoPromptChanged ? "Save Revised Prompt as New Manual Attempt" : manualCapable ? "New Manual Attempt" : "New Attempt"}</button>
        </div>;
      })}
      {selected.scenes.length === 3 && <div className="next-step"><button className="primary" disabled={acceptedScenes !== 3} onClick={() => selectWorkspace("voice")}>Next: Review Voice</button>{acceptedScenes !== 3 && <small>Accept all three scene videos to continue to Voice.</small>}</div>}
    </section>
    {(["READY", "FINAL_REVIEW"].includes(selected.state) && !voiceEditorOpen) ? <section id="panel-voice" role="tabpanel" aria-labelledby="tab-voice" data-workspace="voice"><h3>Voice</h3><p>Current accepted voice: {voice?.provider ?? "voice"} · {voice?.providerModel ?? voice?.voiceProfileId ?? "not recorded"}{voice?.inspection?.durationMs ? ` · ${(voice.inspection.durationMs / 1000).toFixed(1)}s` : ""}</p>{selected.state === "FINAL_REVIEW" ? <><p><small>Revising returns this project to Voice Review. The current final candidate remains recorded and is not changed.</small></p><button className="primary" onClick={() => selectWorkspace("final")}>Next: Review Final Video</button><button onClick={() => void action(`/api/projects/${selected.id}/voice/review`)}>Revise Voice</button></> : <><button className="primary" onClick={() => selectWorkspace("final")}>Next: View Published Final</button><button onClick={() => { setVoiceScript(narrationScriptFor(selected)); setVoiceEditorOpen(true); }}>Revise Voice</button></>}</section> : null}
    {showVoiceEditor ? <section id="panel-voice-editor" data-workspace="voice"><h3>{selected.state === "READY" ? "Revise Voice" : "Voice Review"}</h3><p><small>Start with the current project narration below. You can edit it free of charge; use Rewrite to Fit only when you want an OpenAI rewrite.</small></p><label>Narration Script<textarea rows={7} maxLength={10000} placeholder="Example: Make your product story the perfect finishing touch for this season." value={voiceScript} disabled={voiceRewriting || voiceGenerating || selected.state === "VOICE_GENERATING"} onChange={(event) => setVoiceScript(event.target.value)} /></label><p>Estimated duration: ~{(estimatedVoiceDurationMs / 1000).toFixed(1)}s <small>(estimate only)</small></p><p>Target range: {(estimatedTiming.minimumMs / 1000).toFixed(1)}–{(estimatedTiming.maximumMs / 1000).toFixed(1)}s · Status: {estimatedTiming.classification === "GOOD" ? "Good" : estimatedTiming.classification === "TOO_SHORT" ? "Too short" : estimatedTiming.classification === "TOO_LONG" ? "Too long" : "Unknown"}</p><p><small>Manual edits and Save Script are free. Rewrite to Fit uses OpenAI text. Generate Voice uses OpenAI TTS.</small></p><button disabled={voiceSaving || !voiceScript.trim()} onClick={() => void saveVoiceScript()}>{voiceSaving ? "Saving…" : "Save Script (Free)"}</button><button disabled={voiceRewriting || voiceGenerating || !voiceScript.trim()} onClick={() => void rewriteVoiceScript()}>{voiceRewriting ? "Rewriting…" : "Rewrite to Fit (OpenAI text)"}</button><button className="primary" disabled={voiceGenerating || voiceRewriting || selected.state === "VOICE_GENERATING" || !voiceScript.trim()} onClick={() => void generateVoice()}>{voiceGenerating || selected.state === "VOICE_GENERATING" ? "Generating…" : "Generate Voice (OpenAI TTS)"}</button>{selected.state === "READY" && <button disabled={voiceSaving || voiceRewriting || voiceGenerating} onClick={() => setVoiceEditorOpen(false)}>Cancel Revision</button>}
      {reviewVoice && <div className="card"><b>Voice Attempt {reviewVoice.attemptNumber}: {reviewVoice.provider ?? "pending"} · {reviewVoice.providerModel ?? reviewVoice.voiceProfileId}</b><p>{reviewVoice.status}</p><p>Source revision: {reviewVoiceRevision ? `Revision ${reviewVoiceRevision.revision}` : "Concept default"}</p><p>Actual voice duration: {voiceDurationMs ? `${(voiceDurationMs / 1000).toFixed(1)}s` : "Awaiting audio QA"}</p><p>Recommended: {(actualTiming.minimumMs / 1000).toFixed(1)}–{(actualTiming.maximumMs / 1000).toFixed(1)}s · Timing: {voiceTiming}</p>{voiceTimingNeedsWarning && <p className="error">Voice timing is {voiceTiming.toLowerCase()} than recommended. Edit Script / Generate New Voice, or explicitly Accept Anyway.</p>}{reviewVoice.outputAssetId && <audio controls src={`/api/assets/${reviewVoice.outputAssetId}`} />}{reviewVoice.status === "REVIEW" && <><button className="primary" onClick={() => void action(`/api/projects/${selected.id}/voice/${reviewVoice.id}/approve`)}>{voiceTimingNeedsWarning ? "Accept Anyway" : "Accept Voice"}</button><button onClick={() => void action(`/api/projects/${selected.id}/voice/${reviewVoice.id}/reject`)}>Reject</button></>}</div>}
      {selected.state === "VOICE_REVIEW" && <div className="card"><h3>Editor Checklist</h3>{selected.scenes.map((scene: any) => <p key={scene.id}>{scene.approvedAttemptId ? "✓" : "○"} Scene {scene.sceneNumber} accepted</p>)}<p>{voiceAccepted ? "✓" : "○"} Voice accepted</p><button className="primary" disabled={!editorReady} onClick={() => void action(`/api/projects/${selected.id}/editor-complete`)}>Next: Mark Editor Work Complete</button></div>}
    </section> : null}
    {selected.state === "READY_FOR_RENDER" ? <section id="panel-final" role="tabpanel" aria-labelledby="tab-final" data-workspace="final"><h3>Editor Assets Ready</h3><p>Render the final candidate on an enrolled Windows Render Worker.</p>{onlineWorkers.length === 0 ? <div className="card"><b>Render Worker is not connected.</b><p>Use Reconnect on the editor PC after sleep or hibernation, then check the secure heartbeat.</p>{workerReconnectControls}</div> : <p>Render Worker: {onlineWorkers.map((worker) => `${worker.displayName} · ${worker.runtimeState}`).join(", ")}</p>}<button className="primary" onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render Final Video</button></section> : null}
    {selected.state === "COMPOSITION_PENDING" ? <section data-workspace="final"><h3>Legacy Final Render</h3><p>This existing project is ready for an explicit final render.</p><button onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render Final Video</button></section> : null}
    {selected.state === "FINAL_REVIEW" && render?.provider === "fake-composition" ? <section data-workspace="final"><h3>Final Video</h3><p className="error">TEST RENDER — NOT PRODUCTION OUTPUT. It does not mix your accepted narration or scenes.</p><button onClick={() => void action(`/api/projects/${selected.id}/composition/review`)}>Prepare a Desktop Final Render</button></section> : null}
    {selected.state === "READY" ? <section data-workspace="final"><h3>Current Published Final</h3><p>This approved version remains live while any new candidate is rendered and reviewed.</p>{render && <div className="card"><b>{render.provider === "desktop-worker" ? "Desktop Render Worker" : render.provider ?? "composition"} · {render.providerModel ?? render.compositionStyleKey ?? "default"}</b><p>{render.status}</p>{render.outputAssetId && <video controls src={`/api/assets/${render.outputAssetId}`} />}{render.inspection && <p>Published QA: {render.inspection.passed ? "passed" : "failed"} · {render.inspection.durationMs}ms · {render.inspection.width}x{render.inspection.height}</p>}</div>}{session.role === "OWNER" && <a className="button primary" href={`/api/projects/${selected.id}/download`}>Download Final MP4</a>}<button className="primary" disabled={Boolean(candidateRender && ["PENDING", "SUBMITTED", "PROCESSING", "SUBMISSION_UNKNOWN"].includes(candidateRender.status))} onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render New Version</button>{candidateRender && <div className="card"><h3>Candidate Final Version</h3><p>{candidateRender.status === "PENDING" || candidateRender.status === "SUBMITTED" || candidateRender.status === "PROCESSING" ? "Candidate render: Waiting for Render Worker." : candidateRender.status}</p><b>{candidateRender.provider === "desktop-worker" ? "Desktop Render Worker" : candidateRender.provider ?? "composition"} · {candidateRender.providerModel ?? candidateRender.compositionStyleKey ?? "default"}{candidateRender.providerMetadata?.encoder ? ` · ${candidateRender.providerMetadata.encoder}` : ""}</b>{candidateRender.outputAssetId && <video controls src={`/api/assets/${candidateRender.outputAssetId}`} />}{candidateRender.inputSnapshot?.timeline && <p>Transition: {candidateRender.inputSnapshot.timeline.transition === "SOFT_DISSOLVE" ? "Soft dissolve" : candidateRender.inputSnapshot.timeline.transition === "CROSSFADE" ? "Crossfade" : "Cut"} · {candidateRender.inputSnapshot.timeline.transitionDurationMs}ms</p>}{candidateRender.inputSnapshot?.timeline?.transition === "SOFT_DISSOLVE" && <p>Overlay: Safe-area QA passed</p>}{candidateRender.inputSnapshot?.narration?.durationMs && <p>Voice: {(candidateRender.inputSnapshot.narration.durationMs / 1000).toFixed(1)}s</p>}{candidateRender.inspection && <p>Final QA: {candidateRender.inspection.passed ? "passed" : "failed"} · {candidateRender.inspection.durationMs}ms · {candidateRender.inspection.width}x{candidateRender.inspection.height}</p>}{candidateRender.status === "SUCCEEDED" && candidateRender.inspection?.passed ? <><button onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render Another Version</button><button className="primary" onClick={() => void action(`/api/projects/${selected.id}/submit-owner-review`)}>Submit for Owner Review</button></> : null}{["FAILED", "QA_FAILED"].includes(candidateRender.status) ? <><p className="error">Candidate render failed. The published final is unchanged.</p><button onClick={() => void action(`/api/projects/${selected.id}/render/candidate/discard`)}>Discard Candidate</button><button onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render Another Version</button></> : null}{candidateRender.status === "SUBMISSION_UNKNOWN" ? <p className="error">Candidate submission status is unknown. It will not be resubmitted automatically; the published final is unchanged.</p> : null}</div>}</section> : null}
    {["RENDERING", "FINAL_REVIEW"].includes(selected.state) ? <section data-workspace="final"><h3>{selected.state === "FINAL_REVIEW" ? "Editor Final Review" : "Final Candidate"}</h3><p>{selected.state === "RENDERING" ? (render?.status === "PROCESSING" ? "Rendering…" : "Waiting for an enrolled Render Worker…") : "Preview the completed candidate before sending it to the owner."}</p>{render && <div className="card"><b>{render.provider === "fake-composition" ? "TEST RENDER — NOT PRODUCTION OUTPUT" : `${render.provider === "desktop-worker" ? "Desktop Render Worker" : render.provider ?? "composition"} · ${render.providerModel ?? render.compositionStyleKey ?? "default"}${render.providerMetadata?.encoder ? ` · ${render.providerMetadata.encoder}` : ""}`}</b><p>{render.status}</p>{render.outputAssetId && <video controls src={`/api/assets/${render.outputAssetId}`} />}{render.inputSnapshot?.timeline && <p>Transition: {render.inputSnapshot.timeline.transition === "SOFT_DISSOLVE" ? "Soft dissolve" : render.inputSnapshot.timeline.transition === "CROSSFADE" ? "Crossfade" : "Cut"} · {render.inputSnapshot.timeline.transitionDurationMs}ms</p>}{render.inputSnapshot?.timeline?.transition === "SOFT_DISSOLVE" && <p>Overlay QA: passed</p>}{render.inputSnapshot?.narration?.durationMs && <p>Voice: {(render.inputSnapshot.narration.durationMs / 1000).toFixed(1)}s</p>}{render.inspection && <p>Final QA: {render.inspection.passed ? "passed" : "failed"} · {(render.inspection.durationMs / 1000).toFixed(1)}s · {render.inspection.width}x{render.inspection.height}</p>}{selected.state === "FINAL_REVIEW" && render.provider !== "fake-composition" && <><button onClick={() => void action(`/api/projects/${selected.id}/render`, { provider: "desktop-worker" })}>Render Another Version</button><button className="primary" disabled={!render.outputAssetId || !render.inspection?.passed} onClick={() => void action(`/api/projects/${selected.id}/submit-owner-review`)}>Submit for Owner Review</button></>}</div>}</section> : null}
    {selected.state === "OWNER_REVIEW" && ownerReviewRender ? <section data-workspace="final"><h3>Owner Review</h3><p>Final Candidate</p><div className="card"><b>Desktop Render Worker · {ownerReviewRender.providerModel ?? "local-ffmpeg"}</b>{ownerReviewRender.outputAssetId && <video controls src={`/api/assets/${ownerReviewRender.outputAssetId}`} />}{ownerReviewRender.inspection && <p>Final QA: {ownerReviewRender.inspection.passed ? "passed" : "failed"} · {(ownerReviewRender.inspection.durationMs / 1000).toFixed(1)}s · {ownerReviewRender.inspection.width}x{ownerReviewRender.inspection.height}</p>}{session.role === "OWNER" ? <><button className="primary" onClick={() => void action(`/api/projects/${selected.id}/ready`)}>Approve & Save to READY</button><button onClick={() => void action(`/api/projects/${selected.id}/request-another-version`)}>Request Another Version</button></> : <p>Awaiting owner decision.</p>}</div></section> : null}</div></section></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
