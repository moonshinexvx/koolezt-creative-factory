import { resolve } from "node:path";
import { CompositionProviderRegistry, CreativeDnaService, CreativeFactoryService, CreativeStrategyService, isMetaVideoUrl, MetaWinnerService, VideoProviderRegistry } from "@koolezt/application";
import { DomainError } from "@koolezt/domain";
import { DesktopCompositionProvider, PostgresCreativeDnaStore, PostgresCreativeStrategyStore, PostgresDesktopRenderJobStore, PostgresDurableMediaAssetCatalog, PostgresExternalMediaStagingStore, PostgresFactoryRepository, PostgresMediaAssetCatalog, PostgresRenderWorkerIdentityStore, PostgresProjectArchiveStore, PostgresVariantCreativePackageStore, PostgresVariantFactoryStore, createPostgresPool } from "@koolezt/infrastructure";
import { CloudflareAccessVerifier } from "./browser-auth.js";
import { DurableReadyPublisher, FakeExternalMediaDeliveryProvider, FfmpegCreativeDnaPreprocessor, FfprobeMediaInspector, HybridDurableMediaStore, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, S3DurableMediaStore, S3ExternalMediaDeliveryProvider, StorageBackedMediaInspector } from "@koolezt/media";
import { ClaudeCreativeProvider, CreatomateCompositionProvider, HttpMetaAdsGateway, OpenAIAudioTranscriber, CreatomateOutputIngestor, ElevenLabsVoiceProvider, FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider, HttpCreatomateTransport, HttpKlingTransport, HttpSeedanceTransport, KlingOutputIngestor, KlingVideoGenerationProvider, OpenAICreativeProvider, OpenAIVoiceProvider, OPENAI_VOICE_DEFAULT_STYLE, RoutedVideoOutputIngestor, SeedanceOutputIngestor, SeedanceVideoGenerationProvider, UnavailableCompositionProvider, UnavailableVideoGenerationProvider } from "@koolezt/providers";
import type { ClaudeEffort } from "@koolezt/providers";

export function createRuntime(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const mediaRoot = resolve(env.WORKING_MEDIA_ROOT ?? "var/media");
  const readyRoot = resolve(env.READY_ROOT ?? "var/ready");
  const pool = createPostgresPool(databaseUrl);
  const strategyTransportTimeoutMs = Number(env.OPENAI_STRATEGY_HTTP_TIMEOUT_MS ?? "30000");
  if (!Number.isFinite(strategyTransportTimeoutMs) || strategyTransportTimeoutMs < 1_000 || strategyTransportTimeoutMs > 120_000) throw new Error("OPENAI_STRATEGY_HTTP_TIMEOUT_MS must be between 1000 and 120000 milliseconds.");
  const conceptTransportTimeoutMs = Number(env.OPENAI_CONCEPT_HTTP_TIMEOUT_MS ?? "30000");
  if (!Number.isFinite(conceptTransportTimeoutMs) || conceptTransportTimeoutMs < 1_000 || conceptTransportTimeoutMs > 120_000) throw new Error("OPENAI_CONCEPT_HTTP_TIMEOUT_MS must be between 1000 and 120000 milliseconds.");
  const repository = new PostgresFactoryRepository(pool);
  const localStorage = new LocalStorageProvider(mediaRoot, undefined, undefined, new PostgresMediaAssetCatalog(pool));
  const durableProvider = (env.DURABLE_MEDIA_PROVIDER ?? "local").toLowerCase();
  if (!["local", "s3"].includes(durableProvider)) throw new Error("DURABLE_MEDIA_PROVIDER must be local or s3.");
  const s3Config = {
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION ?? "",
    bucket: env.S3_BUCKET ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    ttlSeconds: Number(env.DURABLE_MEDIA_URL_TTL_SECONDS ?? "900")
  };
  const s3Storage = durableProvider === "s3"
    ? new S3DurableMediaStore(s3Config, new PostgresDurableMediaAssetCatalog(pool))
    : undefined;
  const durableMediaStore = s3Storage ? new HybridDurableMediaStore(s3Storage, localStorage) : undefined;
  const storage = durableMediaStore ?? localStorage;
  const mediaInspector = durableMediaStore
    ? new StorageBackedMediaInspector(durableMediaStore, env.FFPROBE_PATH ?? "ffprobe")
    : new FfprobeMediaInspector(mediaRoot);
  const readyPublisher = durableMediaStore ? new DurableReadyPublisher(durableMediaStore) : new LocalReadyPublisher(readyRoot, storage);
  const desktopRenderJobs = new PostgresDesktopRenderJobStore(pool);
  const renderWorkerIdentities = new PostgresRenderWorkerIdentityStore(pool);
  const variantFactory = new PostgresVariantFactoryStore(pool);
  const variantPackages = new PostgresVariantCreativePackageStore(pool);
  const projectArchive = new PostgresProjectArchiveStore(pool);
  const strategies = new PostgresCreativeStrategyStore(pool);
  const creativeDna = new PostgresCreativeDnaStore(pool);
  const browserAuthProvider = (env.BROWSER_AUTH_PROVIDER ?? "").toLowerCase();
  if (browserAuthProvider && browserAuthProvider !== "cloudflare") throw new Error("BROWSER_AUTH_PROVIDER must be cloudflare or empty.");
  const browserAuthSettings = { teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? "", audience: env.CLOUDFLARE_ACCESS_AUD ?? "", ownerEmails: (env.CREATIVE_OWNER_EMAILS ?? "").split(",").map((value) => value.trim()).filter(Boolean), editorEmails: (env.CREATIVE_EDITOR_EMAILS ?? "").split(",").map((value) => value.trim()).filter(Boolean) };
  if (browserAuthProvider === "cloudflare" && (!browserAuthSettings.teamDomain || !browserAuthSettings.audience || browserAuthSettings.ownerEmails.length === 0)) throw new Error("Cloudflare browser access requires team domain, application audience, and at least one owner email.");
  if (browserAuthProvider === "cloudflare") { const url = new URL(browserAuthSettings.teamDomain); if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) throw new Error("CLOUDFLARE_ACCESS_TEAM_DOMAIN must be the trusted HTTPS Cloudflare Access team domain."); }
  const browserAuth = browserAuthProvider === "cloudflare" ? new CloudflareAccessVerifier(browserAuthSettings) : undefined;
  const resolveReferenceUrl = durableMediaStore ? { resolveReferenceUrl: async (assetId: string) => (await durableMediaStore.getDownloadReference(assetId)).url } : {};
  const claudeEffort = (name: string, fallback: ClaudeEffort): ClaudeEffort => {
    const value = env[name] ?? fallback;
    if (!["low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error(`${name} must be low, medium, high, xhigh, or max.`);
    return value as ClaudeEffort;
  };
  const creativeProvider = env.CREATIVE_PROVIDER === "claude"
    ? new ClaudeCreativeProvider({
        apiKey: env.ANTHROPIC_API_KEY ?? "",
        model: env.CLAUDE_CREATIVE_MODEL ?? "claude-opus-5-5",
        backgroundEffort: claudeEffort("CLAUDE_BACKGROUND_EFFORT", "medium"),
        interactiveEffort: claudeEffort("CLAUDE_INTERACTIVE_EFFORT", "low"),
        ...resolveReferenceUrl
      })
    : env.CREATIVE_PROVIDER === "openai"
    ? new OpenAICreativeProvider({
        apiKey: env.OPENAI_API_KEY ?? "",
        model: env.OPENAI_CREATIVE_MODEL ?? "",
        strategyTransportTimeoutMs,
        conceptTransportTimeoutMs,
        ...resolveReferenceUrl
      })
    : new FakeCreativeProvider();
  const voiceProvider = env.VOICE_PROVIDER === "elevenlabs"
    ? new ElevenLabsVoiceProvider({ apiKey: env.ELEVENLABS_API_KEY ?? "", modelId: env.ELEVENLABS_MODEL_ID ?? "", outputFormat: env.ELEVENLABS_OUTPUT_FORMAT ?? "", profiles: JSON.parse(env.ELEVENLABS_VOICE_PROFILES_JSON ?? "{}") as Record<string, { providerVoiceId: string; modelId?: string; settings?: Record<string, unknown> }> })
    : env.VOICE_PROVIDER === "openai"
      ? new OpenAIVoiceProvider({ apiKey: env.OPENAI_API_KEY ?? "", model: env.OPENAI_VOICE_MODEL ?? "", voice: env.OPENAI_VOICE_NAME ?? "", outputFormat: env.OPENAI_VOICE_OUTPUT_FORMAT as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm" | undefined, instructions: env.OPENAI_VOICE_INSTRUCTIONS ?? OPENAI_VOICE_DEFAULT_STYLE })
      : new FakeVoiceProvider(resolve(env.FAKE_MP4_FIXTURE ?? "tests/fixtures/vertical-1080x1920.mp4"));
  const useCreatomate = env.COMPOSITION_PROVIDER === "creatomate";
  const defaultVideoProviderKey = (env.DEFAULT_VIDEO_PROVIDER ?? env.VIDEO_PROVIDER ?? "fake").toLowerCase();
  if (!["fake", "kling", "seedance"].includes(defaultVideoProviderKey)) throw new Error("VIDEO_PROVIDER must be fake, kling, or seedance.");
  if (env.COMPOSITION_PROVIDER && env.COMPOSITION_PROVIDER !== "fake" && !useCreatomate) throw new Error("COMPOSITION_PROVIDER must be fake or creatomate.");
  if (env.EXTERNAL_MEDIA_DELIVERY_PROVIDER && !["disabled", "s3"].includes(env.EXTERNAL_MEDIA_DELIVERY_PROVIDER)) throw new Error("EXTERNAL_MEDIA_DELIVERY_PROVIDER must be disabled or s3.");
  const externalMediaDelivery = env.EXTERNAL_MEDIA_DELIVERY_PROVIDER === "s3"
    ? new S3ExternalMediaDeliveryProvider({ endpoint: env.S3_ENDPOINT ?? "", region: env.S3_REGION ?? "", bucket: env.S3_BUCKET ?? "", accessKeyId: env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "", forcePathStyle: env.S3_FORCE_PATH_STYLE === "true", ttlSeconds: Number(env.EXTERNAL_MEDIA_URL_TTL_SECONDS ?? "3600") }, new PostgresExternalMediaStagingStore(pool))
    : new FakeExternalMediaDeliveryProvider();
  const fakeCompositionProvider = new FakeCompositionProvider(resolve(env.FAKE_MP4_FIXTURE ?? "tests/fixtures/vertical-1080x1920.mp4"));
  const creatomateReady = Boolean(env.CREATOMATE_API_KEY) && env.EXTERNAL_MEDIA_DELIVERY_PROVIDER === "s3";
  const creatomateCompositionProvider = creatomateReady
    ? new CreatomateCompositionProvider(new HttpCreatomateTransport(env.CREATOMATE_API_KEY ?? ""))
    : new UnavailableCompositionProvider("creatomate", env.CREATOMATE_API_KEY ? "EXTERNAL_MEDIA_DELIVERY_CONFIGURATION_MISSING" : "CREATOMATE_CONFIGURATION_MISSING", env.CREATOMATE_API_KEY ? "Creatomate requires S3 external-media delivery." : "CREATOMATE_API_KEY is required when Creatomate is selected.");
  const compositionProvider = useCreatomate ? creatomateCompositionProvider : fakeCompositionProvider;
  const desktopCompositionProvider = new DesktopCompositionProvider(desktopRenderJobs, storage);
  const compositionProviders = new CompositionProviderRegistry({ fake: fakeCompositionProvider, "desktop-worker": desktopCompositionProvider, creatomate: creatomateCompositionProvider }, env.COMPOSITION_PROVIDER ?? "fake");
  const fakeVideoProvider = new FakeVideoGenerationProvider(resolve(env.FAKE_MP4_FIXTURE ?? "tests/fixtures/vertical-1080x1920.mp4"));
  const canStageExternalMedia = env.EXTERNAL_MEDIA_DELIVERY_PROVIDER === "s3";
  const klingVideoProvider = env.KLING_API_KEY && canStageExternalMedia
    ? new KlingVideoGenerationProvider(
        new HttpKlingTransport(env.KLING_API_KEY, env.KLING_API_BASE_URL ?? "https://api-singapore.klingai.com"),
        { model: env.KLING_VIDEO_MODEL ?? "kling-3.0-turbo", resolution: env.KLING_VIDEO_RESOLUTION === "1080p" ? "1080p" : "720p", aspectRatio: env.KLING_ASPECT_RATIO === "16:9" || env.KLING_ASPECT_RATIO === "1:1" ? env.KLING_ASPECT_RATIO : "9:16" }
      )
    : new UnavailableVideoGenerationProvider("kling", env.KLING_VIDEO_MODEL ?? "kling-3.0-turbo", env.KLING_API_KEY ? "EXTERNAL_MEDIA_DELIVERY_CONFIGURATION_MISSING" : "KLING_CONFIGURATION_MISSING", env.KLING_API_KEY ? "Kling requires S3 external-media delivery." : "KLING_API_KEY is required when Kling is selected.");
  const seedanceVideoProvider = env.SEEDANCE_API_KEY && canStageExternalMedia
    ? new SeedanceVideoGenerationProvider(
        new HttpSeedanceTransport(env.SEEDANCE_API_KEY, env.SEEDANCE_API_BASE_URL ?? "https://operator.las.ap-southeast-1.bytepluses.com"),
        { model: env.SEEDANCE_VIDEO_MODEL ?? "dreamina-seedance-2-5-260628", aspectRatio: "9:16", ...(env.SEEDANCE_VIDEO_RESOLUTION ? { resolution: env.SEEDANCE_VIDEO_RESOLUTION } : {}) }
      )
    : new UnavailableVideoGenerationProvider("seedance", env.SEEDANCE_VIDEO_MODEL ?? "dreamina-seedance-2-5-260628", env.SEEDANCE_API_KEY ? "EXTERNAL_MEDIA_DELIVERY_CONFIGURATION_MISSING" : "SEEDANCE_CONFIGURATION_MISSING", env.SEEDANCE_API_KEY ? "Seedance requires S3 external-media delivery." : "SEEDANCE_API_KEY is required when Seedance is selected.");
  const videoProviders = new VideoProviderRegistry({ fake: fakeVideoProvider, kling: klingVideoProvider, seedance: seedanceVideoProvider }, defaultVideoProviderKey);
  if (env.CREATIVE_PROVIDER && !["fake", "claude", "openai"].includes(env.CREATIVE_PROVIDER)) throw new Error("CREATIVE_PROVIDER must be fake, claude, or openai.");
  if (env.VOICE_PROVIDER && env.VOICE_PROVIDER !== "fake" && env.VOICE_PROVIDER !== "elevenlabs" && env.VOICE_PROVIDER !== "openai") throw new Error("VOICE_PROVIDER must be fake, elevenlabs, or openai.");
  const service = new CreativeFactoryService({
      repository,
      creativeProvider,
      videoProvider: fakeVideoProvider,
      videoProviders,
      defaultVideoProviderKey,
      videoOutputIngestor: new RoutedVideoOutputIngestor(new InlineCompositionOutputIngestor(), {
        kling: new KlingOutputIngestor(fetch, Number(env.KLING_MAX_OUTPUT_BYTES ?? "157286400"), Number(env.KLING_DOWNLOAD_TIMEOUT_MS ?? "60000"), (env.KLING_OUTPUT_HOST_SUFFIXES ?? "klingai.com").split(",").map((value) => value.trim()).filter(Boolean)),
        seedance: new SeedanceOutputIngestor(fetch, Number(env.SEEDANCE_MAX_OUTPUT_BYTES ?? "157286400"), Number(env.SEEDANCE_DOWNLOAD_TIMEOUT_MS ?? "60000"), (env.SEEDANCE_OUTPUT_HOST_SUFFIXES ?? "volces.com,bytepluses.com").split(",").map((value) => value.trim()).filter(Boolean))
      }),
      voiceProvider,
      compositionProvider,
      compositionProviders,
      defaultCompositionProviderKey: env.COMPOSITION_PROVIDER ?? "fake",
      externalMediaDelivery,
      compositionOutputIngestor: useCreatomate ? new CreatomateOutputIngestor(fetch, Number(env.CREATOMATE_MAX_OUTPUT_BYTES ?? "262144000")) : new InlineCompositionOutputIngestor(),
      compositionOutputIngestors: { fake: new InlineCompositionOutputIngestor(), "desktop-worker": new InlineCompositionOutputIngestor(), creatomate: new CreatomateOutputIngestor(fetch, Number(env.CREATOMATE_MAX_OUTPUT_BYTES ?? "262144000")) },
      storage,
      mediaInspector,
      readyPublisher,
      strategyRepository: strategies,
      creativeDnaRepository: creativeDna
    });
  const strategyService = new CreativeStrategyService({ repository, strategies, creativeProvider, creativeDna });
  const dnaTranscriptionProvider = (env.DNA_TRANSCRIPTION_PROVIDER ?? "disabled").toLowerCase();
  if (!["disabled", "openai"].includes(dnaTranscriptionProvider)) throw new Error("DNA_TRANSCRIPTION_PROVIDER must be disabled or openai.");
  const dnaTranscriber = dnaTranscriptionProvider === "openai" ? new OpenAIAudioTranscriber({ apiKey: env.OPENAI_API_KEY ?? "", model: env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1" }) : undefined;
  const creativeDnaMaxFrames = Number(env.CREATIVE_DNA_MAX_FRAMES ?? "30");
  if (!Number.isInteger(creativeDnaMaxFrames) || creativeDnaMaxFrames < 12 || creativeDnaMaxFrames > 60) throw new Error("CREATIVE_DNA_MAX_FRAMES must be an integer between 12 and 60.");
  const creativeDnaService = new CreativeDnaService({ repository, dna:creativeDna, provider:creativeProvider, storage, preprocessor:new FfmpegCreativeDnaPreprocessor(storage,env.FFMPEG_PATH??"ffmpeg",env.FFPROBE_PATH??"ffprobe",{maxFrames:creativeDnaMaxFrames,...(dnaTranscriber?{transcriber:dnaTranscriber}:{})}) });
  // Meta Ads is read-only and enabled only when its own token and ad accounts are configured.
  const metaVideoMaxBytes = Number(env.META_VIDEO_MAX_BYTES ?? 500 * 1024 * 1024);
  const downloadMetaVideo = async (url: string) => {
    const signal = AbortSignal.timeout(Number(env.META_VIDEO_DOWNLOAD_TIMEOUT_MS ?? "80000"));
    let current = url;
    let response = await fetch(current, { redirect: "manual", signal });
    // Follow a few CDN redirects, re-checking every hop so a redirect can never leave Meta's CDN.
    for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 3; hops++) {
      const next = response.headers.get("location");
      if (!next || !isMetaVideoUrl(new URL(next, current).toString())) throw new DomainError("META_VIDEO_URL_UNTRUSTED", "Meta redirected the video download to an unexpected location.");
      current = new URL(next, current).toString();
      response = await fetch(current, { redirect: "manual", signal });
    }
    if (!response.ok) throw new DomainError("META_VIDEO_DOWNLOAD_FAILED", `Meta video download failed with HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length") ?? 0) > metaVideoMaxBytes) throw new DomainError("META_VIDEO_TOO_LARGE", "The Meta video is larger than the configured limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > metaVideoMaxBytes) throw new DomainError("META_VIDEO_TOO_LARGE", "The Meta video is larger than the configured limit.");
    return bytes;
  };
  const metaWinners = env.META_ADS_ACCESS_TOKEN && env.META_AD_ACCOUNT_IDS
    ? new MetaWinnerService({ gateway: new HttpMetaAdsGateway({ accessToken: env.META_ADS_ACCESS_TOKEN, accountIds: env.META_AD_ACCOUNT_IDS.split(","), apiVersion: env.META_GRAPH_API_VERSION ?? "v24.0" }), dna: creativeDnaService, repository: creativeDna, storage, downloadVideo: downloadMetaVideo })
    : undefined;
  return {
    metaWinners,
    pool,
    repository,
    creativeProvider,
    service,
    strategyService,
    creativeDnaService,
    creativeDna,
    strategies,
    storage,
    desktopRenderJobs,
    renderWorkerIdentities,
    variantFactory,
    variantPackages,
    projectArchive,
    voiceProvider,
    browserAuth,
    renderWorkerToken: env.RENDER_WORKER_TOKEN ?? "",
    renderWorkerLeaseMs: Number(env.RENDER_WORKER_LEASE_MS ?? "300000"),
    renderWorkerMaxOutputBytes: Number(env.RENDER_WORKER_MAX_OUTPUT_BYTES ?? "524288000"),
    mediaInspector,
    durableMediaStore,
    runMediaCleanup: durableMediaStore
      ? () => durableMediaStore.runDueCleanup({
          rejectedGraceDays: Number(env.MEDIA_REJECTED_RETENTION_DAYS ?? "7"),
          readyGraceDays: Number(env.MEDIA_READY_GRACE_DAYS ?? "7"),
          abandonedHours: Number(env.MEDIA_ABANDONED_UPLOAD_HOURS ?? "24")
        })
      : undefined
  };
}
