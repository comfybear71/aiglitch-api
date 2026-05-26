/**
 * Google OAuth — Step 2 (callback).
 *
 * Exchanges authorisation code for tokens, fetches userinfo, upserts
 * the human_users row, then redirects to /me?oauth_session=… so the
 * frontend can pick up the new session id.
 *
 * Port note: legacy used `new URL("/me", request.url)` — fine while
 * the route serves from aiglitch.app, but once the strangler flips
 * `/api/auth/*` over to api.aiglitch.app the request URL becomes
 * api.aiglitch.app and redirects would land on the API host. Switched
 * to `NEXT_PUBLIC_APP_URL` (defaults to https://aiglitch.app) so the
 * /me redirect always points at the consumer app regardless of
 * which host served the callback.
 *
 * ensureDbReady dropped per CLAUDE.md migration rule #4.
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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app"}/api/auth/callback/google`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(appUrl("/me?error=not_configured"));
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return NextResponse.redirect(appUrl("/me?error=token_failed"));
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser = await userRes.json();

    if (!googleUser.email) {
      return NextResponse.redirect(appUrl("/me?error=no_email"));
    }

    const sql = getDb();

    const existing = await sql`
      SELECT id, session_id, username FROM human_users WHERE email = ${googleUser.email}
    `;

    let sessionId: string;
    let username: string;

    if (existing.length > 0) {
      sessionId = existing[0].session_id as string;
      username = (existing[0].username as string) || googleUser.email.split("@")[0];
      await sql`
        UPDATE human_users SET
          display_name = ${googleUser.name || username},
          avatar_emoji = '🌐',
          last_seen = NOW()
        WHERE id = ${existing[0].id}
      `;
    } else {
      sessionId = uuidv4();
      username = googleUser.email
        .split("@")[0]
        .replace(/[^a-z0-9_]/gi, "")
        .slice(0, 20)
        .toLowerCase();

      const usernameTaken = await sql`SELECT id FROM human_users WHERE username = ${username}`;
      if (usernameTaken.length > 0) {
        username = `${username}_${Math.floor(Math.random() * 999)}`;
      }

      await sql`
        INSERT INTO human_users (id, session_id, display_name, username, email, avatar_emoji, last_seen)
        VALUES (${uuidv4()}, ${sessionId}, ${googleUser.name || username}, ${username}, ${googleUser.email}, '🌐', NOW())
      `;
    }

    const redirectUrl = appUrl("/me");
    redirectUrl.searchParams.set("oauth_session", sessionId);
    redirectUrl.searchParams.set("oauth_username", username);
    redirectUrl.searchParams.set("oauth_provider", "google");

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(appUrl("/me?error=oauth_failed"));
  }
}
