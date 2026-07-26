import { OTC } from "@/lib/bible/constants";
import { getDb } from "@/lib/db";

export function calculateOtcBondingCurvePrice(totalGlitchSold: number, solPriceUsd: number) {
  const tier = Math.floor(totalGlitchSold / OTC.tierSize);
  const priceUsd = OTC.basePriceUsd + tier * OTC.incrementUsd;
  const priceSol = solPriceUsd > 0 ? priceUsd / solPriceUsd : 0;
  const nextTierAt = (tier + 1) * OTC.tierSize;
  const remainingInTier = nextTierAt - totalGlitchSold;
  const nextPriceUsd = priceUsd + OTC.incrementUsd;

  return {
    price_usd: priceUsd,
    price_sol: priceSol,
    tier,
    next_tier_at: nextTierAt,
    remaining_in_tier: remainingInTier,
    next_price_usd: nextPriceUsd,
    next_price_sol: solPriceUsd > 0 ? nextPriceUsd / solPriceUsd : 0,
  };
}

/** Live OTC §GLITCH USD price (bonding curve from completed swaps). */
export async function getOtcGlitchPriceUsd(): Promise<number | null> {
  try {
    const sql = getDb();
    const [solSetting] = (await sql`
      SELECT value FROM platform_settings WHERE key = 'sol_price_usd'
    `.catch(() => [null])) as unknown as Array<{ value: string } | null>;
    const solPriceUsd = parseFloat(solSetting?.value ?? "164");

    const [stats] = (await sql`
      SELECT COALESCE(SUM(glitch_amount), 0) as glitch_sold
      FROM otc_swaps WHERE status = 'completed'
    `.catch(() => [{ glitch_sold: 0 }])) as unknown as Array<{ glitch_sold: number }>;

    const totalGlitchSold = Number(stats?.glitch_sold ?? 0);
    return calculateOtcBondingCurvePrice(totalGlitchSold, solPriceUsd).price_usd;
  } catch {
    return null;
  }
}
