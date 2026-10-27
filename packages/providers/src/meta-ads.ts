import { DomainError } from "@koolezt/domain";
import type { MetaAdAccount, MetaAdCreative, MetaAdMetrics, MetaAdsGateway, MetaAdSummary } from "@koolezt/domain";

type Raw = Record<string, unknown>;
type ActionList = readonly Readonly<{ action_type?: string; value?: string | number }>[] | undefined;

// Same precedence Koolezt OS Finance uses, so purchase counts match across both apps.
const PURCHASE_ACTION_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const INSIGHT_FIELDS = ["ad_id", "ad_name", "campaign_name", "adset_name", "account_currency", "spend", "impressions", "inline_link_clicks", "actions", "action_values", "video_thruplay_watched_actions", "video_p25_watched_actions", "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions"].join(",");
const TOP_ADS_LIMIT = 50;

const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
function actionValue(list: ActionList, types: readonly string[]): number | undefined {
  for (const type of types) {
    const match = list?.find((item) => item.action_type === type);
    if (match) return num(match.value);
  }
  return undefined;
}
const firstValue = (list: ActionList) => (list?.length ? num(list[0]!.value) : undefined);
const ratio = (top: number | undefined, bottom: number | undefined, digits = 4) => (top !== undefined && bottom ? round(top / bottom, digits) : undefined);

/** Converts one ad-level insights row into normalized metrics; derived rates are computed, never taken from Meta. */
export function metaAdMetrics(row: Raw): MetaAdMetrics {
  const spend = num(row.spend);
  const impressions = num(row.impressions);
  const linkClicks = num(row.inline_link_clicks);
  const purchases = actionValue(row.actions as ActionList, PURCHASE_ACTION_TYPES) ?? 0;
  const purchaseValue = actionValue(row.action_values as ActionList, PURCHASE_ACTION_TYPES) ?? 0;
  const threeSecondViews = actionValue(row.actions as ActionList, ["video_view"]);
  const thruPlays = firstValue(row.video_thruplay_watched_actions as ActionList);
  const values: Record<string, number | undefined> = {
    spend: round(spend, 2), impressions, linkClicks, purchases, purchaseValue: round(purchaseValue, 2),
    threeSecondViews, thruPlays,
    videoP25: firstValue(row.video_p25_watched_actions as ActionList), videoP50: firstValue(row.video_p50_watched_actions as ActionList),
    videoP75: firstValue(row.video_p75_watched_actions as ActionList), videoP100: firstValue(row.video_p100_watched_actions as ActionList),
    linkCtr: ratio(linkClicks, impressions), cpc: ratio(spend, linkClicks, 2), cpm: impressions ? round((spend / impressions) * 1000, 2) : undefined,
    cpa: ratio(spend, purchases, 2), roas: ratio(purchaseValue, spend, 2),
    hookRate: ratio(threeSecondViews, impressions), holdRate: ratio(thruPlays, threeSecondViews)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as MetaAdMetrics;
}

export function normalizeAdAccountId(value: string): string {
  const digits = value.trim().replace(/^act_/, "");
  if (!/^[0-9]{5,25}$/.test(digits)) throw new DomainError("META_AD_ACCOUNT_INVALID", "Meta ad account IDs look like act_1234567890.");
  return `act_${digits}`;
}

function summary(accountId: string, row: Raw): MetaAdSummary {
  return {
    accountId, adId: String(row.ad_id ?? ""), adName: String(row.ad_name ?? "Untitled ad").slice(0, 400),
    ...(row.campaign_name ? { campaignName: String(row.campaign_name) } : {}), ...(row.adset_name ? { adsetName: String(row.adset_name) } : {}),
    ...(row.account_currency ? { currency: String(row.account_currency) } : {}),
    dateStart: String(row.date_start ?? ""), dateEnd: String(row.date_stop ?? ""), metrics: metaAdMetrics(row)
  };
}

export class HttpMetaAdsGateway implements MetaAdsGateway {
  readonly accountIds: readonly string[];
  private readonly base: string;
  constructor(private readonly config: Readonly<{ accessToken: string; accountIds: readonly string[]; apiVersion?: string; timeoutMs?: number; fetch?: typeof fetch }>) {
    if (!config.accessToken) throw new DomainError("META_CONFIGURATION_MISSING", "META_ADS_ACCESS_TOKEN is required for the Meta Ads integration.");
    this.accountIds = [...new Set(config.accountIds.filter((id) => id.trim()).map(normalizeAdAccountId))];
    if (!this.accountIds.length) throw new DomainError("META_CONFIGURATION_MISSING", "META_AD_ACCOUNT_IDS must list at least one ad account.");
    this.base = `https://graph.facebook.com/${config.apiVersion ?? "v24.0"}`;
  }

  private async get(path: string, params: Readonly<Record<string, string>> = {}, token = this.config.accessToken): Promise<Raw> {
    const url = new URL(`${this.base}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      // The token travels in a header so it never appears in URLs or proxy logs.
      response = await (this.config.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000) });
    } catch {
      throw new DomainError("META_UNAVAILABLE", "Meta could not be reached; try again shortly.");
    }
    const body = await response.json().catch(() => ({})) as Raw;
    if (response.ok) return body;
    const error = (body.error ?? {}) as Raw;
    const code = Number(error.code);
    if (code === 190 || code === 102) throw new DomainError("META_TOKEN_INVALID", "The Meta access token is invalid or expired. Generate a new system-user token.");
    if (code === 10 || code === 200 || code === 294 || (code >= 200 && code < 300)) throw new DomainError("META_PERMISSION_DENIED", "The Meta token is missing a permission for this request.");
    if ([4, 17, 32, 613, 80000, 80004].includes(code)) throw new DomainError("META_RATE_LIMITED", "Meta rate limit reached; try again later.");
    throw new DomainError("META_REQUEST_FAILED", `Meta rejected the request: ${String(error.message ?? response.status).slice(0, 200)}`);
  }

  private assertAccount(accountId: string): string {
    const id = normalizeAdAccountId(accountId);
    if (!this.accountIds.includes(id)) throw new DomainError("META_AD_ACCOUNT_NOT_CONFIGURED", "This ad account is not configured for Creative Factory.");
    return id;
  }

  async listAccounts(): Promise<readonly MetaAdAccount[]> {
    return Promise.all(this.accountIds.map(async (id) => {
      const account = await this.get(id, { fields: "name,currency" });
      return { id, name: String(account.name ?? id), ...(account.currency ? { currency: String(account.currency) } : {}) };
    }));
  }

  async topAds(accountId: string, since: string, until: string): Promise<readonly MetaAdSummary[]> {
    const id = this.assertAccount(accountId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) throw new DomainError("META_DATE_RANGE_INVALID", "Choose a valid date range.");
    const page = await this.get(`${id}/insights`, { level: "ad", fields: INSIGHT_FIELDS, time_range: JSON.stringify({ since, until }), sort: "spend_descending", limit: String(TOP_ADS_LIMIT) });
    return ((page.data ?? []) as Raw[]).map((row) => summary(id, row)).filter((item) => item.adId);
  }

  async adCreative(adId: string): Promise<MetaAdCreative> {
    if (!/^[0-9]+$/.test(adId)) throw new DomainError("META_AD_INVALID", "Meta ad IDs are numeric.");
    const ad = await this.get(adId, { fields: "name,creative{id,video_id,thumbnail_url,object_story_spec,asset_feed_spec}" });
    const creative = (ad.creative ?? {}) as Raw;
    const story = (creative.object_story_spec ?? {}) as Raw;
    const feedVideos = (((creative.asset_feed_spec ?? {}) as Raw).videos ?? []) as Raw[];
    // Dynamic and story-based ads keep the video in different places on the creative.
    const videoId = creative.video_id ?? ((story.video_data ?? {}) as Raw).video_id ?? feedVideos[0]?.video_id;
    const thumbnail = creative.thumbnail_url ?? ((story.video_data ?? {}) as Raw).image_url;
    return { adId, adName: String(ad.name ?? "Untitled ad").slice(0, 400), ...(creative.id ? { creativeId: String(creative.id) } : {}), ...(videoId ? { videoId: String(videoId) } : {}), ...(thumbnail ? { thumbnailUrl: String(thumbnail) } : {}) };
  }

  /**
   * Meta only returns a Page video's file URL to a Page access token. When the system-user token gets
   * no source, the owning Page's token is fetched and used for that one read; it is never stored or logged.
   */
  async videoSourceUrl(videoId: string): Promise<string | undefined> {
    if (!/^[0-9]+$/.test(videoId)) throw new DomainError("META_VIDEO_INVALID", "Meta video IDs are numeric.");
    const source = (video: Raw) => (typeof video.source === "string" && video.source.startsWith("https://") ? video.source : undefined);
    try {
      const video = await this.get(videoId, { fields: "source,from{id}" });
      const direct = source(video);
      const pageId = ((video.from ?? {}) as Raw).id;
      if (direct || !pageId || !/^[0-9]+$/.test(String(pageId))) return direct;
      const pageToken = (await this.get(String(pageId), { fields: "access_token" })).access_token;
      return typeof pageToken === "string" && pageToken ? source(await this.get(videoId, { fields: "source" }, pageToken)) : undefined;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "META_PERMISSION_DENIED" || error.code === "META_REQUEST_FAILED")) return undefined;
      throw error;
    }
  }


  async lifetimeResults(accountId: string, adId: string): Promise<MetaAdSummary | undefined> {
    const id = this.assertAccount(accountId);
    if (!/^[0-9]+$/.test(adId)) throw new DomainError("META_AD_INVALID", "Meta ad IDs are numeric.");
    const page = await this.get(`${adId}/insights`, { fields: INSIGHT_FIELDS, date_preset: "maximum" });
    const row = ((page.data ?? []) as Raw[])[0];
    return row ? summary(id, row) : undefined;
  }
}
