/**
 * §GLITCH balance snapshot API.
 *
 * Captures point-in-time balances (human + AI) from `glitch_coins` and
 * `ai_persona_coins` into `glitch_snapshots` + `glitch_snapshot_entries`
 * so the real on-chain airdrop can distribute exactly what people had
 * at that moment. The manifest action is what the off-chain distributor
 * reads to actually send tokens.
 *
 * Actions (all via `?action=` on GET, or `{ action }` body on POST):
 *
 *   GET  action=list | default   — latest 20 snapshots (admin)
 *   GET  action=detail           — one snapshot + all entries (admin)
 *   GET  action=manifest         — airdrop distribution data (admin)
 *   GET  action=user_status      — PUBLIC — caller's own claim status.
 *                                  Takes session_id from the query and
 *                                  returns only that row.
 *
 *   POST action=take_snapshot    — finalise a new snapshot (admin)
 *
 * Auth model differs from legacy: admin auth is REQUIRED for everything
 * except `user_status`. Legacy had no auth at all on this route, which
 * left take_snapshot and manifest open — we close that here.
 *
 * Mint address is the production token (5hfH...S8fT). Hard-coded on
 * purpose — if that changes it's a ceremony, not a hotfix.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GLITCH_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";

interface SnapshotRow {
  id: string;
  name: string;
  total_holders: number;
  total_supply_captured: number;
  status: string;
  created_at: string;
  finalized_at: string | null;
}

interface EntryRow {
  id: string;
  snapshot_id: string;
  holder_type: "human" | "ai_persona";
  holder_id: string;
  display_name: string;
  phantom_wallet: string | null;
  balance: number;
  lifetime_earned: number;
  claim_status: string;
}

// ── GET: multi-action read ─────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action") ?? "list";

  // user_status is caller-scoped, not admin-only (legacy behaviour)
  if (action === "user_status") {
    return handleUserStatus(request);
  }

  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  switch (action) {
    case "list":     return handleList();
    case "detail":   return handleDetail(request);
    case "manifest": return handleManifest(request);
    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
}

async function handleList() {
  const sql = getDb();
  const snapshots = (await sql`
    SELECT id, name, total_holders, total_supply_captured, status, created_at, finalized_at
    FROM glitch_snapshots
    ORDER BY created_at DESC
    LIMIT 20
  `) as unknown as SnapshotRow[];
  return NextResponse.json({ snapshots });
}

async function handleDetail(request: NextRequest) {
  const snapshotId = request.nextUrl.searchParams.get("snapshot_id");
  if (!snapshotId) {
    return NextResponse.json({ error: "Missing snapshot_id" }, { status: 400 });
  }

  const sql = getDb();
  const [snapshot] = (await sql`
    SELECT * FROM glitch_snapshots WHERE id = ${snapshotId}
  `) as unknown as [SnapshotRow | undefined];
  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }

  const entries = (await sql`
    SELECT * FROM glitch_snapshot_entries
    WHERE snapshot_id = ${snapshotId}
    ORDER BY balance DESC
  `) as unknown as EntryRow[];

  const humans = entries.filter((e) => e.holder_type === "human");
  const ai = entries.filter((e) => e.holder_type === "ai_persona");
  const withWallet = humans.filter((e) => e.phantom_wallet);
  const claimed = entries.filter((e) => e.claim_status === "claimed");
  const totalGlitch = entries.reduce((s, e) => s + Number(e.balance), 0);

  return NextResponse.json({
    snapshot,
    entries,
    summary: {
      total_holders:       entries.length,
      human_holders:       humans.length,
      ai_holders:          ai.length,
      with_phantom_wallet: withWallet.length,
      without_wallet:      humans.length - withWallet.length,
      total_glitch:        totalGlitch,
      total_claimed:       claimed.length,
      total_unclaimed:     entries.length - claimed.length,
    },
  });
}

async function handleManifest(request: NextRequest) {
  const snapshotId = request.nextUrl.searchParams.get("snapshot_id");
  if (!snapshotId) {
    return NextResponse.json({ error: "Missing snapshot_id" }, { status: 400 });
  }

  const sql = getDb();
  const entries = (await sql`
    SELECT holder_type, holder_id, display_name, phantom_wallet, balance
    FROM glitch_snapshot_entries
    WHERE snapshot_id = ${snapshotId} AND balance > 0
    ORDER BY balance DESC
  `) as unknown as Pick<EntryRow, "holder_type" | "holder_id" | "display_name" | "phantom_wallet" | "balance">[];

  const ready = entries
    .filter((e) => e.phantom_wallet)
    .map((e) => ({
      wallet:       e.phantom_wallet,
      amount:       Number(e.balance),
      holder_type:  e.holder_type,
      display_name: e.display_name,
    }));

  const pending = entries
    .filter((e) => !e.phantom_wallet)
    .map((e) => ({
      holder_type:  e.holder_type,
      holder_id:    e.holder_id,
      display_name: e.display_name,
      amount:       Number(e.balance),
    }));

  return NextResponse.json({
    snapshot_id:      snapshotId,
    token:            "§GLITCH",
    mint:             GLITCH_MINT,
    ready_to_airdrop: ready,
    pending_wallet:   pending,
    totals: {
      ready_amount:   ready.reduce((s, e) => s + e.amount, 0),
      pending_amount: pending.reduce((s, e) => s + e.amount, 0),
      total_amount:   entries.reduce((s, e) => s + Number(e.balance), 0),
    },
  });
}

async function handleUserStatus(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const sql = getDb();
  const [latest] = (await sql`
    SELECT id, name, created_at FROM glitch_snapshots
    WHERE status = 'finalized'
    ORDER BY created_at DESC LIMIT 1
  `) as unknown as [{ id: string; name: string; created_at: string } | undefined];

  if (!latest) {
    return NextResponse.json({ has_snapshot: false, message: "No snapshot taken yet" });
  }

  const [entry] = (await sql`
    SELECT * FROM glitch_snapshot_entries
    WHERE snapshot_id = ${latest.id}
      AND holder_type = 'human'
      AND holder_id = ${sessionId}
  `) as unknown as [EntryRow | undefined];

  if (!entry) {
    return NextResponse.json({
      has_snapshot:  true,
      snapshot_id:   latest.id,
      snapshot_name: latest.name,
      has_balance:   false,
      message:       "No §GLITCH balance at time of snapshot",
    });
  }

  const claims = (await sql`
    SELECT * FROM bridge_claims
    WHERE snapshot_id = ${latest.id} AND session_id = ${sessionId}
    ORDER BY created_at DESC LIMIT 1
  `) as unknown as {
    status: string;
    tx_signature: string | null;
    created_at: string;
    completed_at: string | null;
  }[];

  return NextResponse.json({
    has_snapshot:   true,
    snapshot_id:    latest.id,
    snapshot_name:  latest.name,
    has_balance:    true,
    balance:        Number(entry.balance),
    lifetime_earned: Number(entry.lifetime_earned),
    claim_status:   entry.claim_status,
    phantom_wallet: entry.phantom_wallet,
    claim: claims[0]
      ? {
          status:       claims[0].status,
          tx_signature: claims[0].tx_signature,
          created_at:   claims[0].created_at,
          completed_at: claims[0].completed_at,
        }
      : null,
  });
}

// ── POST: take a new snapshot ──────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    name?: string;
  };

  if (body.action !== "take_snapshot") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const sql = getDb();
  const snapshotId = randomUUID();
  const name = body.name || `Snapshot ${new Date().toISOString().split("T")[0]}`;

  // Snapshot both balance sources in one go — small enough datasets we
  // don't need streaming / pagination.
  const humans = (await sql`
    SELECT gc.session_id, gc.balance, gc.lifetime_earned,
           hu.display_name, hu.username, hu.phantom_wallet_address
    FROM glitch_coins gc
    LEFT JOIN human_users hu ON gc.session_id = hu.session_id
    WHERE gc.balance > 0
  `) as unknown as {
    session_id: string;
    balance: number;
    lifetime_earned: number;
    display_name: string | null;
    username: string | null;
    phantom_wallet_address: string | null;
  }[];

  const ai = (await sql`
    SELECT apc.persona_id, apc.balance, apc.lifetime_earned,
           ap.display_name, ap.username
    FROM ai_persona_coins apc
    LEFT JOIN ai_personas ap ON apc.persona_id = ap.id
    WHERE apc.balance > 0
  `) as unknown as {
    persona_id: string;
    balance: number;
    lifetime_earned: number;
    display_name: string | null;
    username: string | null;
  }[];

  let totalSupply = 0;
  for (const row of humans) {
    const balance = Number(row.balance);
    totalSupply += balance;
    await sql`
      INSERT INTO glitch_snapshot_entries
        (id, snapshot_id, holder_type, holder_id, display_name, phantom_wallet, balance, lifetime_earned)
      VALUES
        (${randomUUID()}, ${snapshotId}, 'human', ${row.session_id},
         ${row.display_name || row.username || "Meat Bag"},
         ${row.phantom_wallet_address ?? null},
         ${balance}, ${Number(row.lifetime_earned)})
    `;
  }
  for (const row of ai) {
    const balance = Number(row.balance);
    totalSupply += balance;
    await sql`
      INSERT INTO glitch_snapshot_entries
        (id, snapshot_id, holder_type, holder_id, display_name, phantom_wallet, balance, lifetime_earned)
      VALUES
        (${randomUUID()}, ${snapshotId}, 'ai_persona', ${row.persona_id},
         ${row.display_name || row.username || "AI Persona"},
         NULL,
         ${balance}, ${Number(row.lifetime_earned)})
    `;
  }

  const entryCount = humans.length + ai.length;
  await sql`
    INSERT INTO glitch_snapshots
      (id, name, total_holders, total_supply_captured, status, created_at, finalized_at)
    VALUES
      (${snapshotId}, ${name}, ${entryCount}, ${totalSupply}, 'finalized', NOW(), NOW())
  `;

  return NextResponse.json({
    success:               true,
    snapshot_id:           snapshotId,
    name,
    total_holders:         entryCount,
    human_holders:         humans.length,
    ai_holders:            ai.length,
    total_supply_captured: totalSupply,
    status:                "finalized",
    message:               `Snapshot taken — ${entryCount} holders, ${totalSupply.toLocaleString()} §GLITCH captured.`,
  });
}
