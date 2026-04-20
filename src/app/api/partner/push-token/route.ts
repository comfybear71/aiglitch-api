/**
 * POST /api/partner/push-token
 *
 * Registers (or refreshes) a push notification token for the iOS G!itch Bestie
 * app. Called on app launch after the user grants notification permission.
 *
 * Body: { session_id, token, platform? }
 *   platform defaults to "ios". Pass "android" if an Android build ships.
 *
 * Returns: { success: true }
 */

import { type NextRequest, NextResponse } from "next/server";
import { registerPushToken } from "@/lib/repositories/partner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PushTokenBody {
  session_id?: string;
  token?: string;
  platform?: string;
}

export async function POST(request: NextRequest) {
  let body: PushTokenBody;
  try {
    body = (await request.json()) as PushTokenBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, token, platform } = body;
  if (!session_id || !token) {
    return NextResponse.json(
      { error: "Missing session_id or token" },
      { status: 400 },
    );
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    return NextResponse.json({ error: "Token cannot be empty" }, { status: 400 });
  }

  try {
    await registerPushToken(session_id, token.trim(), platform ?? "ios");
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[partner/push-token] error:", err);
    return NextResponse.json(
      { error: "Failed to register push token" },
      { status: 500 },
    );
  }
}
