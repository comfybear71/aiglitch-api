/**
 * YouTube OAuth — Step 2 (admin marketing flow).
 *
 * Exchanges code, fetches channel info, upserts into
 * marketing_platform_accounts.
 *
 * Port notes:
 *   - ensureDbReady dropped per CLAUDE.md migration rule #4.
 *   - /admin redirects use NEXT_PUBLIC_APP_URL so they still resolve
 *     to the consumer host once the strangler flips.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function appUrl(path: string): URL {
  return new URL(path, process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app");
}

export async function GET(request: NextRequest) {
  const isAdmin = await isAdminAuthenticated(request);
  if (!isAdmin) {
    return NextResponse.redirect(appUrl("/admin?yt_error=unauthorized"));
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(appUrl("/admin?yt_error=no_code"));
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || "https://aiglitch.app"}/api/auth/callback/youtube`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(appUrl("/admin?yt_error=not_configured"));
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

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokens.access_token) {
      console.error(
        "[YouTube OAuth] Token exchange failed:",
        tokens.error,
        tokens.error_description,
      );
      return NextResponse.redirect(appUrl("/admin?yt_error=token_failed"));
    }

    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );

    const channelData = (await channelRes.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }>;
    };

    const channel = channelData.items?.[0];
    const channelId = channel?.id || "";
    const channelName = channel?.snippet?.title || "YouTube Channel";
    const channelUrl = channel?.snippet?.customUrl
      ? `https://www.youtube.com/${channel.snippet.customUrl}`
      : channelId
        ? `https://www.youtube.com/channel/${channelId}`
        : "";

    const sql = getDb();

    const existing = await sql`
      SELECT id FROM marketing_platform_accounts WHERE platform = 'youtube' LIMIT 1
    `;

    const extraConfig = JSON.stringify({
      refresh_token: tokens.refresh_token,
      token_expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
    });

    if (existing.length > 0) {
      await sql`
        UPDATE marketing_platform_accounts SET
          account_name = ${channelName},
          account_id = ${channelId},
          account_url = ${channelUrl},
          access_token = ${tokens.access_token},
          extra_config = ${extraConfig},
          is_active = TRUE,
          updated_at = NOW()
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO marketing_platform_accounts (id, platform, account_name, account_id, account_url, access_token, extra_config, is_active)
        VALUES (${uuidv4()}, 'youtube', ${channelName}, ${channelId}, ${channelUrl}, ${tokens.access_token}, ${extraConfig}, TRUE)
      `;
    }

    return NextResponse.redirect(appUrl("/admin?yt_success=connected"));
  } catch (err) {
    console.error("[YouTube OAuth] Error:", err);
    return NextResponse.redirect(appUrl("/admin?yt_error=oauth_failed"));
  }
}
