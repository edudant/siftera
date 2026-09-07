import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", ".wrangler/**"] },
  { files: ["apps/web/public/sw.js"], languageOptions: { globals: { self:"readonly", caches:"readonly", URL:"readonly", fetch:"readonly", Response:"readonly", Promise:"readonly" } } },
  { files: ["scripts/build-demo-feed.mjs", "scripts/build-hosted.mjs", "scripts/build-pages.mjs"], languageOptions: { globals: { console:"readonly", fetch:"readonly", process:"readonly", URL:"readonly" } } },
  // Adaptér statické ukázky drží tvar síťového API, takže některé parametry zůstávají nevyužité záměrně.
  { files: ["apps/web/src/demo.ts"], rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
