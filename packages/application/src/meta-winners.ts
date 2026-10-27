import { randomUUID } from "node:crypto";
import { DomainError } from "@koolezt/domain";
import type { CreativeDnaRepository, CreativeMetaLink, CreativePerformanceContext, MetaAdsGateway, MetaAdSummary, StorageProvider } from "@koolezt/domain";
import type { CreativeDnaService } from "./creative-dna.js";

/** Lifetime Meta results expressed as the operator-performance context the analysis reads. */
export function performanceFromMeta(result: MetaAdSummary): CreativePerformanceContext {
  const m = result.metrics;
  const values: Record<string, unknown> = {
    spend: m.spend, purchases: m.purchases, revenue: m.purchaseValue, purchaseCpa: m.cpa, roas: m.roas,
    linkCtr: m.linkCtr !== undefined ? Math.round(m.linkCtr * 10_000) / 100 : undefined, cpc: m.cpc, cpm: m.cpm,
    impressions: m.impressions, linkClicks: m.linkClicks, threeSecondViews: m.threeSecondViews, thruPlays: m.thruPlays, hookRate: m.hookRate, holdRate: m.holdRate,
    videoCompletion: m.impressions && m.videoP25 !== undefined ? { p25: m.videoP25, ...(m.videoP50 !== undefined ? { p50: m.videoP50 } : {}), ...(m.videoP75 !== undefined ? { p75: m.videoP75 } : {}), ...(m.videoP100 !== undefined ? { p100: m.videoP100 } : {}) } : undefined,
    currency: result.currency, dateStart: result.dateStart || undefined, dateEnd: result.dateEnd || undefined, metricSource: "Meta Ads API (lifetime)"
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as CreativePerformanceContext;
}

/** Only Meta's own CDN may be downloaded, so an unexpected URL can never reach internal hosts. */
export function isMetaVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (/(^|\.)fbcdn\.net$/.test(url.hostname) || /(^|\.)facebook\.com$/.test(url.hostname));
  } catch {
    return false;
  }
}

export type MetaImportResult =
  | Readonly<{ status: "IMPORTED"; referenceId: string }>
  | Readonly<{ status: "VIDEO_REQUIRED"; ad: Readonly<{ accountId: string; adId: string; adName: string; thumbnailUrl?: string }> }>;

export class MetaWinnerService {
  constructor(private readonly d: Readonly<{
    gateway: MetaAdsGateway; dna: CreativeDnaService; repository: CreativeDnaRepository; storage: StorageProvider;
    downloadVideo: (url: string) => Promise<Uint8Array>; now?: () => Date;
  }>) {}

  private now() { return (this.d.now ?? (() => new Date()))().toISOString(); }

  async status() {
    return { accountIds: this.d.gateway.accountIds, accounts: await this.d.gateway.listAccounts() };
  }

  async topAds(accountId: string, since: string, until: string) {
    const [ads, links] = await Promise.all([this.d.gateway.topAds(accountId, since, until), this.d.repository.listMetaLinks()]);
    const imported = new Map(links.map((link) => [link.adId, link.creativeReferenceId]));
    return ads.map((ad) => ({ ...ad, ...(imported.has(ad.adId) ? { importedReferenceId: imported.get(ad.adId) } : {}) }));
  }

  private async assertNotImported(adId: string) {
    const existing = (await this.d.repository.listMetaLinks()).find((link) => link.adId === adId);
    if (existing) throw new DomainError("META_AD_ALREADY_IMPORTED", "This Meta ad is already in Winner Analysis.");
  }

  /** Downloads the ad video into private storage, files it under the Product's campaign, and starts analysis. */
  async importAd(input: Readonly<{ accountId: string; adId: string; productId: string; displayName?: string; actor: string }>): Promise<MetaImportResult> {
    await this.assertNotImported(input.adId);
    const creative = await this.d.gateway.adCreative(input.adId);
    if (!creative.videoId) throw new DomainError("META_AD_NOT_VIDEO", "This ad has no video creative to analyze.");
    const sourceUrl = await this.d.gateway.videoSourceUrl(creative.videoId);
    const ad = { accountId: input.accountId, adId: input.adId, adName: creative.adName, ...(creative.thumbnailUrl ? { thumbnailUrl: creative.thumbnailUrl } : {}) };
    if (!sourceUrl) return { status: "VIDEO_REQUIRED", ad };
    if (!isMetaVideoUrl(sourceUrl)) throw new DomainError("META_VIDEO_URL_UNTRUSTED", "Meta returned an unexpected video location; upload the video manually.");
    const campaign = await this.d.dna.campaignProjectForProduct(input.productId);
    const results = await this.d.gateway.lifetimeResults(input.accountId, input.adId);
    const bytes = await this.d.downloadVideo(sourceUrl);
    if (bytes.byteLength < 12 || Buffer.from(bytes.subarray(4, 8)).toString("latin1") !== "ftyp") throw new DomainError("META_VIDEO_INVALID", "The downloaded Meta video is not an MP4 file.");
    const asset = await this.d.storage.put(`projects/${campaign.id}/creative-references/${randomUUID()}.mp4`, { bytes, mimeType: "video/mp4", extension: "mp4", metadata: { projectId: campaign.id, purpose: "CREATIVE_REFERENCE", originalFilename: `${creative.adName.slice(0, 200)}.mp4`, uploadedBy: input.actor, source: "meta-ads", metaAdId: input.adId } });
    const reference = await this.d.dna.register({ projectId: campaign.id, productId: input.productId, assetId: asset.id, displayName: (input.displayName?.trim() || creative.adName).slice(0, 160), operatorStatus: "WINNER", platform: "Meta / Facebook", actor: input.actor, ...(results?.dateStart ? { dateStart: results.dateStart } : {}), ...(results?.dateEnd ? { dateEnd: results.dateEnd } : {}), ...(results ? { performance: performanceFromMeta(results) } : {}) });
    await this.saveLink(reference.id, input.accountId, creative, results);
    await this.d.dna.requestAnalysis(reference.id, randomUUID());
    return { status: "IMPORTED", referenceId: reference.id };
  }

  /** Links a manually uploaded video to its Meta ad and copies the ad's lifetime results onto the winner. */
  async linkUploaded(referenceId: string, accountId: string, adId: string) {
    await this.assertNotImported(adId);
    const [creative, results] = await Promise.all([this.d.gateway.adCreative(adId), this.d.gateway.lifetimeResults(accountId, adId)]);
    await this.applyResults(referenceId, results);
    await this.saveLink(referenceId, accountId, creative, results);
  }

  async refresh(referenceId: string) {
    const link = (await this.d.repository.listMetaLinks()).find((item) => item.creativeReferenceId === referenceId);
    if (!link) throw new DomainError("META_LINK_NOT_FOUND", "This winner was not imported from Meta.");
    try {
      const results = await this.d.gateway.lifetimeResults(link.accountId, link.adId);
      await this.applyResults(referenceId, results);
      const now = this.now();
      const { syncError: _e, ...rest } = link;
      void _e;
      await this.d.repository.saveMetaLink({ ...rest, ...(results ? { metrics: results.metrics, ...(results.currency ? { currency: results.currency } : {}), ...(results.dateStart ? { dateStart: results.dateStart } : {}), ...(results.dateEnd ? { dateEnd: results.dateEnd } : {}) } : {}), syncedAt: now, updatedAt: now });
    } catch (error) {
      await this.d.repository.saveMetaLink({ ...link, syncError: (error instanceof Error ? error.message : "Refresh failed.").slice(0, 500), updatedAt: this.now() });
      throw error;
    }
  }

  /** Daily refresh: each winner is refreshed independently so one failure never blocks the rest. */
  async refreshAll(): Promise<Readonly<{ refreshed: number; failed: number }>> {
    let refreshed = 0;
    let failed = 0;
    for (const link of await this.d.repository.listMetaLinks()) {
      try { await this.refresh(link.creativeReferenceId); refreshed++; } catch { failed++; }
    }
    return { refreshed, failed };
  }

  private async applyResults(referenceId: string, results: MetaAdSummary | undefined) {
    if (!results) return;
    const reference = await this.d.repository.getReference(referenceId);
    await this.d.repository.updateReference({ ...reference, performance: performanceFromMeta(results), ...(results.dateStart ? { dateStart: results.dateStart } : {}), ...(results.dateEnd ? { dateEnd: results.dateEnd } : {}), updatedAt: this.now() });
  }

  private async saveLink(referenceId: string, accountId: string, creative: Readonly<{ adId: string; adName: string; creativeId?: string; videoId?: string; thumbnailUrl?: string }>, results: MetaAdSummary | undefined) {
    const now = this.now();
    const link: CreativeMetaLink = {
      creativeReferenceId: referenceId, accountId, adId: creative.adId, adName: creative.adName,
      ...(creative.creativeId ? { creativeId: creative.creativeId } : {}), ...(creative.videoId ? { videoId: creative.videoId } : {}), ...(creative.thumbnailUrl ? { thumbnailUrl: creative.thumbnailUrl } : {}),
      ...(results ? { metrics: results.metrics, ...(results.currency ? { currency: results.currency } : {}), ...(results.dateStart ? { dateStart: results.dateStart } : {}), ...(results.dateEnd ? { dateEnd: results.dateEnd } : {}), syncedAt: now } : {}),
      createdAt: now, updatedAt: now
    };
    await this.d.repository.saveMetaLink(link);
  }
}
