import { DomainError } from "@koolezt/domain";
import type { Product, ProductAsset, ProductClaim, StorageProvider } from "@koolezt/domain";

/** The product operations the importer needs; implemented by CreativeFactoryService. */
export interface ProductCatalog {
  listProducts(): Promise<readonly Product[]>;
  createProduct(input: Readonly<{ name: string; slug: string; description: string; claims: readonly ProductClaim[]; defaultCta: string; assets: readonly ProductAsset[] }>): Promise<Product>;
  updateProduct(productId: string, input: Readonly<{ name: string; slug: string; description: string; claims: readonly ProductClaim[]; defaultCta: string; creativeNotes?: string; assets: readonly ProductAsset[] }>): Promise<Product>;
}

type ShopifyProduct = Readonly<{
  title?: string; handle?: string; body_html?: string;
  options?: readonly Readonly<{ name?: string; values?: readonly string[] }>[];
  images?: readonly Readonly<{ src?: string }>[];
}>;

const MAX_PHOTOS = 10;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"", ndash: "-", mdash: "-", hellip: "...", deg: "°", times: "x" };

const decode = (value: string) => value
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);

/** Shopify description HTML to plain text: one paragraph or list item per line. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(text).split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** Care tips, warnings and disclaimers are kept as restrictions (things ads must respect), not as selling claims. */
const RESTRICTION = /^(avoid|do not|don't|never|please|clean|to prevent|to maintain|actual colou?r|for the longest|note|caution|warning)\b/i;

/** List items of the description (and multi-value options such as sizes) become product facts; prices are never facts. */
export function factsFrom(product: ShopifyProduct): ProductClaim[] {
  const options = (product.options ?? []).filter((option) => option.name && option.name.toLowerCase() !== "title" && (option.values?.length ?? 0) > 1)
    .map((option) => `Available ${option.name!.toLowerCase()}: ${option.values!.join(", ")}`);
  const items = [...(product.body_html ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => htmlToText(match[1] ?? "").replace(/^•\s*/, ""));
  const seen = new Set<string>();
  return [...options, ...items]
    .map((item) => item.replace(/^[^\p{L}\p{N}"(]+/u, "").trim())
    .filter((item) => {
      const key = item.toLowerCase().replace(/[.!\s]+$/, "");
      if (item.length < 3 || /\$\s?\d/.test(item) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 40)
    .map((text) => ({ kind: RESTRICTION.test(text) ? "RESTRICTION" as const : "FEATURE" as const, text: text.slice(0, 500) }));
}

/**
 * Imports a product from the owner's own Shopify store using its public product data (the product link + ".json"):
 * title, description, facts from the description's list items and options, and up to 10 photos.
 * A product with the same handle is updated instead: new photos are added and empty fields filled; the owner's edits are kept.
 */
export class StoreProductImporter {
  constructor(private readonly d: Readonly<{ catalog: ProductCatalog; storage: StorageProvider; allowedHosts: readonly string[]; fetch?: typeof fetch; actor?: string }>) {}

  private allowed(host: string) {
    const bare = (value: string) => value.toLowerCase().replace(/^www\./, "");
    return this.d.allowedHosts.some((allowedHost) => bare(allowedHost) === bare(host));
  }

  private async get(url: string, accept: string): Promise<Response> {
    const response = await (this.d.fetch ?? fetch)(url, { headers: { accept, "user-agent": "KooleztCreativeFactory/1.0" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new DomainError("STORE_IMPORT_FAILED", `The store answered ${response.status} for ${new URL(url).pathname}.`);
    return response;
  }

  async import(link: string): Promise<Readonly<{ product: Product; created: boolean; photosAdded: number }>> {
    let url: URL;
    try { url = new URL(link.trim()); } catch { throw new DomainError("STORE_IMPORT_URL_INVALID", "Paste the full product link, for example https://www.koolezt.com/products/…"); }
    if (url.protocol !== "https:" || !this.allowed(url.hostname)) throw new DomainError("STORE_IMPORT_URL_INVALID", `Only product links from ${this.d.allowedHosts.join(" or ")} can be imported.`);
    const handle = /\/products\/([a-z0-9][a-z0-9-]*)/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (!handle) throw new DomainError("STORE_IMPORT_URL_INVALID", "This is not a product link (it should contain /products/…).");
    const response = await this.get(`https://${url.hostname}/products/${handle}.json`, "application/json");
    if (!this.allowed(new URL(response.url || url.href).hostname)) throw new DomainError("STORE_IMPORT_URL_INVALID", "The store redirected to another site.");
    const data = (await response.json().catch(() => ({}))) as { product?: ShopifyProduct };
    const source = data.product;
    if (!source?.title) throw new DomainError("STORE_IMPORT_FAILED", "The store did not return product details for this link.");
    const slug = (source.handle ?? handle).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || handle;
    const description = (htmlToText(source.body_html ?? "") || decode(source.title)).slice(0, 5_000);
    const facts = factsFrom(source);
    const found = (await this.d.catalog.listProducts()).find((product) => product.slug === slug);
    // Media is stored under the product's id, so a new product is created first and gets its photos right after.
    const existing = found ?? await this.d.catalog.createProduct({ name: decode(source.title).trim().slice(0, 160), slug, description, claims: facts, defaultCta: "Shop now", assets: [] });

    // Photos: Shopify CDN images resized to 1600px; ones already on the product (same file name) are skipped.
    const known = new Set(existing.assets.map((asset) => asset.label));
    const photos: ProductAsset[] = [];
    for (const image of (source.images ?? []).slice(0, MAX_PHOTOS)) {
      if (!image.src) continue;
      const src = new URL(image.src.startsWith("//") ? `https:${image.src}` : image.src);
      if (src.protocol !== "https:" || !(src.hostname === "cdn.shopify.com" || this.allowed(src.hostname))) continue;
      const label = decodeURIComponent(src.pathname.split("/").pop() ?? "photo").slice(0, 160);
      if (known.has(label)) continue;
      src.searchParams.set("width", "1600");
      const download = await this.get(src.href, "image/*");
      const mimeType = (download.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const extension = IMAGE_TYPES[mimeType];
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (!extension || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) continue;
      const asset = await this.d.storage.put(`products/${slug}/${label}`, { bytes, mimeType, extension, metadata: { projectId: existing.id, purpose: "PRODUCT_ASSET", originalFilename: label, sourceUrl: src.href, uploadedBy: this.d.actor ?? "store-import" } });
      photos.push({ id: asset.id, kind: "IMAGE", label, storageKey: asset.storageKey, mimeType });
      known.add(label);
    }

    const product = await this.d.catalog.updateProduct(existing.id, {
      name: existing.name, slug: existing.slug, description: existing.description || description, claims: existing.claims.length ? existing.claims : facts,
      defaultCta: existing.defaultCta, ...(existing.creativeNotes ? { creativeNotes: existing.creativeNotes } : {}), assets: [...existing.assets, ...photos]
    });
    return { product, created: !found, photosAdded: photos.length };
  }
}
