import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/token/logo.png
 *
 * 302 redirect to the SVG logo. Many aggregators (CoinGecko, Jupiter,
 * DexScreener) require a PNG/JPG logo URL and don't render SVG inline,
 * but most modern services will follow a 302 and accept the SVG body
 * with the correct Content-Type. Matches legacy behaviour; for
 * registries that strictly reject SVG, upload a real PNG asset to
 * Blob storage and swap the redirect target.
 */
export async function GET() {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: "/api/token/logo",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
