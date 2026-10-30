import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CreativeFactoryService, htmlToText, StoreProductImporter } from "@koolezt/application";
import { InMemoryCreativeStrategyStore, InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const shopifyProduct = {
  product: {
    title: "Personalized Dog Address Sign &ndash; Custom Metal Plaque", handle: "dog-address-sign",
    body_html: "<p>Show off your <strong>dog</strong> &amp; your home.</p><ul><li>Laser-cut 16-gauge steel</li><li>Weather-resistant powder coat</li><li>Now only $38.49!</li><li>🌞 Avoid pressure washers</li><li>Laser-cut 16-gauge steel.</li></ul>",
    options: [{ name: "Title", values: ["Default"] }, { name: "Size", values: ["8\"", "12\"", "18\""] }],
    images: [{ src: "https://cdn.shopify.com/s/files/1/0001/front.png?v=1" }, { src: "https://evil.example.com/x.png" }, { src: "//cdn.shopify.com/s/files/1/0001/side.png" }]
  }
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "store-import-"));
  const repository = new InMemoryFactoryRepository();
  const storage = new LocalStorageProvider(join(root, "media"));
  const service = new CreativeFactoryService({ repository, strategyRepository: new InMemoryCreativeStrategyStore(repository), creativeProvider: new FakeCreativeProvider(), videoProvider: new FakeVideoGenerationProvider(), voiceProvider: new FakeVoiceProvider(), compositionProvider: new FakeCompositionProvider(), externalMediaDelivery: new FakeExternalMediaDeliveryProvider(), compositionOutputIngestor: new InlineCompositionOutputIngestor(), storage, mediaInspector: new MetadataMediaInspector(), readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage) });
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/products/dog-address-sign.json")) return Object.assign(new Response(JSON.stringify(shopifyProduct), { headers: { "content-type": "application/json" } }), {});
    if (href.startsWith("https://cdn.shopify.com/")) return new Response(png, { headers: { "content-type": "image/png" } });
    return new Response("not found", { status: 404 });
  });
  const importer = new StoreProductImporter({ catalog: service, storage, allowedHosts: ["www.koolezt.com", "koolezt.com"], fetch: fetchMock as unknown as typeof fetch });
  return { root, service, importer, fetchMock, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe("product import from the owner's store", () => {
  it("creates a product with description, facts and photos, and adds only new photos on a second import", async () => {
    const s = await setup();
    try {
      const first = await s.importer.import("https://www.koolezt.com/collections/dogs/products/dog-address-sign?variant=1");
      expect(first.created).toBe(true);
      expect(first.product).toMatchObject({ name: "Personalized Dog Address Sign - Custom Metal Plaque", slug: "dog-address-sign", defaultCta: "Shop now" });
      expect(first.product.description).toBe("Show off your dog & your home.\n• Laser-cut 16-gauge steel\n• Weather-resistant powder coat\n• Now only $38.49!\n• 🌞 Avoid pressure washers\n• Laser-cut 16-gauge steel.");
      // Prices never become facts; size options do.
      expect(first.product.claims.map((claim) => claim.text)).toEqual(["Available size: 8\", 12\", 18\"", "Laser-cut 16-gauge steel", "Weather-resistant powder coat", "Avoid pressure washers"]);
      expect(first.product.claims.at(-1)!.kind).toBe("RESTRICTION");
      // Images from other hosts are skipped; Shopify CDN images are fetched at 1600px.
      expect(first.photosAdded).toBe(2);
      expect(first.product.assets.map((asset) => asset.label)).toEqual(["front.png", "side.png"]);
      expect(s.fetchMock.mock.calls.map(([url]) => String(url))).toContain("https://cdn.shopify.com/s/files/1/0001/front.png?v=1&width=1600");
      const second = await s.importer.import("https://koolezt.com/products/dog-address-sign");
      expect(second).toMatchObject({ created: false, photosAdded: 0 });
      expect((await s.service.listProducts())).toHaveLength(1);
    } finally { await s.dispose(); }
  });

  it("refuses links from other sites and links that are not products", async () => {
    const s = await setup();
    try {
      await expect(s.importer.import("https://evil.example.com/products/dog-address-sign")).rejects.toMatchObject({ code: "STORE_IMPORT_URL_INVALID" });
      await expect(s.importer.import("http://www.koolezt.com/products/dog-address-sign")).rejects.toMatchObject({ code: "STORE_IMPORT_URL_INVALID" });
      await expect(s.importer.import("https://www.koolezt.com/collections/dogs")).rejects.toMatchObject({ code: "STORE_IMPORT_URL_INVALID" });
      await expect(s.importer.import("https://www.koolezt.com/products/missing")).rejects.toMatchObject({ code: "STORE_IMPORT_FAILED" });
      expect(s.fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["https://www.koolezt.com/products/missing.json"]);
    } finally { await s.dispose(); }
  });

  it("turns description HTML into readable lines", () => {
    expect(htmlToText("<h3>Why you'll love it</h3><p>Made&nbsp;to last<br>outside</p><script>x()</script>")).toBe("Why you'll love it\nMade to last\noutside");
  });
});
