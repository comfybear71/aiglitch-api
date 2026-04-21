/**
 * Poll the status of a content-generation job.
 *
 * GET /api/content/status?job_id=<id> — returns the row from
 * `content_jobs`. 400 when missing, 404 when the job isn't there.
 * Used by the admin Content Studio UI after POSTing to
 * `/api/content/generate` to wait for the image/video to finish.
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

  const jobId = request.nextUrl.searchParams.get("job_id");
  if (!jobId) {
    return NextResponse.json({ error: "Missing job_id" }, { status: 400 });
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT id, type, prompt, status, result_url, error, metadata, created_at, updated_at
    FROM content_jobs WHERE id = ${jobId}
  `) as unknown as Record<string, unknown>[];

  const job = rows[0];
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({ job });
}
