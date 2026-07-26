import { getDb } from "@/lib/db";

export type TradeActivityKind =
  | "transfer"
  | "swap"
  | "magic_deposit"
  | "magic_refund"
  | "magic_claim";

export type TradeActivityRow = {
  id: string;
  wallet: string;
  kind: TradeActivityKind;
  signature: string | null;
  symbol: string | null;
  amount_display: string | null;
  detail: string | null;
  claim_id: string | null;
  created_at: Date;
};

let schemaReady: Promise<void> | null = null;

export function ensureTradeActivitySchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getDb();
      await sql`
        CREATE TABLE IF NOT EXISTS trade_wallet_activity (
          id BIGSERIAL PRIMARY KEY,
          wallet TEXT NOT NULL,
          kind TEXT NOT NULL,
          signature TEXT,
          symbol TEXT,
          amount_display TEXT,
          detail TEXT,
          claim_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS trade_wallet_activity_wallet_idx
        ON trade_wallet_activity (wallet, created_at DESC)
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS trade_wallet_activity_sig_uq
        ON trade_wallet_activity (signature)
        WHERE signature IS NOT NULL
      `;
    })();
  }
  return schemaReady;
}

export async function insertTradeActivity(row: {
  wallet: string;
  kind: TradeActivityKind;
  signature?: string | null;
  symbol?: string | null;
  amountDisplay?: string | null;
  detail?: string | null;
  claimId?: string | null;
}): Promise<void> {
  await ensureTradeActivitySchema();
  const sql = getDb();
  const sig = row.signature?.trim() || null;
  if (sig) {
    const existing = await sql`
      SELECT 1 FROM trade_wallet_activity WHERE signature = ${sig} LIMIT 1
    `;
    if (existing.length > 0) return;
  }
  await sql`
    INSERT INTO trade_wallet_activity (
      wallet, kind, signature, symbol, amount_display, detail, claim_id
    ) VALUES (
      ${row.wallet},
      ${row.kind},
      ${sig},
      ${row.symbol ?? null},
      ${row.amountDisplay ?? null},
      ${row.detail ?? null},
      ${row.claimId ?? null}
    )
  `;
}

export async function listTradeActivity(
  wallet: string,
  limit = 50,
): Promise<TradeActivityRow[]> {
  await ensureTradeActivitySchema();
  const sql = getDb();
  const rows = await sql`
    SELECT id::text, wallet, kind, signature, symbol, amount_display, detail, claim_id, created_at
    FROM trade_wallet_activity
    WHERE wallet = ${wallet}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as TradeActivityRow[];
}
