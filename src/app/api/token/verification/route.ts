import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const bundle = {
    token: {
      mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
      decimals: 9,
    },
    links: {
      metadata_json: "https://api.aiglitch.app/api/token/metadata",
      solana_fm: "https://solana.fm/address/5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    },
    explorers: {
      solscan: "https://solscan.io/token/5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
      solanafm: "https://solana.fm/address/5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    },
    dex: {
      meteoraPool: "Meteora",
      meteoraPoolAddress: "GWBsH6aArjdwmX8zUaiPdDke1nA7pLLe9x9b1kuHpsGV",
    },
    wallets: {
      treasury: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
      admin: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    },
    submissionGuides: {
      jupiter: {
        steps: [
          "Visit https://station.jup.ag",
          "Submit GLITCH token mint",
          "Include branding assets",
        ],
      },
      coingecko: {
        url: "https://www.coingecko.com/en/request_form",
      },
      coinmarketcap: {
        steps: [
          "Register on CoinMarketCap",
          "Submit token for listing",
          "Include metadata",
        ],
      },
      dexscreener: {
        steps: [
          "Token auto-appears on DexScreener",
          "Update metadata via GitHub",
        ],
      },
      birdeye: {
        steps: [
          "Visit https://birdeye.so",
          "Search GLITCH token",
          "Verify ownership",
        ],
      },
    },
  };

  return NextResponse.json(bundle, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
    },
  });
}
