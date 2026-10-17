import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@koolezt/domain": `${root}packages/domain/src/index.ts`,
      "@koolezt/contracts": `${root}packages/contracts/src/index.ts`,
      "@koolezt/application": `${root}packages/application/src/index.ts`,
      "@koolezt/providers": `${root}packages/providers/src/index.ts`,
      "@koolezt/infrastructure": `${root}packages/infrastructure/src/index.ts`,
      "@koolezt/media": `${root}packages/media/src/index.ts`
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000
  }
});
