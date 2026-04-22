/**
 * Meatbag (human user) auth + session management.
 *
 * Single POST endpoint with 11 actions:
 *   signup / login / profile / update / anonymous_signup /
 *   wallet_login / link_wallet / unlink_wallet / get_wallet /
 *   merge_accounts / signout
 *
 * All DB-only; no external services, no Solana RPC. `wallet_login`
 * touches `phantom_wallet_address` but only as a string column —
 * actual signature verification lives in `/api/auth/sign-tx` +
 * `/api/auth/wallet-qr`.
 *
 * **Migration safety rule #2 from CLAUDE.md**: session merge
 * direction is FROM the wallet account's old session_id TO the
 * browser's new session_id. Preserved verbatim — the data-
 * migration `UPDATE ... SET session_id = {new}` lines + the
 * `NOT IN` subqueries that skip unique-constraint conflicts are
 * copy-paste from legacy.
 *
 * Every inner catch is silent — old data tables may not exist on
 * every environment (e.g. `token_balances`, `community_event_votes`)
 * and a failing migration for one table should not abort the merge.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const salted = `aiglitch_${hash}_${str.length}`;
  let hash2 = 0;
  for (let i = 0; i < salted.length; i++) {
    hash2 = ((hash2 << 5) - hash2 + salted.charCodeAt(i)) | 0;
  }
  return `${hash.toString(36)}_${hash2.toString(36)}`;
}

type Sql = ReturnType<typeof getDb>;

async function migrateSessionData(
  sql: Sql,
  oldSid: string,
  newSid: string,
): Promise<string[]> {
  const migrated: string[] = [];
  const s = newSid;
  const o = oldSid;
  try {
    await sql`UPDATE human_likes SET session_id = ${s} WHERE session_id = ${o} AND post_id NOT IN (SELECT post_id FROM human_likes WHERE session_id = ${s})`;
    migrated.push("likes");
  } catch {
    // table may not exist
  }
  try {
    await sql`UPDATE human_comments SET session_id = ${s} WHERE session_id = ${o}`;
    migrated.push("comments");
  } catch { /* ok */ }
  try {
    await sql`UPDATE human_bookmarks SET session_id = ${s} WHERE session_id = ${o} AND post_id NOT IN (SELECT post_id FROM human_bookmarks WHERE session_id = ${s})`;
    migrated.push("bookmarks");
  } catch { /* ok */ }
  try {
    await sql`UPDATE human_subscriptions SET session_id = ${s} WHERE session_id = ${o} AND persona_id NOT IN (SELECT persona_id FROM human_subscriptions WHERE session_id = ${s})`;
    migrated.push("subs");
  } catch { /* ok */ }
  try {
    await sql`UPDATE minted_nfts SET owner_id = ${s} WHERE owner_type = 'human' AND owner_id = ${o}`;
    migrated.push("nfts");
  } catch { /* ok */ }
  try {
    await sql`UPDATE marketplace_purchases SET session_id = ${s} WHERE session_id = ${o} AND product_id NOT IN (SELECT product_id FROM marketplace_purchases WHERE session_id = ${s})`;
    migrated.push("purchases");
  } catch { /* ok */ }
  try {
    await sql`UPDATE glitch_coins SET session_id = ${s} WHERE session_id = ${o}`;
    migrated.push("coins");
  } catch { /* ok */ }
  try {
    await sql`UPDATE solana_wallets SET owner_id = ${s} WHERE owner_type = 'human' AND owner_id = ${o}`;
    migrated.push("wallets");
  } catch { /* ok */ }
  try {
    await sql`UPDATE token_balances SET owner_id = ${s} WHERE owner_type = 'human' AND owner_id = ${o}`;
    migrated.push("tokens");
  } catch { /* ok */ }
  try {
    await sql`UPDATE community_event_votes SET session_id = ${s} WHERE session_id = ${o}`;
    migrated.push("votes");
  } catch { /* ok */ }
  return migrated;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action as string | undefined;
    const session_id = body.session_id as string | undefined;
    const sql = getDb();

    // ── signup ──
    if (action === "signup") {
      const { username, display_name, password, avatar_emoji } = body as {
        username?: string;
        display_name?: string;
        password?: string;
        avatar_emoji?: string;
      };
      if (!username || !password || !session_id) {
        return NextResponse.json(
          { error: "Username, password, and session required" },
          { status: 400 },
        );
      }
      const cleanUsername = username
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 20);
      if (cleanUsername.length < 3) {
        return NextResponse.json(
          {
            error: "Username must be at least 3 characters (letters, numbers, underscore)",
          },
          { status: 400 },
        );
      }
      const existing = (await sql`
        SELECT id FROM human_users WHERE username = ${cleanUsername}
      `) as unknown as { id: string }[];
      if (existing.length > 0) {
        return NextResponse.json({ error: "Username already taken" }, { status: 409 });
      }
      const passwordHash = simpleHash(password);
      const name = (display_name ?? cleanUsername).trim().slice(0, 30);
      const emoji = (avatar_emoji ?? "🧑").slice(0, 4);
      await sql`
        INSERT INTO human_users (id, session_id, display_name, username, password_hash, avatar_emoji, last_seen)
        VALUES (${randomUUID()}, ${session_id}, ${name}, ${cleanUsername}, ${passwordHash}, ${emoji}, NOW())
        ON CONFLICT (session_id) DO UPDATE SET
          display_name = ${name},
          username = ${cleanUsername},
          password_hash = ${passwordHash},
          avatar_emoji = ${emoji},
          last_seen = NOW()
      `;
      return NextResponse.json({
        success: true,
        user: {
          username: cleanUsername,
          display_name: name,
          avatar_emoji: emoji,
          session_id,
        },
      });
    }

    // ── login ──
    if (action === "login") {
      const { username, password } = body as {
        username?: string;
        password?: string;
      };
      if (!username || !password) {
        return NextResponse.json(
          { error: "Username and password required" },
          { status: 400 },
        );
      }
      const cleanUsername = username.trim().toLowerCase();
      const passwordHash = simpleHash(password);
      const users = (await sql`
        SELECT id, session_id, display_name, username, avatar_emoji, bio
        FROM human_users
        WHERE username = ${cleanUsername} AND password_hash = ${passwordHash}
      `) as unknown as {
        id: string;
        session_id: string;
        display_name: string;
        username: string;
        avatar_emoji: string;
        bio: string | null;
      }[];
      if (users.length === 0) {
        return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
      }
      const user = users[0]!;
      if (session_id && session_id !== user.session_id) {
        const oldSid = user.session_id;
        await sql`
          UPDATE human_users SET session_id = ${session_id}, last_seen = NOW() WHERE id = ${user.id}
        `;
        await migrateSessionData(sql, oldSid, session_id);
      }
      return NextResponse.json({
        success: true,
        user: {
          username: user.username,
          display_name: user.display_name,
          avatar_emoji: user.avatar_emoji,
          bio: user.bio ?? "",
          session_id: session_id ?? user.session_id,
        },
      });
    }

    // ── profile ──
    if (action === "profile") {
      if (!session_id) {
        return NextResponse.json({ error: "Session required" }, { status: 400 });
      }
      const users = (await sql`
        SELECT id, display_name, username, avatar_emoji, avatar_url, bio, created_at, phantom_wallet_address
        FROM human_users
        WHERE session_id = ${session_id} AND username IS NOT NULL
      `) as unknown as {
        id: string;
        display_name: string;
        username: string;
        avatar_emoji: string;
        avatar_url: string | null;
        bio: string | null;
        created_at: string;
        phantom_wallet_address: string | null;
      }[];
      if (users.length === 0) return NextResponse.json({ user: null });
      const user = users[0]!;

      const walletAddr = user.phantom_wallet_address;
      let likes = 0;
      let comments = 0;
      let bookmarks = 0;
      let subscriptions = 0;
      try {
        let sessionIds: string[] = [session_id];
        if (walletAddr) {
          try {
            const walletSessions = (await sql`
              SELECT DISTINCT session_id FROM human_users WHERE phantom_wallet_address = ${walletAddr}
            `) as unknown as { session_id: string }[];
            sessionIds = walletSessions.map((r) => r.session_id);
            if (!sessionIds.includes(session_id)) sessionIds.push(session_id);
          } catch { /* use single-session fallback */ }
        }
        const [likeRes, commentRes, bookmarkRes, subRes] = await Promise.all([
          sql`SELECT COUNT(*) as count FROM human_likes WHERE session_id = ANY(${sessionIds})`.catch(() => [{ count: 0 }]),
          sql`SELECT COUNT(*) as count FROM human_comments WHERE session_id = ANY(${sessionIds})`.catch(() => [{ count: 0 }]),
          sql`SELECT COUNT(*) as count FROM human_bookmarks WHERE session_id = ANY(${sessionIds})`.catch(() => [{ count: 0 }]),
          sql`SELECT COUNT(*) as count FROM human_subscriptions WHERE session_id = ANY(${sessionIds})`.catch(() => [{ count: 0 }]),
        ]);
        likes = Number((likeRes as unknown as { count: number }[])[0]?.count ?? 0);
        comments = Number((commentRes as unknown as { count: number }[])[0]?.count ?? 0);
        bookmarks = Number((bookmarkRes as unknown as { count: number }[])[0]?.count ?? 0);
        subscriptions = Number((subRes as unknown as { count: number }[])[0]?.count ?? 0);
      } catch { /* stats fetch failed, return zeros */ }

      return NextResponse.json({
        user: { ...user, stats: { likes, comments, bookmarks, subscriptions } },
      });
    }

    // ── update ──
    if (action === "update") {
      const { display_name, avatar_emoji, avatar_url, bio, username } = body as {
        display_name?: string;
        avatar_emoji?: string;
        avatar_url?: string | null;
        bio?: string;
        username?: string;
      };
      if (!session_id) {
        return NextResponse.json({ error: "Session required" }, { status: 400 });
      }
      if (username) {
        const normalizedUsername = String(username).trim().toLowerCase();
        if (!/^[a-z0-9_]{3,24}$/.test(normalizedUsername)) {
          return NextResponse.json(
            { error: "Username must be 3-24 chars, lowercase letters/numbers/underscore only" },
            { status: 400 },
          );
        }
        const personaClashRows = (await sql`
          SELECT 1 FROM ai_personas WHERE LOWER(username) = ${normalizedUsername} LIMIT 1
        `) as unknown as unknown[];
        if (personaClashRows.length > 0) {
          return NextResponse.json(
            { error: `Username "${normalizedUsername}" is already taken by an AI persona` },
            { status: 409 },
          );
        }
        const meatbagClashRows = (await sql`
          SELECT 1 FROM human_users
          WHERE LOWER(username) = ${normalizedUsername}
            AND session_id != ${session_id}
          LIMIT 1
        `) as unknown as unknown[];
        if (meatbagClashRows.length > 0) {
          return NextResponse.json(
            { error: `Username "${normalizedUsername}" is already taken` },
            { status: 409 },
          );
        }
      }
      const normalizedUsername = username
        ? String(username).trim().toLowerCase()
        : null;
      await sql`
        UPDATE human_users SET
          display_name = COALESCE(${display_name ?? null}, display_name),
          avatar_emoji = COALESCE(${avatar_emoji ?? null}, avatar_emoji),
          avatar_url = COALESCE(${avatar_url ?? null}, avatar_url),
          bio = COALESCE(${bio !== undefined ? bio : null}, bio),
          username = COALESCE(${normalizedUsername}, username),
          last_seen = NOW()
        WHERE session_id = ${session_id}
      `;
      return NextResponse.json({ success: true });
    }

    // ── anonymous_signup ──
    if (action === "anonymous_signup") {
      if (!session_id) {
        return NextResponse.json({ error: "Session required" }, { status: 400 });
      }
      const anonId = Math.floor(Math.random() * 99999);
      const username = `meatbag_${anonId}`;
      const name =
        (body.display_name as string | undefined)?.trim().slice(0, 30) ??
        "Anonymous Meat Bag";
      const emoji =
        (body.avatar_emoji as string | undefined)?.slice(0, 4) ?? "🧑";
      await sql`
        INSERT INTO human_users (id, session_id, display_name, username, avatar_emoji, last_seen)
        VALUES (${randomUUID()}, ${session_id}, ${name}, ${username}, ${emoji}, NOW())
        ON CONFLICT (session_id) DO UPDATE SET
          display_name = ${name},
          username = COALESCE(human_users.username, ${username}),
          avatar_emoji = ${emoji},
          last_seen = NOW()
      `;
      return NextResponse.json({
        success: true,
        user: { username, display_name: name, avatar_emoji: emoji, session_id },
      });
    }

    // ── wallet_login ──
    if (action === "wallet_login") {
      const wallet_address = body.wallet_address as string | undefined;
      if (!wallet_address) {
        return NextResponse.json(
          { error: "Wallet address required" },
          { status: 400 },
        );
      }

      let users: {
        id: string;
        session_id: string;
        display_name: string;
        username: string;
        avatar_emoji: string;
        bio: string | null;
        phantom_wallet_address: string | null;
      }[];
      try {
        users = (await sql`
          SELECT id, session_id, display_name, username, avatar_emoji, bio, phantom_wallet_address
          FROM human_users
          WHERE phantom_wallet_address = ${wallet_address} AND username IS NOT NULL
        `) as unknown as typeof users;
      } catch (err) {
        return NextResponse.json(
          {
            error: "Database query failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          { status: 500 },
        );
      }

      if (users.length > 0) {
        const user = users[0]!;
        const newSessionId = session_id ?? user.session_id;
        if (session_id && session_id !== user.session_id) {
          const oldSid = user.session_id;
          try {
            // Delete any stub user row for the browser's session_id.
            await sql`DELETE FROM human_users WHERE session_id = ${session_id} AND id != ${user.id}`;
            // Migrate the wallet account's session_id to the browser's.
            await sql`
              UPDATE human_users SET session_id = ${session_id}, last_seen = NOW() WHERE id = ${user.id}
            `;
            await migrateSessionData(sql, oldSid, session_id);
          } catch (mergeErr) {
            console.error("[wallet_login] Session merge failed:", mergeErr);
            return NextResponse.json({
              success: true,
              found_existing: true,
              user: {
                username: user.username,
                display_name: user.display_name,
                avatar_emoji: user.avatar_emoji,
                bio: user.bio ?? "",
                session_id: user.session_id,
                phantom_wallet_address: user.phantom_wallet_address,
              },
            });
          }
        } else {
          await sql`UPDATE human_users SET last_seen = NOW() WHERE id = ${user.id}`;
        }

        // Orphan recovery — find NFTs purchased under sessions not yet
        // linked to this wallet, then migrate their data in.
        try {
          const orphanedSessions = (await sql`
            SELECT DISTINCT mn.owner_id AS orphan_sid
            FROM blockchain_transactions bt
            JOIN minted_nfts mn ON mn.mint_tx_hash = bt.tx_hash AND mn.owner_type = 'human'
            WHERE bt.from_address = ${wallet_address}
              AND mn.owner_id != ${newSessionId}
          `) as unknown as { orphan_sid: string }[];
          if (orphanedSessions.length > 0) {
            for (const row of orphanedSessions) {
              await migrateSessionData(sql, row.orphan_sid, newSessionId);
              try {
                await sql`UPDATE human_users SET phantom_wallet_address = ${wallet_address} WHERE session_id = ${row.orphan_sid} AND phantom_wallet_address IS NULL`;
              } catch { /* ok */ }
            }
          }
        } catch { /* orphan recovery non-fatal */ }

        return NextResponse.json({
          success: true,
          found_existing: true,
          user: {
            username: user.username,
            display_name: user.display_name,
            avatar_emoji: user.avatar_emoji,
            bio: user.bio ?? "",
            session_id: newSessionId,
            phantom_wallet_address: user.phantom_wallet_address,
          },
        });
      }

      // No existing user with this wallet — link or create
      const newSessionId = session_id ?? randomUUID();
      const shortAddr = wallet_address.slice(0, 6);

      try {
        const updated = (await sql`
          UPDATE human_users
          SET phantom_wallet_address = ${wallet_address},
              auth_provider = COALESCE(auth_provider, 'wallet'),
              last_seen = NOW()
          WHERE session_id = ${newSessionId}
          RETURNING id, username, display_name, avatar_emoji
        `) as unknown as {
          id: string;
          username: string;
          display_name: string;
          avatar_emoji: string;
        }[];

        if (updated.length > 0) {
          const user = updated[0]!;
          return NextResponse.json({
            success: true,
            found_existing: true,
            user: {
              username: user.username,
              display_name: user.display_name,
              avatar_emoji: user.avatar_emoji,
              session_id: newSessionId,
              phantom_wallet_address: wallet_address,
            },
          });
        }

        const username = `wallet_${shortAddr.toLowerCase()}`;
        const taken = (await sql`
          SELECT id FROM human_users WHERE username = ${username}
        `) as unknown as { id: string }[];
        const finalUsername =
          taken.length > 0
            ? `${username}_${Math.floor(Math.random() * 999)}`
            : username;

        await sql`
          INSERT INTO human_users (id, session_id, display_name, username, avatar_emoji, phantom_wallet_address, auth_provider, last_seen)
          VALUES (${randomUUID()}, ${newSessionId}, ${`Wallet ${shortAddr}...`}, ${finalUsername}, '👛', ${wallet_address}, 'wallet', NOW())
        `;

        return NextResponse.json({
          success: true,
          found_existing: false,
          user: {
            username: finalUsername,
            display_name: `Wallet ${shortAddr}...`,
            avatar_emoji: "👛",
            session_id: newSessionId,
            phantom_wallet_address: wallet_address,
          },
        });
      } catch (err) {
        return NextResponse.json(
          {
            error: "Failed to create wallet account",
            detail: err instanceof Error ? err.message : String(err),
          },
          { status: 500 },
        );
      }
    }

    // ── link_wallet ──
    if (action === "link_wallet") {
      const wallet_address = body.wallet_address as string | undefined;
      if (!session_id || !wallet_address) {
        return NextResponse.json(
          { error: "Session and wallet address required" },
          { status: 400 },
        );
      }
      const existing = (await sql`
        SELECT session_id, username FROM human_users
        WHERE phantom_wallet_address = ${wallet_address} AND session_id != ${session_id}
      `) as unknown as { session_id: string; username: string | null }[];
      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: `This wallet is already linked to @${existing[0]!.username ?? "another account"}.`,
          },
          { status: 409 },
        );
      }
      await sql`
        UPDATE human_users
        SET phantom_wallet_address = ${wallet_address}, updated_at = NOW()
        WHERE session_id = ${session_id}
      `;
      return NextResponse.json({
        success: true,
        wallet_address,
        message:
          "Wallet linked to your profile! You can now sign in via wallet in Phantom.",
      });
    }

    // ── unlink_wallet ──
    if (action === "unlink_wallet") {
      if (!session_id) {
        return NextResponse.json({ error: "Session required" }, { status: 400 });
      }
      await sql`
        UPDATE human_users
        SET phantom_wallet_address = NULL, updated_at = NOW()
        WHERE session_id = ${session_id}
      `;
      return NextResponse.json({
        success: true,
        message: "Wallet unlinked from your profile.",
      });
    }

    // ── get_wallet ──
    if (action === "get_wallet") {
      if (!session_id) {
        return NextResponse.json({ error: "Session required" }, { status: 400 });
      }
      const users = (await sql`
        SELECT phantom_wallet_address FROM human_users WHERE session_id = ${session_id}
      `) as unknown as { phantom_wallet_address: string | null }[];
      return NextResponse.json({
        wallet_address:
          users.length > 0 ? (users[0]!.phantom_wallet_address ?? null) : null,
      });
    }

    // ── merge_accounts ──
    if (action === "merge_accounts") {
      const old_usernames = body.old_usernames as string[] | undefined;
      if (
        !session_id ||
        !Array.isArray(old_usernames) ||
        old_usernames.length === 0
      ) {
        return NextResponse.json(
          { error: "Session and old_usernames array required" },
          { status: 400 },
        );
      }
      const currentUser = (await sql`
        SELECT id, username FROM human_users WHERE session_id = ${session_id} AND username IS NOT NULL
      `) as unknown as { id: string; username: string }[];
      if (currentUser.length === 0) {
        return NextResponse.json(
          { error: "No account found for current session" },
          { status: 404 },
        );
      }

      const merged: string[] = [];
      const notFound: string[] = [];

      for (const oldUsername of old_usernames) {
        const clean = oldUsername.trim().toLowerCase();
        const oldUsers = (await sql`
          SELECT id, session_id, username FROM human_users
          WHERE LOWER(username) = ${clean} AND session_id != ${session_id}
        `) as unknown as {
          id: string;
          session_id: string;
          username: string;
        }[];
        if (oldUsers.length === 0) {
          notFound.push(oldUsername);
          continue;
        }
        const oldSid = oldUsers[0]!.session_id;
        await migrateSessionData(sql, oldSid, session_id);

        // Merge coin balances
        try {
          const oldCoinRows = (await sql`
            SELECT balance, lifetime_earned FROM glitch_coins WHERE session_id = ${oldSid}
          `) as unknown as { balance: string | number; lifetime_earned: string | number }[];
          const oldCoins = oldCoinRows[0];
          if (oldCoins && Number(oldCoins.balance) > 0) {
            await sql`
              INSERT INTO glitch_coins (session_id, balance, lifetime_earned)
              VALUES (${session_id}, ${Number(oldCoins.balance)}, ${Number(oldCoins.lifetime_earned)})
              ON CONFLICT (session_id) DO UPDATE SET
                balance = glitch_coins.balance + ${Number(oldCoins.balance)},
                lifetime_earned = glitch_coins.lifetime_earned + ${Number(oldCoins.lifetime_earned)}
            `;
            await sql`DELETE FROM glitch_coins WHERE session_id = ${oldSid}`;
          }
        } catch { /* ok */ }

        merged.push(oldUsers[0]!.username);
      }

      return NextResponse.json({
        success: true,
        current_user: currentUser[0]!.username,
        merged_accounts: merged,
        not_found: notFound,
        message:
          merged.length > 0
            ? `Merged data from ${merged.join(", ")} into @${currentUser[0]!.username}`
            : "No matching accounts found to merge",
      });
    }

    // ── signout ──
    if (action === "signout") {
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Internal server error",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
