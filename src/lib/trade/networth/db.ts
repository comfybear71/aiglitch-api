import { getDb } from "@/lib/db";

export type NetWorthRow = {
  id: string;
  wallet: string;
  usd: number;
  created_at: Date;
};

const MAX_ROWS_PER_WALLET = 96;
const MIN_GAP_MS = 5 * 60 * 1000;
const USD_EPS = 0.01;

let schemaReady: Promise<void> | null = null;

export function ensureNetWorthSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getDb();
      await sql`
        CREATE TABLE IF NOT EXISTS trade_wallet_networth (
          id BIGSERIAL PRIMARY KEY,
          wallet TEXT NOT NULL,
          usd DOUBLE PRECISION NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS trade_wallet_networth_wallet_idx
        ON trade_wallet_networth (wallet, created_at DESC)
      `;
    })();
  }
  return schemaReady;
}

export async function listNetWorthSnapshots(
  wallet: string,
  limit = 48,
): Promise<NetWorthRow[]> {
  await ensureNetWorthSchema();
  const sql = getDb();
  const cap = Math.min(96, Math.max(1, limit));
  const rows = await sql`
    SELECT id::text, wallet, usd, created_at
    FROM trade_wallet_networth
    WHERE wallet = ${wallet}
    ORDER BY created_at ASC
    LIMIT ${cap}
  `;
  return rows as NetWorthRow[];
}

export async function appendNetWorthSnapshot(
  wallet: string,
  usd: number,
): Promise<{ inserted: boolean }> {
  await ensureNetWorthSchema();
  if (!Number.isFinite(usd) || usd < 0) return { inserted: false };

  const sql = getDb();
  const [last] = (await sql`
    SELECT usd, created_at
    FROM trade_wallet_networth
    WHERE wallet = ${wallet}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as [{ usd: number; created_at: Date } | undefined];

  if (last) {
    const age = Date.now() - new Date(last.created_at).getTime();
    if (age < MIN_GAP_MS && Math.abs(Number(last.usd) - usd) <= USD_EPS) {
      return { inserted: false };
    }
  }

  await sql`
    INSERT INTO trade_wallet_networth (wallet, usd)
    VALUES (${wallet}, ${usd})
  `;

  await sql`
    DELETE FROM trade_wallet_networth
    WHERE id IN (
      SELECT id FROM trade_wallet_networth
      WHERE wallet = ${wallet}
      ORDER BY created_at DESC
      OFFSET ${MAX_ROWS_PER_WALLET}
    )
  `;

  return { inserted: true };
}
