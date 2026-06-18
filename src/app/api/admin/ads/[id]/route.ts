/**
 * /api/admin/ads/[id] — read / update / soft-delete one brief.
 *
 *   GET    — full brief + attached assets array.
 *   PATCH  — update any subset of fields. Pass JSON; missing fields stay.
 *   DELETE — soft delete (sets status = 'archived'). Hard delete is not
 *            exposed because the briefs feed downstream pipelines that
 *            need the row to exist for ledger queries.
 *
 * All methods require admin auth.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  AD_BRIEF_STATUS_VALUES,
  getBriefWithAssets,
  softDeleteBrief,
  updateBrief,
  type AdBriefStatus,
} from "@/lib/content/ad-briefs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function isAdBriefStatus(v: unknown): v is AdBriefStatus {
  return typeof v === "string" && (AD_BRIEF_STATUS_VALUES as string[]).includes(v);
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const brief = await getBriefWithAssets(id);
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ brief });
  } catch (err) {
    console.error("[admin/ads/[id] GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

interface PatchPayload {
  title?: unknown;
  project_name?: unknown;
  concept?: unknown;
  status?: unknown;
  target_socials?: unknown;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: PatchPayload;
  try {
    body = (await request.json()) as PatchPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
    const updated = await updateBrief(id, {
      title: typeof body.title === "string" ? body.title : undefined,
      project_name:
        typeof body.project_name === "string" ? body.project_name : undefined,
      concept: typeof body.concept === "string" ? body.concept : undefined,
      status,
      target_socials:
        typeof body.target_socials === "string" ? body.target_socials : undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ brief: updated });
  } catch (err) {
    console.error("[admin/ads/[id] PATCH]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await softDeleteBrief(id);
    if (!ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/ads/[id] DELETE]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
