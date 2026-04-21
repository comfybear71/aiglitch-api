/**
 * Admin NFT-marketplace — per-product image catalogue.
 *
 *   GET    — PUBLIC read (legacy parity: product images are displayed on
 *            the marketplace page). Lists `nft_product_images` newest
 *            first. Lazy `ensureTable()` on every request so fresh envs
 *            don't 500.
 *   POST   — admin-only:
 *            • `{ action: "delete", product_id }` — deletes the row.
 *            • default (generate) — legacy calls xAI `grok-imagine-image`
 *              to produce a studio-style product shot, downloads the
 *              ephemeral URL, uploads to Blob `marketplace/{id}-{slug}.png`,
 *              then UPSERTs (`ON CONFLICT (product_id)`) the row.
 *              **Phase 5 deferral** — image generation is not yet in
 *              `@/lib/ai/` (text-only today). Returns 501 with the same
 *              shape as `merch`'s deferred generate action. Unblocks
 *              when a shared image-gen helper lands.
 *
 *   GET stays un-gated deliberately — public marketplace reads. Every
 *   mutating path above goes through `isAdminAuthenticated`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function ensureTable() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS nft_product_images (
      product_id TEXT PRIMARY KEY,
      image_url TEXT NOT NULL,
      prompt_used TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export async function GET() {
  await ensureTable();
  const sql = getDb();
  const images = await sql`
    SELECT product_id, image_url
    FROM nft_product_images
    ORDER BY created_at DESC
  `;
  return NextResponse.json({ images });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    product_id?: string;
    product_name?: string;
    product_description?: string;
    product_emoji?: string;
    custom_prompt?: string;
  };

  if (body.action === "delete") {
    if (!body.product_id) {
      return NextResponse.json({ error: "product_id required" }, { status: 400 });
    }
    await sql`DELETE FROM nft_product_images WHERE product_id = ${body.product_id}`;
    return NextResponse.json({ success: true });
  }

  if (!body.product_id || !body.product_name) {
    return NextResponse.json(
      { error: "product_id and product_name required" },
      { status: 400 },
    );
  }

  // Legacy calls xAI `grok-imagine-image`, then downloads + uploads to
  // Blob + UPSERTs the row. `@/lib/ai/` currently exposes text-only
  // helpers (xaiComplete / claudeComplete / generateText) — no shared
  // image-gen client yet. Defer until a helper lands so all image-
  // generating admin routes can share one circuit breaker + cost-ledger
  // path (same reasoning as `merch`'s deferred generate action).
  return NextResponse.json(
    {
      error: "Not implemented in aiglitch-api yet",
      reason:
        "Image generation requires a shared xAI image-gen helper under @/lib/ai/ (circuit breaker + cost ledger parity). The delete action + public GET are fully ported; the generate action unblocks when the image-gen helper lands.",
    },
    { status: 501 },
  );
}
