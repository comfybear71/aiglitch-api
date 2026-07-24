/** Minimum on-chain $BUDJU balance to unlock trader features on trade.aiglitch.app */
export function getTradeBudjuMinRequired(): number {
  const raw = process.env.TRADE_BUDJU_MIN_BALANCE;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1_000_000;
}

/** Default max slippage on Jupiter quotes (100 = 1%). */
export const TRADE_DEFAULT_SLIPPAGE_BPS = 100;

/** Cap on Solana priority fee baked into swap tx build (`priorityLevel: low`). */
export const TRADE_MAX_PRIORITY_FEE_LAMPORTS = 100_000;

export function getTradeMaxPriorityFeeSol(): number {
  return TRADE_MAX_PRIORITY_FEE_LAMPORTS / 1e9;
}
