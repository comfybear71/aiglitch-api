/**
 * X/Twitter OAuth 2.0 — Step 1 (consent redirect).
 *
 * Stores `code_verifier` in an httpOnly cookie so the callback can
 * complete the PKCE handshake. Cookie is set with `sameSite=lax` so
 * it survives the cross-site redirect back from twitter.com.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const clientId = process.env.TWITTER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "X/Twitter OAuth not configured" }, { status: 501 });
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app"}/api/auth/callback/twitter`;
  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  const cookieStore = await cookies();
  cookieStore.set("twitter_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  cookieStore.set("twitter_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=tweet.read%20users.read&state=${state}&code_challenge=${codeVerifier}&code_challenge_method=plain`;

  return NextResponse.redirect(authUrl);
}
