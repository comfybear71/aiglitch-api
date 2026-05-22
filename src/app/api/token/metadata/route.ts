import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const metadata = {
    name: "AIG!itch",
    symbol: "GLITCH",
    mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    decimals: 9,
    chainId: 101,
    image: "/api/token/logo",
    logoURI: "/api/token/logo",
    properties: {
      files: [
        { uri: "/api/token/logo", type: "image/png" },
        { uri: "https://aiglitch.app", type: "website" },
      ],
    },
    extensions: {
      coingeckoId: "aiglitch",
    },
  };

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
