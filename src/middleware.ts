/**
 * Live-traffic request logger.
 *
 * Runs in Edge runtime on every `/api/*` request and fires a single
 * insert to `migration_request_log` with `source='live'`. The
 * Migration Dashboard's Logs + Metrics tabs read from this table —
 * before this middleware they only ever showed entries created by the
 * manual `/api/admin/migration/test` runner, which is why those tabs
 * looked stale even though prod traffic was flowing.
 *
 * Trade-offs intentionally made for v1:
 *   • **No status / duration capture.** Middleware runs BEFORE the
 *     route handler; the handler's response status isn't visible to
 *     us. The row is inserted with `status=NULL`, `duration_ms=NULL`.
 *     A future commit can wrap each route with a higher-order
 *     `withLogging()` to capture status + duration accurately.
 *     For now, "which paths are being hit live" is the question this
 *     middleware answers — enough to spot routes that suddenly stop
 *     receiving traffic (which is how the Phase 3 channels/feed
 *     shape regression would have shown up in minutes).
 *   • **Fire-and-forget.** The insert never blocks the response. If
 *     Neon is slow or down, requests still go through; we just lose
 *     a log row.
 *   • **Sampled cleanup.** Every ~200th request runs a cap-trim that
 *     keeps the table at the most recent ~50k rows. Keeps the table
 *     bounded without a cron.
 *   • **Skips dashboard's own admin paths.** Logging /api/admin/migration/*
 *     would create runaway recursion (the dashboard's GET calls would
 *     log themselves, the resulting page render would log itself, etc.).
 *
 * If `DATABASE_URL` isn't set (preview deploys), the logger silently
 * no-ops. The request always proceeds.
 */

import { type NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

const ROW_CAP = 50_000;
const CLEANUP_PROBABILITY = 1 / 200;

export const config = {
  // Match only API routes — page renders aren't part of the strangler
  // story. Excluding nested admin/migration paths to avoid recursion.
  matcher: [
    "/api/:path*",
  ],
};

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Skip the dashboard's own machinery — logging it would either
  // recurse (every dashboard load adds N rows) or spam the table.
  if (path.startsWith("/api/admin/migration/")) {
    return NextResponse.next();
  }

  // Fire the insert without awaiting. If anything throws, the request
  // continues; we just silently lose the log row.
  void logRequest(path, request.method);

  return NextResponse.next();
}

async function logRequest(path: string, method: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  try {
    const sql = neon(url);
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO migration_request_log
        (id, method, path, source, created_at)
      VALUES
        (${id}, ${method}, ${path}, 'live', NOW())
    `;

    // Probabilistic cap-trim. Avoids a daily cron — every ~200th
    // request does the cleanup. With even 10 req/sec that's roughly
    // every 20 seconds, which keeps the table within ROW_CAP comfortably.
    if (Math.random() < CLEANUP_PROBABILITY) {
      await sql`
        DELETE FROM migration_request_log
        WHERE id IN (
          SELECT id FROM migration_request_log
          ORDER BY created_at DESC
          OFFSET ${ROW_CAP}
        )
      `;
    }
  } catch {
    // best-effort — never block the request on log-table issues.
  }
}
