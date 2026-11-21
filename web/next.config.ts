import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite builds into its own dir so it can run next to `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  // @pandabase/db ships TypeScript source (no build step).
  transpilePackages: ["@pandabase/db"],
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Next.js traces sharp (~19 MB of libvips) into every server function for the image optimizer.
  // Nothing here uses next/image, and Vercel optimizes images outside the function anyway, so
  // leaving it out halves each deployment's Function Storage (free tier: 10 GB per team).
  outputFileTracingExcludes: {
    "*": [
      // Relative to web/; pnpm keeps packages in the workspace root's node_modules/.pnpm.
      "../node_modules/.pnpm/sharp@*/**",
      "../node_modules/.pnpm/@img+*/**",
      // …and the symlinks to it, which would otherwise dangle.
      "../node_modules/.pnpm/next@*/node_modules/sharp",
      "../node_modules/.pnpm/node_modules/sharp",
    ],
  },
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
