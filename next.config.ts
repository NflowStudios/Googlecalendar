import type { NextConfig } from "next";

/**
 * Two build targets share this config:
 *
 *  1. Local dev + server build (default)  ->  output: "standalone"
 *     bun run dev   /   bun run build
 *
 *  2. GitHub Pages static export          ->  output: "export"
 *     bun run build:pages
 *     (sets BUILD_TARGET=pages + NEXT_PUBLIC_BASE_PATH=/Googlecalendar)
 *
 * GitHub Pages serves the site at https://<user>.github.io/Googlecalendar/,
 * i.e. under a SUBPATH — hence the basePath, which Next applies to pages,
 * chunks and everything routed through the Next asset pipeline. Runtime
 * fetches (the monster's audio loop, textures) are prefixed in game code
 * via `asset()` in src/game/utils.ts.
 */
const isPages = process.env.BUILD_TARGET === "pages";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: isPages ? "export" : "standalone",
  ...(isPages && basePath
    ? {
        basePath,
        // Plain <img> tags are used everywhere; no Next image optimizer in a
        // static export anyway.
        images: { unoptimized: true },
      }
    : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
