/**
 * DELETE /api/admin/ads/[id]/assets/[assetId] — remove a brief's asset.
 *
 * Hard-deletes the asset row. Does NOT delete the underlying Blob
 * object — deliberate, because the same blob might be referenced by
 * other surfaces (cron logs, ledger entries) and deleting here would
 * cause 404s when those try to render. Blob garbage collection is a
 * separate concern.
 *
 * The route param `[id]` is the brief id — we check that the asset
 * actually belongs to that brief before deleting so admins can't
 * accidentally delete an asset from a different brief via a stray
 * URL.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { deleteAsset, listAssetsForBrief } from "@/lib/content/ad-briefs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: briefId, assetId } = await ctx.params;

  try {
    // Ownership check: asset must belong to the brief in the URL.
    const briefAssets = await listAssetsForBrief(briefId);
    const target = briefAssets.find((a) => a.id === assetId);
    if (!target) {
      return NextResponse.json(
        { error: "Asset not found on this brief" },
        { status: 404 },
      );
    }
    const ok = await deleteAsset(assetId);
    if (!ok) {
      return NextResponse.json(
        { error: "Asset not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/ads/[id]/assets/[assetId] DELETE]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
