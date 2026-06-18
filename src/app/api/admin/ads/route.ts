/**
 * /api/admin/ads — list + create ad briefs.
 *
 * Briefs are the seeds the Ad Creator pipeline will turn into stitched
 * promo / explainer / tutorial videos. This route is just the brief CRUD;
 * generation lands in a later session (ROADMAP session 3).
 *
 *   GET    — list briefs, optionally filtered by status / project_name
 *   POST   — create a draft brief
 *
 * Per-brief read/update/delete live at `/api/admin/ads/[id]`.
 * Asset uploads live at `/api/admin/ads/[id]/upload`.
 *
 * Admin auth required on every method — these spend Grok / HeyGen
 * credits when generation eventually fires, so we don't want anonymous
 * callers seeding them.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  AD_BRIEF_STATUS_VALUES,
  createBrief,
  listBriefs,
  type AdBriefStatus,
} from "@/lib/content/ad-briefs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function isAdBriefStatus(v: unknown): v is AdBriefStatus {
  return typeof v === "string" && (AD_BRIEF_STATUS_VALUES as string[]).includes(v);
}

// ─────────────────────────────────────────────────────────────────────
// GET — list briefs
// Query params:
//   status=draft|generating|ready|posted|failed|archived
//   project_name=<string>
//   includeArchived=1
//   limit=<int>  (default 50, max 200)
// ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const statusParam = sp.get("status");
  const project_name = sp.get("project_name") || undefined;
  const includeArchived = sp.get("includeArchived") === "1";
  const limit = parseInt(sp.get("limit") || "", 10) || undefined;

  let status: AdBriefStatus | undefined;
  if (statusParam) {
    if (!isAdBriefStatus(statusParam)) {
      return NextResponse.json(
        { error: `Invalid status. Allowed: ${AD_BRIEF_STATUS_VALUES.join(", ")}` },
        { status: 400 },
      );
    }
    status = statusParam;
  }

  try {
    const briefs = await listBriefs({
      status,
      project_name: project_name ?? null,
      includeArchived,
      limit,
    });
    return NextResponse.json({ total: briefs.length, briefs });
  } catch (err) {
    console.error("[admin/ads GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST — create a brief
// Body:
//   { title, project_name, concept, target_socials?, status? }
// ─────────────────────────────────────────────────────────────────────

interface CreatePayload {
  title?: unknown;
  project_name?: unknown;
  concept?: unknown;
  target_socials?: unknown;
  status?: unknown;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: CreatePayload;
  try {
    body = (await request.json()) as CreatePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const project_name =
    typeof body.project_name === "string" ? body.project_name.trim() : "";
  const concept = typeof body.concept === "string" ? body.concept : "";
  const target_socials =
    typeof body.target_socials === "string" ? body.target_socials : null;

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!project_name) {
    return NextResponse.json(
      { error: "project_name is required" },
      { status: 400 },
    );
  }

  let status: AdBriefStatus | undefined;
  if (body.status !== undefined) {
    if (!isAdBriefStatus(body.status)) {
      return NextResponse.json(
        { error: `Invalid status. Allowed: ${AD_BRIEF_STATUS_VALUES.join(", ")}` },
        { status: 400 },
      );
    }
    status = body.status;
  }

  try {
    const brief = await createBrief({
      title,
      project_name,
      concept,
      target_socials,
      status,
    });
    return NextResponse.json({ brief }, { status: 201 });
  } catch (err) {
    console.error("[admin/ads POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
