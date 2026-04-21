/**
 * Admin user management.
 *
 *   GET  — default: paginated list with batched stats (likes,
 *          comments, NFTs, coin balance). Newest-seen first, LIMIT 200.
 *   GET  ?action=detail&user_id=X — single user + full stats block
 *          (likes / comments / bookmarks / subs) + NFTs + purchases +
 *          coins + interests.
 *   GET  ?action=wallet_debug — every wallet-connected user with
 *          cross-session stats (likes/comments/bookmarks/subs/NFTs/
 *          purchases aggregated across all session_ids linked to the
 *          same Phantom wallet address).
 *   GET  ?action=recover_orphans&wallet=X — DEFERRED (returns 501).
 *          Legacy writes to minted_nfts / solana_wallets / token_balances /
 *          marketplace_purchases. Per SAFETY-RULES §Trading, wallet+NFT
 *          writes need explicit per-endpoint confirmation. Ship alongside
 *          other trading-adjacent admin utilities in a confirmed batch.
 *   PATCH — update display_name / username / bio / avatar_emoji /
 *           is_active. Username uniqueness enforced with a pre-check
 *           (409 when taken). COALESCE pattern so only provided fields
 *           overwrite.
 *   DELETE — cascade through: human_likes, human_comments, human_bookmarks,
 *            human_subscriptions, human_interests, marketplace_purchases,
 *            glitch_coins, minted_nfts, solana_wallets — then the user row
 *            itself. Best-effort per-table (fresh envs may be missing
 *            optional tables); legacy parity. Emits audit log line.
 *
 *   Stats queries are individually try/catch'd — missing tables return
 *   zero rather than 500-ing the whole response (legacy parity).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface UserRow {
  id: string;
  session_id: string;
  display_name: string | null;
  username: string | null;
  email: string | null;
  avatar_emoji: string | null;
  bio: string | null;
  auth_provider: string | null;
  phantom_wallet_address: string | null;
  is_active: boolean;
  created_at: string;
  last_seen: string | null;
}

interface CountRow { count: string | number }

async function safeRows<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

async function safeCount(fn: () => Promise<CountRow[]>): Promise<number> {
  try {
    const rows = await fn();
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const action = request.nextUrl.searchParams.get("action");
  const userId = request.nextUrl.searchParams.get("user_id");

  // ── Detail: single user + full stats ────────────────────────────
  if (action === "detail" && userId) {
    const users = (await sql`
      SELECT id, session_id, display_name, username, email, avatar_emoji, bio,
             auth_provider, phantom_wallet_address, is_active, created_at, last_seen
      FROM human_users WHERE id = ${userId}
    `) as unknown as UserRow[];

    if (users.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = users[0];
    const sid = user.session_id;

    const [likes, comments, bookmarks, subs, nfts, purchases, coins, interests] = await Promise.all([
      safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_likes WHERE session_id = ${sid}` as unknown as Promise<CountRow[]>),
      safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_comments WHERE session_id = ${sid}` as unknown as Promise<CountRow[]>),
      safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_bookmarks WHERE session_id = ${sid}` as unknown as Promise<CountRow[]>),
      safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_subscriptions WHERE session_id = ${sid}` as unknown as Promise<CountRow[]>),
      safeRows<Record<string, unknown>>(() => sql`
        SELECT id, product_name, product_emoji, mint_address, rarity, edition_number, created_at
        FROM minted_nfts
        WHERE owner_type = 'human' AND owner_id = ${sid}
        ORDER BY created_at DESC
      ` as unknown as Promise<Record<string, unknown>[]>),
      safeRows<Record<string, unknown>>(() => sql`
        SELECT product_id, product_name, product_emoji, price_paid, created_at
        FROM marketplace_purchases
        WHERE session_id = ${sid}
        ORDER BY created_at DESC
      ` as unknown as Promise<Record<string, unknown>[]>),
      safeRows<{ balance: string | number; lifetime_earned: string | number }>(() =>
        sql`SELECT balance, lifetime_earned FROM glitch_coins WHERE session_id = ${sid}` as unknown as Promise<{ balance: string | number; lifetime_earned: string | number }[]>,
      ),
      safeRows<{ interest_tag: string; weight: number }>(() =>
        sql`SELECT interest_tag, weight FROM human_interests WHERE session_id = ${sid} ORDER BY weight DESC` as unknown as Promise<{ interest_tag: string; weight: number }[]>,
      ),
    ]);

    return NextResponse.json({
      user: {
        ...user,
        stats: { likes, comments, bookmarks, subscriptions: subs },
        nfts,
        purchases,
        coins: coins.length > 0
          ? { balance: Number(coins[0].balance), lifetime_earned: Number(coins[0].lifetime_earned) }
          : { balance: 0, lifetime_earned: 0 },
        interests,
      },
    });
  }

  // ── Wallet debug: cross-session aggregation ─────────────────────
  if (action === "wallet_debug") {
    const walletUsers = (await sql`
      SELECT id, session_id, display_name, username, phantom_wallet_address, created_at, last_seen
      FROM human_users
      WHERE phantom_wallet_address IS NOT NULL AND phantom_wallet_address != ''
      ORDER BY last_seen DESC NULLS LAST
    `) as unknown as (UserRow & { phantom_wallet_address: string })[];

    const results = [];
    for (const wu of walletUsers) {
      const wallet = wu.phantom_wallet_address;
      const sid = wu.session_id;

      const allSessions = (await sql`
        SELECT id, session_id, username, created_at
        FROM human_users WHERE phantom_wallet_address = ${wallet}
      `) as unknown as { id: string; session_id: string; username: string | null; created_at: string }[];

      const allSids = allSessions.map((s) => s.session_id);

      const [likes, comments, bookmarks, subs, nfts, purchases] = await Promise.all([
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_likes WHERE session_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_comments WHERE session_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_bookmarks WHERE session_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_subscriptions WHERE session_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM minted_nfts WHERE owner_type = 'human' AND owner_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
        safeCount(() => sql`SELECT COUNT(*)::int AS count FROM marketplace_purchases WHERE session_id = ANY(${allSids})` as unknown as Promise<CountRow[]>),
      ]);

      const currentSessionLikes = await safeCount(() =>
        sql`SELECT COUNT(*)::int AS count FROM human_likes WHERE session_id = ${sid}` as unknown as Promise<CountRow[]>,
      );

      results.push({
        user: {
          id: wu.id,
          username: wu.username,
          display_name: wu.display_name,
          wallet,
          created_at: wu.created_at,
          last_seen: wu.last_seen,
        },
        currentSessionId: sid,
        allSessionIds: allSids,
        sessionCount: allSids.length,
        allSessions,
        statsAcrossAllSessions: {
          likes,
          comments,
          bookmarks,
          subscriptions: subs,
          nfts,
          purchases,
        },
        currentSessionLikes,
      });
    }

    return NextResponse.json({ walletUsers: results, totalWalletUsers: results.length });
  }

  // ── Recover orphans: deferred (trading-adjacent writes) ──────────
  if (action === "recover_orphans") {
    return NextResponse.json(
      {
        error: "Not implemented in aiglitch-api yet",
        reason: "Writes to minted_nfts / solana_wallets / token_balances / marketplace_purchases require explicit per-endpoint confirmation per SAFETY-RULES §Trading. Deferred to a trading-adjacent admin batch.",
      },
      { status: 501 },
    );
  }

  // ── Default: paginated list with batched stats ──────────────────
  const users = (await sql`
    SELECT
      hu.id, hu.session_id, hu.display_name, hu.username, hu.email,
      hu.avatar_emoji, hu.bio, hu.auth_provider, hu.phantom_wallet_address,
      hu.is_active, hu.created_at, hu.last_seen
    FROM human_users hu
    WHERE hu.username IS NOT NULL
    ORDER BY hu.last_seen DESC NULLS LAST
    LIMIT 200
  `) as unknown as UserRow[];

  const sessionIds = users.map((u) => u.session_id);
  const likeCounts: Record<string, number> = {};
  const commentCounts: Record<string, number> = {};
  const nftCounts: Record<string, number> = {};
  const coinBalances: Record<string, number> = {};

  if (sessionIds.length > 0) {
    const [likeRows, commentRows, nftRows, coinRows] = await Promise.all([
      safeRows<{ session_id: string; count: string | number }>(() =>
        sql`SELECT session_id, COUNT(*)::int AS count FROM human_likes WHERE session_id = ANY(${sessionIds}) GROUP BY session_id` as unknown as Promise<{ session_id: string; count: string | number }[]>,
      ),
      safeRows<{ session_id: string; count: string | number }>(() =>
        sql`SELECT session_id, COUNT(*)::int AS count FROM human_comments WHERE session_id = ANY(${sessionIds}) GROUP BY session_id` as unknown as Promise<{ session_id: string; count: string | number }[]>,
      ),
      safeRows<{ owner_id: string; count: string | number }>(() =>
        sql`SELECT owner_id, COUNT(*)::int AS count FROM minted_nfts WHERE owner_type = 'human' AND owner_id = ANY(${sessionIds}) GROUP BY owner_id` as unknown as Promise<{ owner_id: string; count: string | number }[]>,
      ),
      safeRows<{ session_id: string; balance: string | number }>(() =>
        sql`SELECT session_id, balance FROM glitch_coins WHERE session_id = ANY(${sessionIds})` as unknown as Promise<{ session_id: string; balance: string | number }[]>,
      ),
    ]);

    for (const r of likeRows) likeCounts[r.session_id] = Number(r.count);
    for (const r of commentRows) commentCounts[r.session_id] = Number(r.count);
    for (const r of nftRows) nftCounts[r.owner_id] = Number(r.count);
    for (const r of coinRows) coinBalances[r.session_id] = Number(r.balance);
  }

  const usersWithStats = users.map((u) => ({
    ...u,
    likes:        likeCounts[u.session_id]    ?? 0,
    comments:     commentCounts[u.session_id] ?? 0,
    nfts:         nftCounts[u.session_id]     ?? 0,
    coin_balance: coinBalances[u.session_id]  ?? 0,
  }));

  return NextResponse.json({ users: usersWithStats });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    user_id?: string;
    display_name?: string;
    username?: string;
    bio?: string;
    avatar_emoji?: string;
    is_active?: boolean;
  };
  const { user_id, display_name, username, bio, avatar_emoji, is_active } = body;

  if (!user_id) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const existing = (await sql`
    SELECT id, username FROM human_users WHERE id = ${user_id}
  `) as unknown as { id: string; username: string | null }[];

  if (existing.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (username && username !== existing[0].username) {
    const taken = (await sql`
      SELECT id FROM human_users WHERE username = ${username} AND id != ${user_id}
    `) as unknown as { id: string }[];
    if (taken.length > 0) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 });
    }
  }

  await sql`
    UPDATE human_users SET
      display_name = COALESCE(${display_name ?? null}, display_name),
      username     = COALESCE(${username ?? null},     username),
      bio          = COALESCE(${bio ?? null},          bio),
      avatar_emoji = COALESCE(${avatar_emoji ?? null}, avatar_emoji),
      is_active    = COALESCE(${is_active ?? null},    is_active),
      updated_at   = NOW()
    WHERE id = ${user_id}
  `;

  return NextResponse.json({
    success: true,
    message: `User ${existing[0].username ?? user_id} updated`,
  });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as { user_id?: string };
  const { user_id } = body;

  if (!user_id) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const existing = (await sql`
    SELECT id, session_id, username FROM human_users WHERE id = ${user_id}
  `) as unknown as { id: string; session_id: string; username: string | null }[];

  if (existing.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const sid = existing[0].session_id;
  const uname = existing[0].username;

  console.log(`[admin/users] DELETE user_id=${user_id} session_id=${sid} username=${uname ?? "—"} at=${new Date().toISOString()}`);

  // Cascade order preserved from legacy. Non-atomic by design —
  // some targets (marketplace_purchases, glitch_coins, minted_nfts,
  // solana_wallets) are optional tables on fresh envs.
  await sql`DELETE FROM human_likes         WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM human_comments      WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM human_bookmarks     WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM human_subscriptions WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM human_interests     WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM marketplace_purchases WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM glitch_coins         WHERE session_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM minted_nfts          WHERE owner_type = 'human' AND owner_id = ${sid}`.catch(() => {});
  await sql`DELETE FROM solana_wallets       WHERE owner_type = 'human' AND owner_id = ${sid}`.catch(() => {});

  await sql`DELETE FROM human_users WHERE id = ${user_id}`;

  return NextResponse.json({
    success: true,
    message: `User @${uname ?? user_id} and all associated data deleted`,
  });
}
