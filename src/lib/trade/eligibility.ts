import { getWalletBalances, heliusEnabled } from "@/lib/solana-balance";
import { getTradeBudjuMinRequired } from "@/lib/trade/constants";

export interface TradeEligibilityResult {
  wallet: string;
  eligible: boolean;
  budju_balance: number;
  budju_required: number;
  budju_shortfall: number;
  helius_enabled: boolean;
  balances: {
    sol: number;
    glitch: number;
    budju: number;
    usdc: number;
  };
}

export async function getTradeEligibility(wallet: string): Promise<TradeEligibilityResult> {
  const required = getTradeBudjuMinRequired();
  const balances = await getWalletBalances(wallet);
  const budju = balances.budju_balance;
  const eligible = budju >= required;

  return {
    wallet,
    eligible,
    budju_balance: budju,
    budju_required: required,
    budju_shortfall: eligible ? 0 : Math.max(0, required - budju),
    helius_enabled: heliusEnabled(),
    balances: {
      sol: balances.sol_balance,
      glitch: balances.glitch_balance,
      budju,
      usdc: balances.usdc_balance,
    },
  };
}
