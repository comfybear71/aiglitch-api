/** Minimum on-chain $BUDJU balance to unlock trader features on trade.aiglitch.app */
export function getTradeBudjuMinRequired(): number {
  const raw = process.env.TRADE_BUDJU_MIN_BALANCE;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1_000_000;
}
