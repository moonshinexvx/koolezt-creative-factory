import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CreativeDnaService, CreativeFactoryService, isMetaVideoUrl, MetaWinnerService, performanceFromMeta } from "@koolezt/application";
import { calendarDay, InMemoryCreativeDnaStore, InMemoryCreativeStrategyStore, InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider, HttpMetaAdsGateway, metaAdMetrics, normalizeAdAccountId } from "@koolezt/providers";
import type { CreativeDnaPreprocessor, MetaAdsGateway, MetaAdSummary } from "@koolezt/domain";

const row = {
  ad_id: "120200000000000001", ad_name: "Dog sign UGC v3", campaign_name: "Dog signs", account_currency: "USD", date_start: "2026-09-01", date_stop: "2026-10-26",
  spend: "120.00", impressions: "10000", inline_link_clicks: "180",
  actions: [{ action_type: "purchase", value: "3" }, { action_type: "omni_purchase", value: "4" }, { action_type: "video_view", value: "3500" }],
  action_values: [{ action_type: "omni_purchase", value: "480.00" }],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "1400" }],
  video_p25_watched_actions: [{ action_type: "video_view", value: "2800" }], video_p100_watched_actions: [{ action_type: "video_view", value: "900" }]
};

describe("Meta ad metrics", () => {
  it("normalizes purchases like Koolezt OS and derives hook, hold, CTR, CPA, and ROAS", () => {
    expect(metaAdMetrics(row)).toEqual({ spend: 120, impressions: 10_000, linkClicks: 180, purchases: 4, purchaseValue: 480, threeSecondViews: 3500, thruPlays: 1400, videoP25: 2800, videoP100: 900, linkCtr: 0.018, cpc: 0.67, cpm: 12, cpa: 30, roas: 4, hookRate: 0.35, holdRate: 0.4 });
    expect(metaAdMetrics({ spend: "0", impressions: "0" })).toEqual({ spend: 0, impressions: 0, linkClicks: 0, purchases: 0, purchaseValue: 0 });
  });

  it("maps lifetime results onto the analysis performance context", () => {
    const summary: MetaAdSummary = { accountId: "act_123456", adId: row.ad_id, adName: row.ad_name, currency: "USD", dateStart: "2026-09-01", dateEnd: "2026-10-26", metrics: metaAdMetrics(row) };
    expect(performanceFromMeta(summary)).toMatchObject({ spend: 120, purchases: 4, revenue: 480, purchaseCpa: 30, roas: 4, linkCtr: 1.8, hookRate: 0.35, holdRate: 0.4, videoCompletion: { p25: 2800, p100: 900 }, currency: "USD", metricSource: "Meta Ads API (lifetime)" });
  });

  it("accepts only Meta CDN video locations and well-formed account IDs", () => {
    expect(isMetaVideoUrl("https://video.xx.fbcdn.net/v/t42/abc.mp4?oh=1")).toBe(true);
    expect(isMetaVideoUrl("http://video.xx.fbcdn.net/abc.mp4")).toBe(false);
    expect(isMetaVideoUrl("https://fbcdn.net.attacker.example/abc.mp4")).toBe(false);
    expect(isMetaVideoUrl("https://169.254.169.254/latest")).toBe(false);
    expect(normalizeAdAccountId("1234567890")).toBe("act_1234567890");
    expect(() => normalizeAdAccountId("act_12ab")).toThrow();
  });
});

describe("Postgres DATE values", () => {
  it("round-trip as the stored calendar day in any server time zone", () => {
    // pg parses DATE columns as local midnight; String() or toISOString() would corrupt them.
    expect(calendarDay(new Date(2026, 8, 30))).toBe("2026-09-30");
    expect(calendarDay(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(calendarDay("2026-10-27")).toBe("2026-10-27");
  });
});

describe("Meta Ads gateway", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads ad-level insights with the token in a header, never in the URL", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => { calls.push({ url: String(url), headers: init?.headers as Record<string, string> }); return json({ data: [row] }); });
    const gateway = new HttpMetaAdsGateway({ accessToken: "secret-token", accountIds: ["act_123456", "123456"], fetch: fetchMock as never });
    expect(gateway.accountIds).toEqual(["act_123456"]);
    const [ad] = await gateway.topAds("act_123456", "2026-09-01", "2026-10-26");
    expect(ad).toMatchObject({ adId: row.ad_id, campaignName: "Dog signs", metrics: { roas: 4 } });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v24.0/act_123456/insights");
    expect(url.searchParams.get("level")).toBe("ad");
    expect(url.searchParams.get("sort")).toBe("spend_descending");
    expect(JSON.parse(url.searchParams.get("time_range")!)).toEqual({ since: "2026-09-01", until: "2026-10-26" });
    expect(calls[0]!.url).not.toContain("secret-token");
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token");
    await expect(gateway.topAds("act_999999", "2026-09-01", "2026-10-26")).rejects.toMatchObject({ code: "META_AD_ACCOUNT_NOT_CONFIGURED" });
  });

  it("finds the video on story-based creatives and treats an unreadable source as a manual upload", async () => {
    const responses: Record<string, Response> = {
      "/v24.0/555": json({ name: "Story ad", creative: { id: "777", object_story_spec: { video_data: { video_id: "888", image_url: "https://scontent.xx.fbcdn.net/t.jpg" } } } }),
      "/v24.0/888": json({ error: { code: 10, message: "Requires pages_read_engagement" } }, 400)
    };
    const fetchMock = vi.fn(async (url: URL | string) => responses[new URL(String(url)).pathname]!);
    const gateway = new HttpMetaAdsGateway({ accessToken: "t", accountIds: ["act_123456"], fetch: fetchMock as never });
    expect(await gateway.adCreative("555")).toEqual({ adId: "555", adName: "Story ad", creativeId: "777", videoId: "888", thumbnailUrl: "https://scontent.xx.fbcdn.net/t.jpg" });
    expect(await gateway.videoSourceUrl("888")).toBeUndefined();
  });

  it("reads a Page-owned video's file through that Page's token when the system token gets no source", async () => {
    const seen: { path: string; auth: string }[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const target = new URL(String(url)); const auth = (init?.headers as Record<string, string>).authorization ?? "";
      seen.push({ path: target.pathname, auth });
      if (target.pathname === "/v24.0/888" && auth === "Bearer system") return json({ id: "888", from: { id: "103353908555458" } });
      if (target.pathname === "/v24.0/103353908555458") return json({ id: "103353908555458", access_token: "page-token" });
      return json({ source: "https://scontent-sin11-1.xx.fbcdn.net/v/video.mp4" });
    });
    const gateway = new HttpMetaAdsGateway({ accessToken: "system", accountIds: ["act_123456"], fetch: fetchMock as never });
    expect(await gateway.videoSourceUrl("888")).toBe("https://scontent-sin11-1.xx.fbcdn.net/v/video.mp4");
    expect(seen.map((call) => call.auth)).toEqual(["Bearer system", "Bearer system", "Bearer page-token"]);
    expect(seen.every((call) => !call.path.includes("token"))).toBe(true);
  });

  it("maps an expired token to a clear error", async () => {
    const gateway = new HttpMetaAdsGateway({ accessToken: "t", accountIds: ["act_123456"], fetch: (async () => json({ error: { code: 190, message: "Session expired" } }, 400)) as never });
    await expect(gateway.listAccounts()).rejects.toMatchObject({ code: "META_TOKEN_INVALID" });
  });
});

const mp4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
const preprocessor: CreativeDnaPreprocessor = { async preprocess() { return { mediaMetadata: { durationMs: 15_000, width: 720, height: 1280, hasAudio: true, mimeType: "video/mp4" }, frames: [{ timestampMs: 0, mimeType: "image/jpeg", bytesBase64: "a", sha256: "f" }] }; } };

async function harness(gatewayOverrides: Partial<MetaAdsGateway> = {}) {
  const root = await mkdtemp(join(tmpdir(), "meta-winners-"));
  const repository = new InMemoryFactoryRepository();
  const dna = new InMemoryCreativeDnaStore();
  const storage = new LocalStorageProvider(join(root, "media"));
  const provider = new FakeCreativeProvider();
  const factory = new CreativeFactoryService({ repository, strategyRepository: new InMemoryCreativeStrategyStore(repository), creativeDnaRepository: dna, creativeProvider: provider, videoProvider: new FakeVideoGenerationProvider(), voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
  const project = await factory.createProjectFromBrief({ requestId: crypto.randomUUID(), name: "Dog address sign", creativeTopic: "Winners", productDetails: "A personalized address sign.", verifiedClaims: ["Displays your address"], targetDurationSeconds: 15, actor: "owner" });
  const dnaService = new CreativeDnaService({ repository, dna, provider, storage, preprocessor });
  const results: MetaAdSummary = { accountId: "act_123456", adId: "555", adName: "Dog sign UGC v3", currency: "USD", dateStart: "2026-09-01", dateEnd: "2026-10-26", metrics: metaAdMetrics(row) };
  const gateway: MetaAdsGateway = {
    accountIds: ["act_123456"], listAccounts: async () => [{ id: "act_123456", name: "Koolezt", currency: "USD" }], topAds: async () => [results],
    adCreative: async (adId) => ({ adId, adName: "Dog sign UGC v3", creativeId: "777", videoId: "888" }),
    videoSourceUrl: async () => "https://video.xx.fbcdn.net/v/abc.mp4", lifetimeResults: vi.fn(async () => results), ...gatewayOverrides
  };
  const downloadVideo = vi.fn(async () => mp4);
  const service = new MetaWinnerService({ gateway, dna: dnaService, repository: dna, storage, downloadVideo });
  return { root, project, dna, dnaService, service, gateway, downloadVideo, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe("Meta winner import", () => {
  it("imports an ad's video with its lifetime results, links it, and starts analysis", async () => {
    const setup = await harness();
    try {
      const result = await setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" });
      expect(result.status).toBe("IMPORTED");
      const referenceId = (result as { referenceId: string }).referenceId;
      const reference = await setup.dna.getReference(referenceId);
      expect(reference).toMatchObject({ displayName: "Dog sign UGC v3", sourceProjectId: setup.project.id, platform: "Meta / Facebook", analysisStatus: "ANALYZING", performance: { roas: 4, hookRate: 0.35 } });
      expect(await setup.dna.listMetaLinks()).toEqual([expect.objectContaining({ creativeReferenceId: referenceId, adId: "555", videoId: "888", metrics: expect.objectContaining({ purchases: 4 }) })]);
      expect(setup.downloadVideo).toHaveBeenCalledWith("https://video.xx.fbcdn.net/v/abc.mp4");
      expect((await setup.service.topAds("act_123456", "2026-09-01", "2026-10-26"))[0]).toMatchObject({ importedReferenceId: referenceId });
      await expect(setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" })).rejects.toMatchObject({ code: "META_AD_ALREADY_IMPORTED" });
    } finally { await setup.dispose(); }
  });

  it("asks for a manual upload when the token cannot read the video, without creating anything", async () => {
    const setup = await harness({ videoSourceUrl: async () => undefined });
    try {
      expect(await setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" })).toEqual({ status: "VIDEO_REQUIRED", ad: { accountId: "act_123456", adId: "555", adName: "Dog sign UGC v3" } });
      expect(await setup.dnaService.list()).toHaveLength(0);
      expect(setup.downloadVideo).not.toHaveBeenCalled();
    } finally { await setup.dispose(); }
  });

  it("refuses an untrusted video location and a non-MP4 download", async () => {
    const untrusted = await harness({ videoSourceUrl: async () => "https://example.com/video.mp4" });
    try { await expect(untrusted.service.importAd({ accountId: "act_123456", adId: "555", productId: untrusted.project.productId, actor: "owner" })).rejects.toMatchObject({ code: "META_VIDEO_URL_UNTRUSTED" }); } finally { await untrusted.dispose(); }
    const setup = await harness();
    try {
      setup.downloadVideo.mockResolvedValueOnce(new Uint8Array(Buffer.from("<html>not a video</html>")));
      await expect(setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" })).rejects.toMatchObject({ code: "META_VIDEO_INVALID" });
      expect(await setup.dnaService.list()).toHaveLength(0);
    } finally { await setup.dispose(); }
  });

  it("deletes a winner reversibly: hidden everywhere, Meta link cleared so the ad can be imported again", async () => {
    const setup = await harness();
    try {
      const { referenceId } = await setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" }) as { referenceId: string };
      await expect(setup.dnaService.archive(referenceId, "owner")).rejects.toMatchObject({ code: "WINNER_ARCHIVE_IN_PROGRESS" });
      await setup.dna.updateReference({ ...(await setup.dna.getReference(referenceId)), analysisStatus: "DRAFT" });
      await setup.dna.saveWinnerReport({ creativeReferenceId: referenceId, status: "FAILED", providerMetadata: {}, createdAt: "t", updatedAt: "t" });
      await setup.dnaService.archive(referenceId, "owner");
      expect(await setup.dnaService.list()).toHaveLength(0);
      expect(await setup.dnaService.listApproved(setup.project.productId)).toHaveLength(0);
      expect(await setup.dna.listMetaLinks()).toHaveLength(0);
      expect((await setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" })).status).toBe("IMPORTED");
      await expect(setup.dnaService.archive(referenceId, "owner")).rejects.toMatchObject({ code: "CREATIVE_REFERENCE_NOT_FOUND" });
    } finally { await setup.dispose(); }
  });

  it("refreshes lifetime results onto the winner and records a failed refresh without losing the last numbers", async () => {
    const setup = await harness();
    try {
      const { referenceId } = await setup.service.importAd({ accountId: "act_123456", adId: "555", productId: setup.project.productId, actor: "owner" }) as { referenceId: string };
      const later: MetaAdSummary = { accountId: "act_123456", adId: "555", adName: "Dog sign UGC v3", dateStart: "2026-09-01", dateEnd: "2026-10-27", metrics: { ...metaAdMetrics(row), spend: 200, roas: 3.5 } };
      vi.mocked(setup.gateway.lifetimeResults).mockResolvedValueOnce(later);
      expect(await setup.service.refreshAll()).toEqual({ refreshed: 1, failed: 0 });
      expect((await setup.dna.getReference(referenceId)).performance).toMatchObject({ spend: 200, roas: 3.5, dateEnd: "2026-10-27" });
      vi.mocked(setup.gateway.lifetimeResults).mockRejectedValueOnce(new Error("Meta could not be reached"));
      expect(await setup.service.refreshAll()).toEqual({ refreshed: 0, failed: 1 });
      expect((await setup.dna.listMetaLinks())[0]).toMatchObject({ syncError: "Meta could not be reached", metrics: expect.objectContaining({ spend: 200 }) });
    } finally { await setup.dispose(); }
  });
});
