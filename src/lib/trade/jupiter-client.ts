/**
 * Jupiter quote + unsigned swap tx for meatbag wallets (Phantom signs client-side).
 * Server never holds user keys. Requires JUPITER_API_KEY.
 */

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
} from "@/lib/solana-config";

const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1/swap";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Homegrown trade lane — no arbitrary meme routing in v1. */
export const TRADE_ALLOWED_MINTS = new Set([
  SOL_MINT,
  USDC_MINT_STR,
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
]);

function jupiterApiKey(): string | null {
  const key = process.env.JUPITER_API_KEY?.trim();
  return key || null;
}

export function assertAllowedMint(mint: string): void {
  if (!TRADE_ALLOWED_MINTS.has(mint)) {
    throw new Error("Token not enabled on AIG!itch Trade yet");
  }
}

export async function fetchJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<Record<string, unknown>> {
  const apiKey = jupiterApiKey();
  if (!apiKey) throw new Error("JUPITER_API_KEY not configured");

  assertAllowedMint(params.inputMint);
  assertAllowedMint(params.outputMint);

  const slippageBps = params.slippageBps ?? 100;
  const url = `${JUPITER_QUOTE_API}?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter quote failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) throw new Error(String(data.error));
  return data;
}

export async function buildJupiterSwapTransaction(params: {
  quoteResponse: Record<string, unknown>;
  userPublicKey: string;
}): Promise<{ swapTransaction: string }> {
  const apiKey = jupiterApiKey();
  if (!apiKey) throw new Error("JUPITER_API_KEY not configured");

  const res = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 100_000,
          priorityLevel: "low",
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter swap build failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!data.swapTransaction) {
    throw new Error(data.error || "No swap transaction returned");
  }
  return { swapTransaction: data.swapTransaction };
}

export { SOL_MINT };
