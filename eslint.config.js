import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", ".wrangler/**"] },
  { files: ["apps/web/public/sw.js"], languageOptions: { globals: { self:"readonly", caches:"readonly", URL:"readonly", fetch:"readonly" } } },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
