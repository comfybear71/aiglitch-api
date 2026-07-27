import { fetchHeliusAddressBalances } from "@/lib/solana-balance";
import { SOL_MINT, TRADE_ALL_TOKEN_DEFS } from "@/lib/trade/curated-markets";

export type TradeWalletTokenBalance = {
  symbol: string;
  mint: string;
  decimals: number;
  amount: number;
};

/** All trade-lane mints (core + Jupiter curated) for portfolio / Earn UI. */
export async function getTradeWalletTokenBalances(
  walletAddress: string,
): Promise<TradeWalletTokenBalance[]> {
  const helius = await fetchHeliusAddressBalances(walletAddress);
  const tokens = helius?.tokens ?? [];
  const nativeSol = Number(helius?.nativeBalance ?? 0) / 1_000_000_000;

  return TRADE_ALL_TOKEN_DEFS.map((def) => {
    if (def.mint === SOL_MINT) {
      return {
        symbol: def.symbol,
        mint: def.mint,
        decimals: def.decimals,
        amount: nativeSol,
      };
    }
    const row = tokens.find((t) => t.mint === def.mint);
    if (!row) {
      return {
        symbol: def.symbol,
        mint: def.mint,
        decimals: def.decimals,
        amount: 0,
      };
    }
    const decimals = row.decimals || def.decimals;
    return {
      symbol: def.symbol,
      mint: def.mint,
      decimals,
      amount: row.amount / 10 ** decimals,
    };
  });
}
