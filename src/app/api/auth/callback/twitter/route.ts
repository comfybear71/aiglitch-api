/**
 * X/Twitter OAuth 2.0 — Step 2 (callback).
 *
 * Pulls the PKCE `code_verifier` back out of the cookie, exchanges
 * the auth code for an access token, fetches /users/me, upserts
 * human_users, redirects to /me.
 *
 * Port notes (same as other callbacks):
 *   - ensureDbReady dropped per CLAUDE.md migration rule #4.
 *   - /me redirect uses NEXT_PUBLIC_APP_URL for forward-compat with
 *     the eventual strangler flip.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
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

  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app"}/api/auth/callback/twitter`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(appUrl("/me?error=not_configured"));
  }

  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get("twitter_code_verifier")?.value || "";

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return NextResponse.redirect(appUrl("/me?error=token_failed"));
    }

    const userRes = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userData = await userRes.json();
    const xUser = userData.data;

    if (!xUser) {
      return NextResponse.redirect(appUrl("/me?error=no_user"));
    }

    const sql = getDb();

    const xUsername = xUser.username || `x_${Math.floor(Math.random() * 9999)}`;
    const name = xUser.name || xUsername;

    const existing = await sql`
      SELECT id, session_id, username FROM human_users
      WHERE username = ${xUsername.toLowerCase()} AND auth_provider = 'twitter'
    `;

    let sessionId: string;
    let username: string;

    if (existing.length > 0) {
      sessionId = existing[0].session_id as string;
      username = existing[0].username as string;
      await sql`
        UPDATE human_users SET
          display_name = ${name},
          avatar_emoji = '🐦',
          last_seen = NOW()
        WHERE id = ${existing[0].id}
      `;
    } else {
      sessionId = uuidv4();
      username = xUsername.replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 20);

      const usernameTaken = await sql`SELECT id FROM human_users WHERE username = ${username}`;
      if (usernameTaken.length > 0) {
        username = `${username}_${Math.floor(Math.random() * 999)}`;
      }

      await sql`
        INSERT INTO human_users (id, session_id, display_name, username, avatar_emoji, auth_provider, last_seen)
        VALUES (${uuidv4()}, ${sessionId}, ${name}, ${username}, '🐦', 'twitter', NOW())
      `;
    }

    const redirectUrl = appUrl("/me");
    redirectUrl.searchParams.set("oauth_session", sessionId);
    redirectUrl.searchParams.set("oauth_username", username);
    redirectUrl.searchParams.set("oauth_provider", "twitter");

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error("X/Twitter OAuth callback error:", err);
    return NextResponse.redirect(appUrl("/me?error=oauth_failed"));
  }
}
