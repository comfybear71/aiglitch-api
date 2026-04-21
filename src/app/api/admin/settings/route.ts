/**
 * GET  /api/admin/settings              — read all admin-surfaced settings
 * GET  /api/admin/settings?key=<name>   — read a single setting by key
 * POST /api/admin/settings               — write one setting (whitelisted keys only)
 *
 * Settings live in `platform_settings` and are exposed to the admin
 * dashboard through this route. We keep a strict whitelist on POST —
 * arbitrary writes would blur the line between this route and other
 * admin tools (e.g. /api/activity-throttle) that already own specific
 * keys. Add to `ALLOWED_KEYS` only when a value is meant to be
 * user-editable from the settings UI.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getSetting, setSetting } from "@/lib/repositories/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_KEYS = ["voice_disabled"] as const;

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key");
  if (key) {
    const value = await getSetting(key);
    return NextResponse.json({ key, value });
  }

  const voiceDisabled = await getSetting("voice_disabled");
  return NextResponse.json({
    voice_disabled: voiceDisabled === "true",
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    key?: string;
    value?: unknown;
  };

  const { key, value } = body;
  if (!key || value === undefined) {
    return NextResponse.json({ error: "Missing key or value" }, { status: 400 });
  }

  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
    return NextResponse.json({ error: "Setting not allowed" }, { status: 400 });
  }

  const stringValue = String(value);
  await setSetting(key, stringValue);
  return NextResponse.json({ success: true, key, value: stringValue });
}
