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
