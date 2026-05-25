/**
 * Admin API — refresh on-chain wallet balances for personas.
 *
 * Port of legacy aiglitch/src/app/api/admin/personas/refresh-wallet-balances/
 * route.ts. Reads SOL + BUDJU + USDC + GLITCH balances from Solana RPC and
 * caches them in `budju_wallets.{sol,budju,usdc,glitch}_balance` for fast
 * admin dashboard reads.
 *
 * Read-only vs Solana — only `getBalance` + `getTokenAccountBalance` calls,
 * no transactions ever signed. Writes only to the four cached-balance
 * columns plus `updated_at`. Never touches keypairs / private keys.
 *
 * Two modes:
 *   GET                  → list personas eligible for refresh (drives the
 *                          per-card refresh button in admin UI)
 *   POST { persona_id }  → refresh a single persona
 *   POST {}              → batch refresh all active persona wallets, with
 *                          a 300ms RPC throttle between requests
 *
 * Second real consumer of the v1.19.0 Solana foundation (after admin/nfts).
 * Uses `getBudjuTokenMint()` + `getGlitchTokenMint()` lazy PublicKey
 * helpers from solana-config.
 */

import { type NextRequest, NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  getBudjuTokenMint,
  getGlitchTokenMint,
  getServerSolanaConnection,
} from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// USDC SPL mint on Solana mainnet. Kept as a module-level PublicKey so we
// don't pay the base58 decode cost on every wallet refresh.
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// 300ms between wallet refreshes in batch mode. Keeps us well under
// Helius's free-tier rate limits even when refreshing all 100+ personas.
const BATCH_THROTTLE_MS = 300;

interface OnChainBalances {
  sol: number;
  budju: number;
  usdc: number;
  glitch: number;
  errors: string[];
}

/**
 * Pull on-chain SOL + 3 SPL token balances for one wallet. Returns null
 * if the address is malformed (caller surfaces a 400). Per-token errors
 * are accumulated into `balances.errors` rather than thrown — a missing
 * ATA (= persona never received that token) reads as 0, not an error.
 */
async function fetchOnChainBalances(walletAddress: string): Promise<OnChainBalances | null> {
  const errors: string[] = [];
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(walletAddress);
  } catch {
    return null;
  }

  const connection = getServerSolanaConnection();

  let sol = 0;
  try {
    const lamports = await connection.getBalance(pubkey);
    sol = lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    errors.push(`SOL: ${err instanceof Error ? err.message : String(err)}`);
  }

  // "Missing ATA" reads as 0 — that's the common state for new persona
  // wallets that haven't received a particular token yet. Only surface
  // unexpected RPC errors (network, auth, etc.) into the errors array.
  async function getTokenBalance(mint: PublicKey, label: string): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(mint, pubkey);
      const result = await connection.getTokenAccountBalance(ata);
      return Number(result.value.uiAmount ?? 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("could not find account") ||
        msg.includes("Invalid param") ||
        msg.includes("not found")
      ) {
        return 0;
      }
      errors.push(`${label}: ${msg}`);
      return 0;
    }
  }

  const [budju, usdc, glitch] = await Promise.all([
    getTokenBalance(getBudjuTokenMint(), "BUDJU").catch(() => 0),
    getTokenBalance(USDC_MINT, "USDC").catch(() => 0),
    getTokenBalance(getGlitchTokenMint(), "GLITCH").catch(() => 0),
  ]);

  return { sol, budju, usdc, glitch, errors };
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const personas = (await sql`
    SELECT p.id, p.username, p.display_name, p.avatar_emoji, bw.wallet_address
    FROM ai_personas p
    JOIN budju_wallets bw
      ON bw.persona_id = p.id AND bw.is_active = TRUE
    WHERE p.is_active = TRUE
    ORDER BY p.id
  `) as unknown as Array<{
    id: string;
    username: string;
    display_name: string;
    avatar_emoji: string | null;
    wallet_address: string;
  }>;

  return NextResponse.json({ total: personas.length, personas });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as { persona_id?: string };
  const targetPersonaId = body.persona_id;

  // Mode 1: single-persona refresh (used by the per-card refresh button).
  if (targetPersonaId) {
    const [wallet] = (await sql`
      SELECT bw.wallet_address, p.username
      FROM budju_wallets bw
      JOIN ai_personas p ON p.id = bw.persona_id
      WHERE bw.persona_id = ${targetPersonaId} AND bw.is_active = TRUE
      LIMIT 1
    `) as unknown as Array<{ wallet_address: string; username: string }>;

    if (!wallet) {
      return NextResponse.json(
        {
          success: false,
          persona_id: targetPersonaId,
          status: "no_wallet",
          message: "No active wallet found for this persona",
        },
        { status: 404 },
      );
    }

    const balances = await fetchOnChainBalances(wallet.wallet_address);
    if (!balances) {
      return NextResponse.json(
        {
          success: false,
          persona_id: targetPersonaId,
          status: "invalid_address",
          message: "Wallet address is not valid base58",
        },
        { status: 400 },
      );
    }

    try {
      await sql`
        UPDATE budju_wallets
        SET sol_balance = ${balances.sol},
            budju_balance = ${balances.budju},
            usdc_balance = ${balances.usdc},
            glitch_balance = ${balances.glitch},
            updated_at = NOW()
        WHERE persona_id = ${targetPersonaId} AND is_active = TRUE
      `;
    } catch (err) {
      return NextResponse.json(
        {
          success: false,
          persona_id: targetPersonaId,
          status: "db_write_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      persona_id: targetPersonaId,
      username: wallet.username,
      wallet_address: wallet.wallet_address,
      balances: {
        sol: balances.sol,
        budju: balances.budju,
        usdc: balances.usdc,
        glitch: balances.glitch,
      },
      rpc_errors: balances.errors,
    });
  }

  // Mode 2: batch refresh ALL persona wallets, throttled.
  const wallets = (await sql`
    SELECT bw.persona_id, bw.wallet_address, p.username
    FROM budju_wallets bw
    JOIN ai_personas p ON p.id = bw.persona_id
    WHERE bw.is_active = TRUE AND p.is_active = TRUE
    ORDER BY p.id
  `) as unknown as Array<{
    persona_id: string;
    wallet_address: string;
    username: string;
  }>;

  const results: Array<{
    persona_id: string;
    username: string;
    status: "ok" | "failed";
    sol?: number;
    budju?: number;
    usdc?: number;
    glitch?: number;
    error?: string;
  }> = [];

  let updated = 0;
  let failed = 0;

  for (const w of wallets) {
    const balances = await fetchOnChainBalances(w.wallet_address);
    if (!balances) {
      results.push({
        persona_id: w.persona_id,
        username: w.username,
        status: "failed",
        error: "Invalid address",
      });
      failed++;
      continue;
    }

    try {
      await sql`
        UPDATE budju_wallets
        SET sol_balance = ${balances.sol},
            budju_balance = ${balances.budju},
            usdc_balance = ${balances.usdc},
            glitch_balance = ${balances.glitch},
            updated_at = NOW()
        WHERE persona_id = ${w.persona_id} AND is_active = TRUE
      `;
      results.push({
        persona_id: w.persona_id,
        username: w.username,
        status: "ok",
        sol: balances.sol,
        budju: balances.budju,
        usdc: balances.usdc,
        glitch: balances.glitch,
      });
      updated++;
    } catch (err) {
      results.push({
        persona_id: w.persona_id,
        username: w.username,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }

    await new Promise((r) => setTimeout(r, BATCH_THROTTLE_MS));
  }

  return NextResponse.json({
    success: true,
    total: wallets.length,
    updated,
    failed,
    results,
  });
}
