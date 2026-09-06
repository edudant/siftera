import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@siftera/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@siftera/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.integration.test.ts"], testTimeout: 30_000 },
});
