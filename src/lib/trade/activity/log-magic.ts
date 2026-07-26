import { mintDecimals } from "@/lib/trade/build-transfer";
import { insertTradeActivity } from "@/lib/trade/activity/db";
import type { MagicClaimRow } from "@/lib/trade/magic-claim/db";

export function magicAmountDisplay(row: MagicClaimRow): string {
  const dec = mintDecimals(row.symbol);
  const n = Number(row.amount_atomic) / 10 ** dec;
  return n.toLocaleString(undefined, { maximumFractionDigits: dec });
}

export async function logMagicDeposit(row: MagicClaimRow, signature: string): Promise<void> {
  await insertTradeActivity({
    wallet: row.sender_wallet,
    kind: "magic_deposit",
    signature,
    symbol: row.symbol,
    amountDisplay: magicAmountDisplay(row),
    detail: `Magic link · ${row.claim_id.slice(0, 8)}…`,
    claimId: row.claim_id,
  });
}

export async function logMagicRefund(row: MagicClaimRow, signature: string): Promise<void> {
  await insertTradeActivity({
    wallet: row.sender_wallet,
    kind: "magic_refund",
    signature,
    symbol: row.symbol,
    amountDisplay: magicAmountDisplay(row),
    detail: `Refund · ${row.claim_id.slice(0, 8)}…`,
    claimId: row.claim_id,
  });
}

export async function logMagicClaim(
  row: MagicClaimRow,
  recipientWallet: string,
  signature: string,
): Promise<void> {
  await insertTradeActivity({
    wallet: recipientWallet,
    kind: "magic_claim",
    signature,
    symbol: row.symbol,
    amountDisplay: magicAmountDisplay(row),
    detail: `Claim from ${row.sender_wallet.slice(0, 4)}…${row.sender_wallet.slice(-4)}`,
    claimId: row.claim_id,
  });
}
