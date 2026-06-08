/**
 * /api/admin/meatlab/orphans — diagnostic for "stuck on Uploading…".
 *
 * Lists Blob objects under the `meatlab/` prefix uploaded in the
 * last 24h that have no matching `media_url` row in
 * `meatlab_submissions`. An orphan means the file made it to Blob
 * (Vercel Blob CDN accepted it) but the metadata POST that creates
 * the DB row either never fired or failed.
 *
 * This is the post-hoc equivalent of the admin breaking-news
 * "repair orphan posts" action: when a user reports a stuck upload,
 * an admin can hit this and see whether their file is actually on
 * Blob (in which case the metadata POST is the broken step) or
 * missing entirely (in which case the client-upload token flow is).
 *
 * GET — admin only. Returns `{ count, orphans: [{ url, size, uploaded_at }] }`.
 */

import { list as listBlobs } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const PREFIX = "meatlab/";
const WINDOW_HOURS = 24;
const MAX_PAGES = 20; // safety cap — 20 × 100 = 2000 blobs

interface BlobEntry {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date | string;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  const recentBlobs: BlobEntry[] = [];

  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await listBlobs({
        prefix: PREFIX,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const b of result.blobs) {
        const uploadedAtMs = new Date(b.uploadedAt).getTime();
        if (uploadedAtMs >= cutoff) {
          recentBlobs.push({
            url: b.url,
            pathname: b.pathname,
            size: b.size,
            uploadedAt: b.uploadedAt,
          });
        }
      }
      cursor = result.hasMore ? result.cursor : undefined;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin/meatlab/orphans] blob list failed: ${msg}`);
    return NextResponse.json(
      { error: `Blob list failed: ${msg}` },
      { status: 500 },
    );
  }

  if (recentBlobs.length === 0) {
    return NextResponse.json({ count: 0, orphans: [] });
  }

  const sql = getDb();
  const urls = recentBlobs.map((b) => b.url);
  const known = (await sql`
    SELECT media_url FROM meatlab_submissions
    WHERE media_url = ANY(${urls})
  `) as Array<{ media_url: string }>;

  const knownSet = new Set(known.map((r) => r.media_url));
  const orphans = recentBlobs
    .filter((b) => !knownSet.has(b.url))
    .map((b) => ({
      url: b.url,
      size: b.size,
      uploaded_at: b.uploadedAt,
    }));

  return NextResponse.json({ count: orphans.length, orphans });
}
