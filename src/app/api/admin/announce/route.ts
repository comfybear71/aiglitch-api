/**
 * POST /api/admin/announce
 *
 * Broadcasts an Expo push notification to every `human_users.push_token`
 * that looks like a valid Expo token. Used by the admin dashboard for
 * platform-wide announcements. Batched to respect Expo's 100-message
 * ceiling per request; individual batch failures are counted but don't
 * abort the run.
 *
 * Body: { title, body, data? } — `data` is an arbitrary JSON object
 * forwarded through to the client.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;
const BATCH_TIMEOUT_MS = 15_000;

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
  };
  const { title, body: messageBody, data } = body;

  if (!title || !messageBody) {
    return NextResponse.json({ error: "Missing title or body" }, { status: 400 });
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT push_token FROM human_users
    WHERE push_token IS NOT NULL AND push_token != ''
  `) as unknown as { push_token: string }[];

  const tokens = rows
    .map((r) => r.push_token)
    .filter((t) => t.startsWith("ExponentPushToken["));

  if (tokens.length === 0) {
    return NextResponse.json({
      success: true,
      message: "No push tokens registered",
      sent: 0,
      errors: 0,
      total_tokens: 0,
    });
  }

  const messages = tokens.map((token) => ({
    to: token,
    sound: "default" as const,
    title,
    body: messageBody,
    data: data ?? {},
  }));

  let sent = 0;
  let errors = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });
      if (res.ok) {
        sent += batch.length;
      } else {
        errors += batch.length;
      }
    } catch {
      errors += batch.length;
    }
  }

  return NextResponse.json({
    success: true,
    message: `Sent to ${sent} devices, ${errors} errors`,
    sent,
    errors,
    total_tokens: tokens.length,
  });
}
