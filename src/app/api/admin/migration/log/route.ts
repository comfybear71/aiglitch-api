/**
 * Migration request-log browser.
 *
 * GET — admin-auth'd list of recent test runs. Supports:
 *   ?limit=50 (cap 200) &offset=0
 *   &path=/api/foo       — filter by target path
 *   &status=ok|error|any — 2xx-only / 4xx+/network-error / all
 *
 * Also returns `paths` — distinct target paths seen in the log
 * so the dashboard can populate a filter dropdown in one request.
 *
 * DELETE — admin-auth'd. Truncates the whole log. Returns
 * `{deleted: N}`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  clearRequestLog,
  ensureRequestLogTable,
  listRequestLog,
} from "@/lib/migration/request-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const url = request.nextUrl;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Number(url.searchParams.get("offset")) || 0;
  const pathFilter = url.searchParams.get("path") ?? undefined;
  const rawStatus = url.searchParams.get("status");
  const statusFilter: "ok" | "error" | "any" =
    rawStatus === "ok" || rawStatus === "error" ? rawStatus : "any";

  const logs = await listRequestLog(sql, {
    limit,
    offset,
    pathFilter,
    statusFilter,
  });

  // Distinct target paths — for the dashboard filter dropdown.
  await ensureRequestLogTable();
  const pathRows = (await sql`
    SELECT DISTINCT path FROM migration_request_log ORDER BY path ASC
  `) as unknown as { path: string }[];

  return NextResponse.json({
    logs,
    paths: pathRows.map((p) => p.path),
    pagination: { limit, offset, returned: logs.length },
  });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sql = getDb();
  const deleted = await clearRequestLog(sql);
  return NextResponse.json({ deleted });
}
