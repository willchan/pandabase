import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite builds into its own dir so it can run next to `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  // @pandabase/db ships TypeScript source (no build step).
  transpilePackages: ["@pandabase/db"],
  serverExternalPackages: ["@libsql/client", "libsql"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
