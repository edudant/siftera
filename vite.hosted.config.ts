import { defineConfig } from "vite";
import { sites } from "@openai/sites-vite-plugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [sites()],
  resolve: {alias: {
    "@siftera/shared": fileURLToPath(new URL("./packages/shared/src/index.ts",import.meta.url)),
    "@siftera/core": fileURLToPath(new URL("./packages/core/src/index.ts",import.meta.url)),
  }},
  ssr: {target:"webworker",noExternal:true,external:["node:crypto"]},
  build:{ssr:"apps/hosted/worker.ts",outDir:"dist/server",emptyOutDir:true,rollupOptions:{output:{entryFileNames:"index.js"}}},
});
