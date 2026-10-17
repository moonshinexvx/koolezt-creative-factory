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
    include: ["tests/integration/**/*.test.ts"],
    // Integration files share the explicitly isolated Redis database and some
    // existing suites reset it with FLUSHDB. Running files concurrently can
    // delete another suite's active BullMQ lock/job, so serialize files while
    // retaining each suite's own concurrency assertions.
    fileParallelism: false,
    // The isolated acceptance environment may be reached through a narrow
    // SSH tunnel. Keep application/provider timeouts unchanged while allowing
    // integration assertions to absorb cross-host database round trips.
    testTimeout: 90_000
  }
});
