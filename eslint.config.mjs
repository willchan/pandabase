// Base ESLint config for TypeScript packages without their own config (e.g. /db).
// /web has its own config that layers eslint-config-next on top of the same rules.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "**/dist/**", "**/.next/**", "worker/**", "agent/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
]);
