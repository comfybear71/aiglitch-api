import { MAGIC_LINK_MAX_USD } from "@/lib/trade/magic-claim/config";
import { resolveMagicLinkMint } from "@/lib/trade/magic-claim/claim-id";

/** Enforce $500 notional cap per magic link. */
export async function assertMagicLinkWithinUsdCap(
  symbol: string,
  amountHuman: number,
): Promise<void> {
  if (!Number.isFinite(amountHuman) || amountHuman <= 0) {
    throw new Error("Invalid amount");
  }
  if (symbol === "USDC") {
    if (amountHuman > MAGIC_LINK_MAX_USD) {
      throw new Error(`Magic link max is $${MAGIC_LINK_MAX_USD} per link`);
    }
    return;
  }

  const mint = resolveMagicLinkMint(symbol);
  if (!mint) throw new Error("Token not supported");
  const res = await fetch(`https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`, {
    headers: process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : undefined,
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  let usdPrice = 0;
  if (res?.ok) {
    const data = (await res.json()) as Record<string, { usdPrice?: number }>;
    usdPrice = data[mint]?.usdPrice ?? 0;
  }
  if (usdPrice <= 0) throw new Error("Could not verify USD cap for this token");
  const notional = amountHuman * usdPrice;
  if (notional > MAGIC_LINK_MAX_USD) {
    throw new Error(
      `Magic link max is $${MAGIC_LINK_MAX_USD} per link (~$${notional.toFixed(2)} requested)`,
    );
  }
}
