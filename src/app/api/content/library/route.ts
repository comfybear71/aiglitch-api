/**
 * Paginated list of content-generation jobs with status totals.
 *
 * GET /api/content/library?limit=50&offset=0&status=completed&type=image
 *   — pure DB read of `content_jobs`. Optional `status` and `type`
 *     filters combine (AND). Returns `{jobs, stats, pagination}`
 *     where stats carries `total / completed / processing / failed`
 *     counts for the whole table (not the filtered page).
 *
 * Limit hard-capped at 200; `limit` and `offset` coerced via
 * `Number(...) || default`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

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
  const statusFilter = url.searchParams.get("status");
  const typeFilter = url.searchParams.get("type");

  let jobs;
  if (statusFilter && typeFilter) {
    jobs = await sql`
      SELECT id, type, prompt, status, result_url, error, created_at, updated_at
      FROM content_jobs
      WHERE status = ${statusFilter} AND type = ${typeFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (statusFilter) {
    jobs = await sql`
      SELECT id, type, prompt, status, result_url, error, created_at, updated_at
      FROM content_jobs
      WHERE status = ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (typeFilter) {
    jobs = await sql`
      SELECT id, type, prompt, status, result_url, error, created_at, updated_at
      FROM content_jobs
      WHERE type = ${typeFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    jobs = await sql`
      SELECT id, type, prompt, status, result_url, error, created_at, updated_at
      FROM content_jobs
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const totalsRows = (await sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM content_jobs
  `) as unknown as {
    total: string;
    completed: string;
    processing: string;
    failed: string;
  }[];
  const totals = totalsRows[0] ?? {
    total: "0",
    completed: "0",
    processing: "0",
    failed: "0",
  };

  const jobsArray = jobs as unknown[];
  return NextResponse.json({
    jobs: jobsArray,
    stats: {
      total: Number(totals.total),
      completed: Number(totals.completed),
      processing: Number(totals.processing),
      failed: Number(totals.failed),
    },
    pagination: { limit, offset, returned: jobsArray.length },
  });
}
