import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CronRun {
  id: string;
  cron_name: string;
  status: string;
  result: Record<string, unknown>;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();
    const limit = request.nextUrl.searchParams.get("limit") || "50";

    const runs = await sql`
      SELECT id, cron_name, status, result, created_at
      FROM cron_runs
      ORDER BY created_at DESC
      LIMIT ${parseInt(limit)}
    ` as unknown as CronRun[];

    return NextResponse.json(runs);
  } catch (err) {
    console.error("[activity GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
