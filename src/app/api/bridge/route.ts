/**
 * /api/bridge — §GLITCH snapshot → on-chain claim bridge.
 *
 * Port of legacy aiglitch/src/app/api/bridge/route.ts. Lets humans
 * claim real on-chain §GLITCH based on their balance at the time of a
 * finalized snapshot. The actual on-chain transfer is queued for an
 * external treasury service (not in this route) — this endpoint just
 * orchestrates the snapshot lookup + claim row + status updates.
 *
 * Audit verdict (2026-05-26): zero signing in this route. The
 * `TREASURY_PRIVATE_KEY` reference is read-only (gates whether a claim
 * is marked `queued` vs `pending`). PublicKey is only used to validate
 * input shape, not to sign anything. Pure DB ledger.
 *
 * Endpoints:
 *   GET ?action=status&session_id=...    — user's snapshot + claim state
 *   GET ?action=overview                  — bridge-wide stats
 *   POST { action: "claim", wallet_address }
 *                                         — submit a claim for snapshot balance
 *   POST { action: "process_claim", claim_id, tx_signature }
 *                                         — admin marks a claim completed
 *
 * Drops `ensureDbReady` per CLAUDE.md migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";
import {
  GLITCH_TOKEN_MINT_STR,
  TREASURY_WALLET_STR,
  isRealSolanaMode,
  isValidSolanaAddress,
} from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SnapshotRow {
  id: string;
  name: string;
  created_at: string;
}

interface SnapshotEntryRow {
  id: string;
  snapshot_id: string;
  holder_type: string;
  holder_id: string;
  balance: number;
  phantom_wallet: string | null;
  claim_status: string | null;
  claimed_at: string | null;
  claim_tx_hash: string | null;
}

interface BridgeClaimRow {
  id: string;
  snapshot_id: string;
  session_id: string;
  phantom_wallet: string;
  amount: number;
  status: string;
  tx_signature: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const sessionId = request.nextUrl.searchParams.get("session_id");
  const sql = getDb();

  if (action === "status" && sessionId) {
    const [latestSnapshot] = (await sql`
      SELECT id, name, created_at FROM glitch_snapshots
      WHERE status = 'finalized'
      ORDER BY created_at DESC LIMIT 1
    `) as unknown as SnapshotRow[];

    if (!latestSnapshot) {
      return NextResponse.json({
        bridge_active: false,
        message: "No snapshot available yet. All §GLITCH is real from day one.",
      });
    }

    const [entry] = (await sql`
      SELECT * FROM glitch_snapshot_entries
      WHERE snapshot_id = ${latestSnapshot.id}
        AND holder_type = 'human'
        AND holder_id = ${sessionId}
    `) as unknown as SnapshotEntryRow[];

    const [user] = (await sql`
      SELECT phantom_wallet_address, display_name FROM human_users
      WHERE session_id = ${sessionId}
    `) as unknown as Array<{ phantom_wallet_address: string | null; display_name: string }>;

    const [currentBalance] = (await sql`
      SELECT balance FROM glitch_coins WHERE session_id = ${sessionId}
    `) as unknown as Array<{ balance: number }>;

    const claims = (await sql`
      SELECT * FROM bridge_claims
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC LIMIT 1
    `) as unknown as BridgeClaimRow[];

    return NextResponse.json({
      bridge_active: true,
      snapshot: {
        id: latestSnapshot.id,
        name: latestSnapshot.name,
        taken_at: latestSnapshot.created_at,
      },
      snapshot_balance: entry ? Number(entry.balance) : 0,
      current_balance: currentBalance ? Number(currentBalance.balance) : 0,
      phantom_wallet: user?.phantom_wallet_address ?? null,
      claim_status: entry?.claim_status ?? "no_balance",
      claim:
        claims.length > 0
          ? {
              id: claims[0].id,
              status: claims[0].status,
              amount: Number(claims[0].amount),
              tx_signature: claims[0].tx_signature,
              created_at: claims[0].created_at,
              completed_at: claims[0].completed_at,
              error: claims[0].error_message,
            }
          : null,
      token_mint: GLITCH_TOKEN_MINT_STR,
      treasury_wallet: TREASURY_WALLET_STR,
      real_mode: isRealSolanaMode(),
    });
  }

  if (action === "overview") {
    const [latestSnapshot] = (await sql`
      SELECT * FROM glitch_snapshots
      WHERE status = 'finalized'
      ORDER BY created_at DESC LIMIT 1
    `) as unknown as Array<Record<string, unknown>>;

    if (!latestSnapshot) {
      return NextResponse.json({ bridge_active: false });
    }

    const [stats] = (await sql`
      SELECT
        COUNT(*) as total_entries,
        COUNT(*) FILTER (WHERE holder_type = 'human') as human_entries,
        COUNT(*) FILTER (WHERE holder_type = 'ai_persona') as ai_entries,
        COUNT(*) FILTER (WHERE phantom_wallet IS NOT NULL) as with_wallet,
        COUNT(*) FILTER (WHERE claim_status = 'claimed') as claimed,
        COUNT(*) FILTER (WHERE claim_status = 'pending') as pending,
        SUM(balance) as total_supply,
        SUM(balance) FILTER (WHERE claim_status = 'claimed') as claimed_supply
      FROM glitch_snapshot_entries
      WHERE snapshot_id = ${latestSnapshot.id as string}
    `) as unknown as Array<Record<string, number>>;

    return NextResponse.json({
      bridge_active: true,
      snapshot: latestSnapshot,
      stats: {
        total_entries: Number(stats.total_entries),
        human_entries: Number(stats.human_entries),
        ai_entries: Number(stats.ai_entries),
        with_wallet: Number(stats.with_wallet),
        claimed: Number(stats.claimed),
        pending: Number(stats.pending),
        total_supply: Number(stats.total_supply),
        claimed_supply: Number(stats.claimed_supply),
      },
    });
  }

  return NextResponse.json(
    { error: "Invalid action. Use ?action=status&session_id=... or ?action=overview" },
    { status: 400 },
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    session_id?: string;
    action?: string;
    wallet_address?: string;
    claim_id?: string;
    tx_signature?: string;
  };
  const { session_id, action } = body;

  if (!session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const sql = getDb();

  if (action === "claim") {
    const { wallet_address } = body;

    if (!wallet_address) {
      return NextResponse.json(
        { error: "Connect your Phantom wallet first, meat bag." },
        { status: 400 },
      );
    }

    // Cheap regex check first; PublicKey constructor will catch
    // anything regex misses but it's slower.
    if (!isValidSolanaAddress(wallet_address)) {
      return NextResponse.json({ error: "Invalid Solana wallet address" }, { status: 400 });
    }
    try {
      new PublicKey(wallet_address);
    } catch {
      return NextResponse.json({ error: "Invalid Solana wallet address" }, { status: 400 });
    }

    const [snapshot] = (await sql`
      SELECT id FROM glitch_snapshots
      WHERE status = 'finalized'
      ORDER BY created_at DESC LIMIT 1
    `) as unknown as Array<{ id: string }>;

    if (!snapshot) {
      return NextResponse.json(
        { error: "No snapshot available. Your §GLITCH is already real." },
        { status: 404 },
      );
    }

    const [entry] = (await sql`
      SELECT * FROM glitch_snapshot_entries
      WHERE snapshot_id = ${snapshot.id}
        AND holder_type = 'human'
        AND holder_id = ${session_id}
    `) as unknown as SnapshotEntryRow[];

    if (!entry) {
      return NextResponse.json(
        { error: "No §GLITCH balance found in snapshot for your account." },
        { status: 404 },
      );
    }

    if (entry.claim_status === "claimed") {
      return NextResponse.json({
        error: "Already claimed! Your §GLITCH tokens have been bridged.",
        already_claimed: true,
        tx_signature: entry.claim_tx_hash,
      });
    }

    const existingClaims = (await sql`
      SELECT id, status FROM bridge_claims
      WHERE snapshot_id = ${snapshot.id}
        AND session_id = ${session_id}
        AND status = 'pending'
    `) as unknown as Array<{ id: string; status: string }>;

    if (existingClaims.length > 0) {
      return NextResponse.json({
        error: "You already have a pending claim. Wait for it to process.",
        pending: true,
        claim_id: existingClaims[0].id,
      });
    }

    const amount = Number(entry.balance);
    const claimId = uuidv4();

    await sql`
      INSERT INTO bridge_claims (id, snapshot_id, session_id, phantom_wallet, amount, status, created_at)
      VALUES (${claimId}, ${snapshot.id}, ${session_id}, ${wallet_address}, ${amount}, 'pending', NOW())
    `;

    await sql`
      UPDATE glitch_snapshot_entries
      SET phantom_wallet = ${wallet_address}, claim_status = 'pending'
      WHERE snapshot_id = ${snapshot.id}
        AND holder_type = 'human'
        AND holder_id = ${session_id}
    `;

    // Mark as queued if real mode + treasury key is set; the actual transfer
    // is performed by an external treasury service (not in this route).
    if (isRealSolanaMode() && process.env.TREASURY_PRIVATE_KEY) {
      try {
        await sql`UPDATE bridge_claims SET status = 'queued' WHERE id = ${claimId}`;
        return NextResponse.json({
          success: true,
          claim_id: claimId,
          amount,
          wallet_address,
          status: "queued",
          message: `${amount.toLocaleString()} §GLITCH queued for transfer to ${wallet_address.slice(0, 8)}...`,
          note: "Real SPL tokens will be sent from the treasury wallet. This may take a few minutes.",
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        await sql`
          UPDATE bridge_claims SET status = 'failed', error_message = ${errorMsg}
          WHERE id = ${claimId}
        `;
        return NextResponse.json(
          { error: `Transfer failed: ${errorMsg}`, claim_id: claimId },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      success: true,
      claim_id: claimId,
      amount,
      wallet_address,
      status: "pending",
      message: `Claim submitted for ${amount.toLocaleString()} §GLITCH! Awaiting admin approval for on-chain transfer.`,
      note: isRealSolanaMode()
        ? "Treasury private key not configured. Admin will process manually."
        : "Real Solana mode not active. Enable NEXT_PUBLIC_SOLANA_REAL_MODE=true and set TREASURY_PRIVATE_KEY.",
    });
  }

  if (action === "process_claim") {
    const { claim_id, tx_signature } = body;
    if (!claim_id || !tx_signature) {
      return NextResponse.json({ error: "Missing claim_id or tx_signature" }, { status: 400 });
    }

    const [claim] = (await sql`
      SELECT * FROM bridge_claims WHERE id = ${claim_id}
    `) as unknown as BridgeClaimRow[];

    if (!claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    if (claim.status === "completed") {
      return NextResponse.json({ error: "Claim already processed" }, { status: 400 });
    }

    await sql`
      UPDATE bridge_claims
      SET status = 'completed', tx_signature = ${tx_signature}, completed_at = NOW()
      WHERE id = ${claim_id}
    `;

    await sql`
      UPDATE glitch_snapshot_entries
      SET claim_status = 'claimed', claimed_at = NOW(), claim_tx_hash = ${tx_signature}
      WHERE snapshot_id = ${claim.snapshot_id}
        AND holder_type = 'human'
        AND holder_id = ${claim.session_id}
    `;

    return NextResponse.json({
      success: true,
      claim_id,
      amount: Number(claim.amount),
      wallet: claim.phantom_wallet,
      tx_signature,
      message: `Claim processed! ${Number(claim.amount).toLocaleString()} §GLITCH sent to ${claim.phantom_wallet}.`,
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
