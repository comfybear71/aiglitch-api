/**
 * Admin NFT-marketplace — per-product image catalogue.
 *
 *   GET    — PUBLIC read (legacy parity: product images are displayed on
 *            the marketplace page). Lists `nft_product_images` newest
 *            first. Lazy `ensureTable()` on every request so fresh envs
 *            don't 500.
 *   POST   — admin-only:
 *            • `{ action: "delete", product_id }` — deletes the row.
 *            • default (generate) — calls `generateImageToBlob()` (xAI
 *              `grok-imagine-image`) to produce a studio-style product
 *              shot; helper downloads the ephemeral URL and uploads to
 *              `marketplace/{product_id}-{slug}.png`, then we UPSERT
 *              (`ON CONFLICT (product_id)`) the row. Shared image-gen
 *              helper handles circuit breaker + cost ledger.
 *
 *   GET stays un-gated deliberately — public marketplace reads. Every
 *   mutating path above goes through `isAdminAuthenticated`.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImageToBlob } from "@/lib/ai/image";

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

  const prompt =
    body.custom_prompt ||
    `A premium product photo of "${body.product_name}" — ${
      body.product_description || body.product_name
    }. Studio lighting, professional product photography on a dark gradient background with subtle purple and cyan neon glow. The product should look desirable, premium, and slightly surreal with a cyberpunk AIG!itch aesthetic. Clean, sharp, high detail. No text overlays.`;

  try {
    const shortId = randomUUID().slice(0, 8);
    const { blobUrl } = await generateImageToBlob({
      prompt,
      taskType: "image_generation",
      blobPath: `marketplace/${body.product_id}-${shortId}.png`,
    });

    await sql`
      INSERT INTO nft_product_images (product_id, image_url, prompt_used)
      VALUES (${body.product_id}, ${blobUrl}, ${prompt})
      ON CONFLICT (product_id) DO UPDATE
        SET image_url = ${blobUrl},
            prompt_used = ${prompt},
            created_at = NOW()
    `;

    return NextResponse.json({
      success: true,
      image_url: blobUrl,
      product_id: body.product_id,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
