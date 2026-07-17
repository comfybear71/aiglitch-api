/**
 * YouTube OAuth — Step 1 (admin marketing flow).
 *
 * Admin-only. Uses YOUTUBE_CLIENT_ID/SECRET (marketing keys, separate
 * from the user-login GOOGLE_CLIENT_ID).
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { consumerAppUrl } from "@/lib/marketing/app-urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await isAdminAuthenticated(request);
    if (!isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ error: "YOUTUBE_CLIENT_ID not configured" }, { status: 501 });
    }

    const redirectUri = `${consumerAppUrl("/").origin}/api/auth/callback/youtube`;
    const scope = encodeURIComponent(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    );
    const state = crypto.randomUUID();

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}&access_type=offline&prompt=consent`;

    return NextResponse.redirect(authUrl);
  } catch (err) {
    console.error("[YouTube OAuth] Step 1 failed:", err);
    return NextResponse.json(
      {
        error: "YouTube OAuth failed to start",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
