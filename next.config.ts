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
   * Next.js 16 bundles node_modules into the server JS by default.
   * `ffmpeg-static` exports the binary path via
   * `path.join(__dirname, 'ffmpeg')` — once bundled, __dirname resolves
   * to the bundle's location (not the package's), so spawn fails with
   * `ENOENT spawn /ROOT/.next/...`. `serverExternalPackages` tells Next
   * to keep `ffmpeg-static` external, so `require('ffmpeg-static')` at
   * runtime resolves to the real node_modules path with the right
   * __dirname. (This is the lesson from breaking-news Mode B v1.50.1.)
   */
  serverExternalPackages: ["ffmpeg-static"],

  /**
   * Belt + suspenders alongside serverExternalPackages: tell the file
   * tracer to include the binary in the lambda. Listed against every
   * route whose handler can spawn ffmpeg. Add new routes when they
   * start calling `stitchClipsWithReencode`.
   */
  outputFileTracingIncludes: {
    "/api/admin/ads/[id]/generate": ["./node_modules/ffmpeg-static/**"],
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
