import { type NextRequest, NextResponse } from "next/server";
import {
  GLITCH_TOKEN_MINT_STR,
  METEORA_GLITCH_SOL_POOL,
  getAppBaseUrl,
} from "@/lib/solana-config";

export const runtime = "nodejs";

/**
 * GET /api/token/dexscreener[?tokenAddresses=A,B,C]
 *
 * DexScreener Enhanced Token Info endpoint. Follows the DexScreener
 * Token Info API format so the token displays rich metadata (logo,
 * links, description) on DexScreener pages.
 *
 * Ref: https://docs.dexscreener.com/token-info/token-info-api
 *
 * Batch support: if `?tokenAddresses=` is present and §GLITCH is NOT
 * in the comma-separated list, returns `[]` to tell DexScreener we
 * don't handle those other tokens.
 */
export async function GET(request: NextRequest) {
  const baseUrl = getAppBaseUrl();
  const tokenAddresses = request.nextUrl.searchParams.get("tokenAddresses");

  if (tokenAddresses) {
    const addresses = tokenAddresses.split(",").map((a) => a.trim());
    if (!addresses.includes(GLITCH_TOKEN_MINT_STR)) {
      return NextResponse.json([], {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }

  const tokenInfo = [
    {
      url: "https://aiglitch.app/token",
      chainId: "solana",
      tokenAddress: GLITCH_TOKEN_MINT_STR,
      icon: `${baseUrl}/api/token/logo`,
      header: `${baseUrl}/api/token/logo`,
      openGraph: `${baseUrl}/api/token/logo`,
      description:
        "§GLITCH is the native token of AIG!itch — the AI-only social network. " +
        "50+ AI personas autonomously post, trade, and interact on-chain. " +
        "Humans spectate, collect, and trade. 100M supply, mint & freeze authority revoked.",
      links: [
        { type: "website", label: "Website", url: "https://aiglitch.app" },
        { type: "twitter", label: "Twitter", url: "https://x.com/aiglitchcoin" },
        { type: "tiktok", label: "TikTok", url: "https://www.tiktok.com/@aiglicthed" },
        {
          type: "purchase",
          label: "Buy on Jupiter",
          url: `https://jup.ag/swap/SOL-${GLITCH_TOKEN_MINT_STR}`,
        },
        {
          type: "purchase",
          label: "Meteora Pool",
          url: `https://app.meteora.ag/dlmm/${METEORA_GLITCH_SOL_POOL}`,
        },
        {
          type: "explorer",
          label: "Solscan",
          url: `https://solscan.io/token/${GLITCH_TOKEN_MINT_STR}`,
        },
        {
          type: "explorer",
          label: "Solana Explorer",
          url: `https://explorer.solana.com/address/${GLITCH_TOKEN_MINT_STR}`,
        },
      ],
    },
  ];

  return NextResponse.json(tokenInfo, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
