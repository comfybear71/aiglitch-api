import { getDb } from "@/lib/db";

export type MagicClaimStatus =
  | "awaiting_deposit"
  | "pending"
  | "claimed"
  | "refunded"
  | "expired";

export type MagicClaimRow = {
  claim_id: string;
  sender_wallet: string;
  symbol: string;
  mint: string;
  amount_atomic: string;
  expires_at: Date;
  status: MagicClaimStatus;
  deposit_sig: string | null;
  claim_sig: string | null;
  refund_sig: string | null;
  created_at: Date;
};

let schemaReady: Promise<void> | null = null;

export function ensureMagicClaimSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getDb();
      await sql`
        CREATE TABLE IF NOT EXISTS trade_magic_claims (
          claim_id TEXT PRIMARY KEY,
          sender_wallet TEXT NOT NULL,
          symbol TEXT NOT NULL,
          mint TEXT NOT NULL,
          amount_atomic TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'awaiting_deposit',
          deposit_sig TEXT,
          claim_sig TEXT,
          refund_sig TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS trade_magic_claims_sender_idx
        ON trade_magic_claims (sender_wallet, created_at DESC)
      `;
    })();
  }
  return schemaReady;
}

export async function insertMagicClaim(row: {
  claimId: string;
  senderWallet: string;
  symbol: string;
  mint: string;
  amountAtomic: string;
  expiresAt: Date;
}): Promise<void> {
  await ensureMagicClaimSchema();
  const sql = getDb();
  await sql`
    INSERT INTO trade_magic_claims (
      claim_id, sender_wallet, symbol, mint, amount_atomic, expires_at, status
    ) VALUES (
      ${row.claimId},
      ${row.senderWallet},
      ${row.symbol},
      ${row.mint},
      ${row.amountAtomic},
      ${row.expiresAt.toISOString()},
      'awaiting_deposit'
    )
  `;
}

export async function getMagicClaim(claimId: string): Promise<MagicClaimRow | null> {
  await ensureMagicClaimSchema();
  const sql = getDb();
  const rows = await sql`
    SELECT claim_id, sender_wallet, symbol, mint, amount_atomic, expires_at, status,
           deposit_sig, claim_sig, refund_sig, created_at
    FROM trade_magic_claims WHERE claim_id = ${claimId} LIMIT 1
  `;
  const r = rows[0] as MagicClaimRow | undefined;
  return r ?? null;
}

export async function updateMagicClaimStatus(
  claimId: string,
  patch: Partial<{
    status: MagicClaimStatus;
    depositSig: string;
    claimSig: string;
    refundSig: string;
  }>,
): Promise<void> {
  await ensureMagicClaimSchema();
  const sql = getDb();
  const row = await getMagicClaim(claimId);
  if (!row) return;

  const status = patch.status ?? row.status;
  const deposit_sig = patch.depositSig ?? row.deposit_sig;
  const claim_sig = patch.claimSig ?? row.claim_sig;
  const refund_sig = patch.refundSig ?? row.refund_sig;

  await sql`
    UPDATE trade_magic_claims
    SET status = ${status},
        deposit_sig = ${deposit_sig},
        claim_sig = ${claim_sig},
        refund_sig = ${refund_sig}
    WHERE claim_id = ${claimId}
  `;
}
