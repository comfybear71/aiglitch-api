/**
 * Recover `media_library` rows from orphaned Vercel Blob files.
 *
 * POST — Scans ALL Vercel Blob storage (across seven prefix buckets)
 * and re-registers any blob that's missing from the `media_library`
 * DB table. Useful after a DB reset where the blobs survived but the
 * catalogue rows were wiped.
 *
 * Media type is inferred from file extension:
 *   video  — mp4 / mov / webm / avi / m4v / mkv
 *   meme   — gif
 *   image  — everything else recognised (jpg / jpeg / png / webp /
 *            avif / bmp / svg). Unknown extensions are skipped.
 * The `isLogo` heuristic (pathname contains "logo") just prepends a
 * "logo" tag — it's not a separate media_type (DB constraint only
 * allows image / video / meme).
 *
 * Per-prefix scan errors are swallowed so a single failing bucket
 * doesn't abort the whole recovery. Per-insert errors bump an error
 * counter but keep going.
 */

import { randomUUID } from "node:crypto";
import { list as listBlobs } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "avi", "m4v", "mkv"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "avif", "bmp", "svg"]);
const MEME_EXTS = new Set(["gif"]);
const PREFIXES = [
  "media-library/",
  "videos/",
  "video/",
  "premiere/",
  "logos/",
  "memes/",
  "images/",
  "",
];

function detectType(pathname: string): "video" | "image" | "meme" {
  const ext = pathname.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (MEME_EXTS.has(ext)) return "meme";
  return "image";
}

function detectTags(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length > 1) return parts.slice(0, -1).join(",");
  return "recovered";
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN not set" },
      { status: 500 },
    );
  }

  const sql = getDb();
  const existing = (await sql`SELECT url FROM media_library`) as unknown as {
    url: string;
  }[];
  const existingUrls = new Set(existing.map((r) => r.url));

  let synced = 0;
  let skipped = 0;
  let errors = 0;
  const syncedItems: { url: string; type: string; pathname: string }[] = [];
  const scannedUrls = new Set<string>();

  for (const prefix of PREFIXES) {
    let cursor: string | undefined;
    try {
      do {
        const result = await listBlobs({ prefix, cursor, limit: 500 });
        cursor = result.cursor || undefined;

        for (const blob of result.blobs) {
          if (existingUrls.has(blob.url) || scannedUrls.has(blob.url)) {
            skipped++;
            continue;
          }
          scannedUrls.add(blob.url);

          const ext =
            blob.pathname.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "";
          if (
            !VIDEO_EXTS.has(ext) &&
            !IMAGE_EXTS.has(ext) &&
            !MEME_EXTS.has(ext)
          ) {
            continue;
          }

          const mediaType = detectType(blob.pathname);
          const tags = detectTags(blob.pathname);
          const isLogo = blob.pathname.toLowerCase().includes("logo");

          try {
            const id = randomUUID();
            await sql`
              INSERT INTO media_library (id, url, media_type, tags, description)
              VALUES (
                ${id}, ${blob.url}, ${mediaType},
                ${isLogo ? `logo,${tags}` : tags},
                ${blob.pathname}
              )
              ON CONFLICT DO NOTHING
            `;
            synced++;
            syncedItems.push({
              url: blob.url,
              type: mediaType,
              pathname: blob.pathname,
            });
          } catch (err) {
            errors++;
            console.error(
              `[resync] Failed to insert ${blob.pathname}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } while (cursor);
    } catch (prefixErr) {
      console.error(
        `[resync] Blob scan for prefix "${prefix}" failed:`,
        prefixErr instanceof Error ? prefixErr.message : prefixErr,
      );
    }
  }

  const counts = {
    memes: syncedItems.filter((i) => i.type === "meme").length,
    images: syncedItems.filter((i) => i.type === "image").length,
    videos: syncedItems.filter((i) => i.type === "video").length,
  };

  return NextResponse.json({
    success: true,
    synced,
    skipped,
    errors,
    already_in_db: existing.length,
    counts,
    sample: syncedItems.slice(0, 20).map((i) => `${i.type}: ${i.pathname}`),
  });
}
