/**
 * Migration dashboard status endpoint.
 *
 * GET — admin-auth'd. Returns:
 *   • `ported[]`  — every route under src/app/api/** with its
 *                   exported HTTP methods. Filesystem-derived.
 *   • `pending[]` — typed catalogue from src/lib/migration/backlog.ts.
 *   • `groups`    — pending grouped by blocker for the dashboard.
 *   • `summary`   — counts: total / ported / pending / per-blocker.
 *
 * Powers the `/migration` UI page (Session 2). Also useful via curl
 * for stand-alone inspection.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  BLOCKER_LABELS,
  groupByBlocker,
  PENDING_ROUTES,
  type Blocker,
} from "@/lib/migration/backlog";
import { scanPortedRoutes } from "@/lib/migration/scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ported = scanPortedRoutes();
  const pending = PENDING_ROUTES;
  const grouped = groupByBlocker();

  const groups = Object.entries(grouped)
    .map(([key, routes]) => ({
      blocker: key as Blocker,
      label: BLOCKER_LABELS[key as Blocker],
      count: routes.length,
      sessions_estimated: routes.reduce((s, r) => s + r.sessions, 0),
      routes,
    }))
    .sort((a, b) => b.count - a.count);

  const summary = {
    ported_count: ported.length,
    pending_count: pending.length,
    total_count: ported.length + pending.length,
    percent_done:
      Math.round(
        (ported.length / (ported.length + pending.length)) * 1000,
      ) / 10,
    by_blocker: Object.fromEntries(
      groups.map((g) => [g.blocker, { count: g.count, sessions: g.sessions_estimated }]),
    ),
  };

  return NextResponse.json({
    summary,
    ported,
    pending,
    groups,
  });
}
