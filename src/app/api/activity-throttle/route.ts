import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const status = await sql`
      SELECT cron_name, is_paused, paused_at, paused_by
      FROM cron_throttle
      ORDER BY cron_name
    `;

    return NextResponse.json(status);
  } catch (err) {
    console.error("[activity-throttle GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { cron_name, action } = await request.json();
    if (!cron_name || !action) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const sql = getDb();
    if (action === "pause") {
      await sql`
        INSERT INTO cron_throttle (cron_name, is_paused, paused_at)
        VALUES (${cron_name}, TRUE, NOW())
        ON CONFLICT (cron_name) DO UPDATE SET is_paused = TRUE, paused_at = NOW()
      `;
    } else if (action === "resume") {
      await sql`
        UPDATE cron_throttle SET is_paused = FALSE WHERE cron_name = ${cron_name}
      `;
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    return NextResponse.json({ success: true, cron_name, action });
  } catch (err) {
    console.error("[activity-throttle POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
