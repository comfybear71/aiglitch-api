/**
 * Generic request-runner for the /migration dashboard Test tab.
 *
 * POST `{ path, method, body?, query?, session_id? }` — executes
 * the request against our own API (resolved against
 * `NEXT_PUBLIC_APP_URL` or `request.url` origin), times it, and
 * records the outcome in `migration_request_log`. Returns the
 * response status + body + duration_ms + log_id.
 *
 * Admin-auth'd. The request runner forwards the admin cookie
 * automatically so downstream admin routes authenticate as this
 * same caller — no special-casing needed for admin endpoints.
 *
 * `session_id` is purely informational (stored on the log row so
 * metrics can be filtered by who ran the test) — it is NOT sent
 * as a cookie; callers that want to impersonate a real session
 * should include `session_id` in the body/query themselves.
 *
 * Response body is truncated to 2 KB on the log row but returned
 * in full to the dashboard.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { insertRequestLog } from "@/lib/migration/request-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const input = (await request.json().catch(() => ({}))) as {
    path?: string;
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    session_id?: string;
  };

  if (!input.path || typeof input.path !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (!input.path.startsWith("/")) {
    return NextResponse.json(
      { error: "path must be absolute (start with /)" },
      { status: 400 },
    );
  }
  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json(
      { error: `method must be one of ${[...ALLOWED_METHODS].join(", ")}` },
      { status: 400 },
    );
  }

  // Build target URL. Prefer NEXT_PUBLIC_APP_URL so the runner
  // stays stable across dev/preview/prod; fall back to the incoming
  // request's origin.
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    new URL(request.url).origin;
  const url = new URL(`${base}${input.path}`);
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      url.searchParams.set(k, v);
    }
  }

  // Forward the admin cookie so downstream admin routes recognise us.
  const headers: Record<string, string> = {};
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  if (method !== "GET" && input.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const sql = getDb();
  const startMs = Date.now();
  let status: number | undefined;
  let responseText = "";
  let errorMsg: string | undefined;
  let parsedBody: unknown = null;

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body:
        method !== "GET" && input.body !== undefined
          ? JSON.stringify(input.body)
          : undefined,
      signal: AbortSignal.timeout(110_000),
    });
    status = res.status;
    responseText = await res.text();
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      parsedBody = responseText;
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startMs;

  let logId: string | undefined;
  try {
    logId = await insertRequestLog(sql, {
      method,
      path: input.path,
      status,
      durationMs,
      requestBody: input.body,
      responseBody: responseText,
      error: errorMsg,
      sessionId: input.session_id,
    });
  } catch {
    // logging failure shouldn't abort the test — the caller still
    // gets the response. Just omit logId.
  }

  return NextResponse.json({
    ok: !errorMsg && status != null && status < 400,
    status: status ?? null,
    duration_ms: durationMs,
    body: parsedBody,
    error: errorMsg ?? null,
    log_id: logId ?? null,
  });
}
