import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreativeFactoryService } from "@koolezt/application";
import { InMemoryFactoryRepository } from "@koolezt/infrastructure";
import { FakeExternalMediaDeliveryProvider, InlineCompositionOutputIngestor, LocalReadyPublisher, LocalStorageProvider, MetadataMediaInspector } from "@koolezt/media";
import { FakeCompositionProvider, FakeCreativeProvider, FakeVideoGenerationProvider, FakeVoiceProvider } from "@koolezt/providers";

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koolezt-api-test-"));
  const repository = new InMemoryFactoryRepository();
  const storage = new LocalStorageProvider(join(root, "working"));
  const creativeProvider = new FakeCreativeProvider();
  const voiceProvider = new FakeVoiceProvider();
  const service = new CreativeFactoryService({
    repository,
    creativeProvider,
    videoProvider: new FakeVideoGenerationProvider(),
    voiceProvider,
    compositionProvider: new FakeCompositionProvider(),
    externalMediaDelivery: new FakeExternalMediaDeliveryProvider(),
    compositionOutputIngestor: new InlineCompositionOutputIngestor(),
    storage,
    mediaInspector: new MetadataMediaInspector(),
    readyPublisher: new LocalReadyPublisher(join(root, "ready"), storage)
  });
  const product = await service.createProduct({
    name: "Test product",
    slug: "test-product",
    description: "A product used by the API contract test.",
    claims: [{ kind: "FEATURE", text: "Accurate personalization" }],
    defaultCta: "Create yours",
    assets: [{ id: "mockup-1", kind: "IMAGE", label: "Mockup", storageKey: "products/mockup.png", mimeType: "image/png" }]
  });
  return { service, repository, storage, product, creativeProvider, voiceProvider, dispose: () => rm(root, { recursive: true, force: true }) };
}
