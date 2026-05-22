import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const tokenList = {
    name: "AIG!itch Token List",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [
      {
        chainId: 101,
        address: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
        symbol: "GLITCH",
        name: "AIG!itch",
        decimals: 9,
        logoURI: "https://api.aiglitch.app/api/token/logo",
      },
    ],
  };

  return NextResponse.json(tokenList, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
