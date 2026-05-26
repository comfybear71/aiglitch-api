/**
 * GitHub OAuth — Step 2 (callback).
 *
 * Exchanges code, fetches user + primary email, upserts human_users,
 * redirects to /me with the new session id.
 *
 * Port notes (same as google callback):
 *   - ensureDbReady dropped per CLAUDE.md migration rule #4.
 *   - /me redirect uses NEXT_PUBLIC_APP_URL so it works after the
 *     strangler flip to api.aiglitch.app.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function appUrl(path: string): URL {
  return new URL(path, process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app");
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(appUrl("/me?error=no_code"));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(appUrl("/me?error=not_configured"));
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return NextResponse.redirect(appUrl("/me?error=token_failed"));
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const ghUser = await userRes.json();

    let email = ghUser.email;
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const emails = await emailRes.json();
      const primary = emails.find((e: { primary: boolean }) => e.primary);
      email = primary?.email || emails[0]?.email;
    }

    const sql = getDb();

    const existing = email
      ? await sql`SELECT id, session_id, username FROM human_users WHERE email = ${email}`
      : [];

    let sessionId: string;
    let username: string;

    if (existing.length > 0) {
      sessionId = existing[0].session_id as string;
      username = (existing[0].username as string) || ghUser.login;
      await sql`
        UPDATE human_users SET
          display_name = ${ghUser.name || ghUser.login},
          avatar_emoji = '🐙',
          last_seen = NOW()
        WHERE id = ${existing[0].id}
      `;
    } else {
      sessionId = uuidv4();
      username = ghUser.login.replace(/[^a-z0-9_]/gi, "").slice(0, 20).toLowerCase();

      const usernameTaken = await sql`SELECT id FROM human_users WHERE username = ${username}`;
      if (usernameTaken.length > 0) {
        username = `${username}_${Math.floor(Math.random() * 999)}`;
      }

      await sql`
        INSERT INTO human_users (id, session_id, display_name, username, email, avatar_emoji, last_seen)
        VALUES (${uuidv4()}, ${sessionId}, ${ghUser.name || ghUser.login}, ${username}, ${email}, '🐙', NOW())
      `;
    }

    const redirectUrl = appUrl("/me");
    redirectUrl.searchParams.set("oauth_session", sessionId);
    redirectUrl.searchParams.set("oauth_username", username);
    redirectUrl.searchParams.set("oauth_provider", "github");

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    return NextResponse.redirect(appUrl("/me?error=oauth_failed"));
  }
}
