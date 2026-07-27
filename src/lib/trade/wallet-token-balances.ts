import {
  fetchHeliusAddressBalances,
  fetchWalletSplTokenBalance,
  getWalletBalances,
} from "@/lib/solana-balance";
import { TRADE_ALL_TOKEN_DEFS } from "@/lib/trade/curated-markets";

export type TradeWalletTokenBalance = {
  symbol: string;
  mint: string;
  decimals: number;
  amount: number;
};

const CORE_SYMBOL = new Set(["SOL", "USDC", "BUDJU", "GLITCH"]);

function heliusTokenAmount(
  tokens: { mint: string; amount: number; decimals: number }[],
  mint: string,
  fallbackDecimals: number,
): number {
  const row = tokens.find((t) => t.mint === mint);
  if (!row) return 0;
  const decimals = row.decimals || fallbackDecimals;
  return row.amount / 10 ** decimals;
}

/** All trade-lane mints (core + Jupiter curated) for portfolio / Earn UI. */
export async function getTradeWalletTokenBalances(
  walletAddress: string,
): Promise<TradeWalletTokenBalance[]> {
  const [core, helius] = await Promise.all([
    getWalletBalances(walletAddress),
    fetchHeliusAddressBalances(walletAddress),
  ]);
  const tokens = helius?.tokens ?? [];

  const coreAmount: Record<string, number> = {
    SOL: core.sol_balance,
    USDC: core.usdc_balance,
    BUDJU: core.budju_balance,
    GLITCH: core.glitch_balance,
  };

  const curated = TRADE_ALL_TOKEN_DEFS.filter((d) => !CORE_SYMBOL.has(d.symbol));
  const curatedAmounts = await Promise.all(
    curated.map(async (def) => {
      let amount = heliusTokenAmount(tokens, def.mint, def.decimals);
      if (amount <= 0) {
        amount = await fetchWalletSplTokenBalance(walletAddress, def.mint, def.decimals);
      }
      return { mint: def.mint, amount };
    }),
  );
  const curatedByMint = new Map(curatedAmounts.map((r) => [r.mint, r.amount]));

  return TRADE_ALL_TOKEN_DEFS.map((def) => {
    const amount = CORE_SYMBOL.has(def.symbol)
      ? (coreAmount[def.symbol] ?? 0)
      : (curatedByMint.get(def.mint) ?? 0);
    return {
      symbol: def.symbol,
      mint: def.mint,
      decimals: def.decimals,
      amount,
    };
  });
}
