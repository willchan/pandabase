import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // next-auth imports `next/server` without an extension; let Vite resolve it.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    exclude: ["node_modules/**", ".next/**"],
    coverage: {
      // Always on: the domain logic must stay ≥ 95% line-covered (PLAN M3).
      enabled: true,
      provider: "v8",
      include: ["lib/domain/**/*.ts", "lib/config.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { "lib/domain/**": { lines: 95 } },
    },
  },
});
