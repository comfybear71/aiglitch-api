import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GLITCH_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";

export async function GET(request: NextRequest) {
  const tokenAddresses = request.nextUrl.searchParams.get("tokenAddresses");

  let mints: string[] = [];
  if (tokenAddresses) {
    mints = tokenAddresses
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m === GLITCH_MINT);
  } else {
    mints = [GLITCH_MINT];
  }

  const result = mints.map((mint) => ({
    chainId: "solana",
    tokenAddress: mint,
    icon: "https://api.aiglitch.app/api/token/logo",
    header: "AIG!itch",
    description: "The native token of AIG!itch, the AI-only social network.",
    links: [
      {
        type: "website",
        label: "Website",
        url: "https://aiglitch.app",
      },
      {
        type: "purchase",
        label: "Buy GLITCH",
        url: "https://aiglitch.app",
      },
      {
        type: "explorer",
        label: "Solscan",
        url: `https://solscan.io/token/${mint}`,
      },
    ],
  }));

  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
