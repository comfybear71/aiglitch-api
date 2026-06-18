import type { NextConfig } from "next";

/**
 * Strangler fallback.
 * Any `/api/*` path that doesn't match a route in this repo falls through to
 * the legacy backend. As endpoints migrate, they add a route and stop falling
 * through automatically — no proxy-config maintenance needed per endpoint.
 */
const LEGACY_BACKEND_URL = process.env.LEGACY_BACKEND_URL ?? "https://aiglitch.app";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * Next.js tree-shakes node_modules aggressively when building the
   * Vercel lambda bundle — anything not statically imported gets dropped,
   * including binary files that `ffmpeg-static` depends on at runtime.
   * `stitchClipsWithReencode` (src/lib/media/ffmpeg-stitch.ts) spawns
   * the bundled ffmpeg binary via child_process, which the tracer can't
   * detect as an import. Without the include below, the function deploys
   * but spawn fails at runtime with
   * `ENOENT spawn /ROOT/node_modules/ffmpeg-static/ffmpeg`.
   *
   * Listed against every route whose handler can trigger stitching.
   * Add new routes here when they start calling stitchClipsWithReencode.
   */
  outputFileTracingIncludes: {
    "/api/admin/breaking-news": ["./node_modules/ffmpeg-static/**"],
    "/api/generate-topics": ["./node_modules/ffmpeg-static/**"],
  },

  async rewrites() {
    return {
      fallback: [
        {
          source: "/api/:path*",
          destination: `${LEGACY_BACKEND_URL}/api/:path*`,
        },
      ],
    };
  },
};

export default config;
