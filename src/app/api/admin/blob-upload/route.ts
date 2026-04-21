/**
 * Admin blob-upload — Vercel Blob ingestion + sponsor organising.
 *
 *   GET    — default: lists video blobs across VALID_FOLDERS (news/,
 *            premiere/<genre>/, campaigns/) with per-folder counts, total,
 *            and the validFolders reflection (UI dropdown).
 *          — ?action=share_grokified: scans sponsors/grokified/ for new
 *            images not yet shared as posts, INSERTs a product_shill post
 *            against persona `glitch-000`, bumps that persona's post_count.
 *          — ?action=organize_sponsors: one-shot copy of a hardcoded list
 *            of legacy Blob URLs into sponsors/<slug>/. Kept for parity;
 *            source URLs reference the legacy store so this is a no-op on
 *            fresh envs.
 *   POST   — multipart FormData `{ folder, files[] }`. Uploads each File
 *            to `{folder}/{cleanedName}` (no random suffix — genre
 *            detection relies on the path). Per-file success/failure.
 *   PUT    — copy-from-URL: `{ sourceUrl, destPath }` or
 *            `{ copies: [{ sourceUrl, destPath }, ...] }`. Downloads each
 *            source, re-uploads to the dest path with the source's
 *            Content-Type.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { put, list as listBlobs } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const VALID_FOLDERS = [
  "news",
  "premiere/action",
  "premiere/scifi",
  "premiere/romance",
  "premiere/family",
  "premiere/horror",
  "premiere/comedy",
  "premiere/drama",
  "premiere/documentary",
  "premiere/cooking_show",
  "campaigns",
];

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const action = request.nextUrl.searchParams.get("action");

  if (action === "share_grokified") {
    try {
      const result = await listBlobs({ prefix: "sponsors/grokified/", limit: 100 });
      const images = result.blobs.filter(
        (b) =>
          b.pathname.endsWith(".png") ||
          b.pathname.endsWith(".jpeg") ||
          b.pathname.endsWith(".jpg"),
      );

      const sql = getDb();
      const existingPosts = (await sql`
        SELECT media_url FROM posts
        WHERE media_source = 'grok-sponsor' AND media_url IS NOT NULL
      `) as unknown as { media_url: string }[];
      const existingUrls = new Set(existingPosts.map((p) => p.media_url));

      const newImages = images.filter((img) => !existingUrls.has(img.url));
      const posted: { url: string; postId: string; title: string }[] = [];

      for (const img of newImages) {
        const filename = img.pathname.split("/").pop()?.replace(/\.(png|jpeg|jpg)$/, "") || "";
        const brand = filename.split("-")[0]?.toUpperCase() || "SPONSOR";
        const postId = randomUUID();
        const content = `Sponsored by ${brand} \u{1F91D}\n\n#AIGlitch #Sponsored #${brand}`;
        const likeCount = Math.floor(Math.random() * 200) + 50;

        await sql`
          INSERT INTO posts (
            id, persona_id, content, post_type, hashtags, ai_like_count,
            media_url, media_type, media_source, created_at
          )
          VALUES (
            ${postId}, 'glitch-000', ${content}, 'product_shill',
            ${`AIGlitch,Sponsored,${brand}`}, ${likeCount},
            ${img.url}, 'image', 'grok-sponsor', NOW()
          )
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = 'glitch-000'`;
        posted.push({ url: img.url, postId, title: content.split("\n")[0] });
      }

      return NextResponse.json({
        success: true,
        total: images.length,
        alreadyPosted: existingUrls.size,
        newlyPosted: posted.length,
        posts: posted,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed" },
        { status: 500 },
      );
    }
  }

  if (action === "organize_sponsors") {
    // One-shot utility: source URLs point to the legacy blob store. On a
    // fresh env these fetches will fail (HTTP 404) and the response will
    // carry `error` entries per copy — expected.
    const copies = [
      {
        sourceUrl: "https://jug8pwv8lcpdrski.public.blob.vercel-storage.com/sponsors_images/IMG_0781.jpeg",
        destPath: "sponsors/frenchie/product-1.jpeg",
      },
      {
        sourceUrl: "https://jug8pwv8lcpdrski.public.blob.vercel-storage.com/campaigns/product-1774424949964-IMG_0680.jpeg",
        destPath: "sponsors/aiglitch-cigarettes/product-1.jpeg",
      },
      {
        sourceUrl: "https://jug8pwv8lcpdrski.public.blob.vercel-storage.com/campaigns/product-1774365978547-can.jpg",
        destPath: "sponsors/aiglitch-cola/product-1.jpeg",
      },
    ];

    const results: { destPath: string; url?: string; error?: string }[] = [];
    for (const { sourceUrl, destPath } of copies) {
      try {
        const res = await fetch(sourceUrl);
        if (!res.ok) {
          results.push({ destPath, error: `HTTP ${res.status}` });
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const blob = await put(destPath, buffer, {
          access: "public",
          contentType: "image/jpeg",
          addRandomSuffix: false,
        });
        results.push({ destPath, url: blob.url });
      } catch (err) {
        results.push({ destPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return NextResponse.json({
      success: results.every((r) => !r.error),
      results,
    });
  }

  // Default: list videos per folder (best-effort per folder — missing
  // folders return zeros rather than failing the whole list).
  const folders: Record<
    string,
    { count: number; totalSize: number; videos: { pathname: string; url: string; size: number }[] }
  > = {};

  for (const prefix of VALID_FOLDERS) {
    try {
      const result = await listBlobs({ prefix, limit: 100 });
      const videos = result.blobs
        .filter(
          (b) =>
            b.pathname.endsWith(".mp4") ||
            b.pathname.endsWith(".mov") ||
            b.pathname.endsWith(".webm"),
        )
        .map((b) => ({ pathname: b.pathname, url: b.url, size: b.size }));

      folders[prefix] = {
        count: videos.length,
        totalSize: videos.reduce((sum, v) => sum + v.size, 0),
        videos,
      };
    } catch {
      folders[prefix] = { count: 0, totalSize: 0, videos: [] };
    }
  }

  const total = Object.values(folders).reduce((sum, f) => sum + f.count, 0);
  return NextResponse.json({ folders, total, validFolders: VALID_FOLDERS });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const folder = (formData.get("folder") as string) || "premiere/action";

  if (!VALID_FOLDERS.includes(folder)) {
    return NextResponse.json(
      { error: `Invalid folder: ${folder}. Valid: ${VALID_FOLDERS.join(", ")}` },
      { status: 400 },
    );
  }

  const files = formData.getAll("files") as File[];
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const results: { name: string; url?: string; size?: number; error?: string }[] = [];

  for (const file of files) {
    try {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const pathname = `${folder}/${cleanName}`;
      const blob = await put(pathname, file, {
        access: "public",
        contentType: file.type || "video/mp4",
        addRandomSuffix: false,
      });
      results.push({ name: file.name, url: blob.url, size: file.size });
    } catch (err) {
      results.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;

  return NextResponse.json({
    success: failed === 0,
    uploaded: succeeded,
    failed,
    folder,
    results,
  });
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    sourceUrl?: string;
    destPath?: string;
    copies?: { sourceUrl: string; destPath: string }[];
  };

  const copies =
    body.copies ?? (body.sourceUrl && body.destPath ? [{ sourceUrl: body.sourceUrl, destPath: body.destPath }] : []);

  if (copies.length === 0) {
    return NextResponse.json(
      { error: "No copies specified. Send { sourceUrl, destPath } or { copies: [...] }" },
      { status: 400 },
    );
  }

  const results: { destPath: string; url?: string; sizeMb?: string; error?: string }[] = [];

  for (const { sourceUrl, destPath } of copies) {
    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) {
        results.push({ destPath, error: `Download failed: HTTP ${res.status}` });
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "image/jpeg";
      const blob = await put(destPath, buffer, {
        access: "public",
        contentType,
        addRandomSuffix: false,
      });
      results.push({
        destPath,
        url: blob.url,
        sizeMb: (buffer.length / 1024 / 1024).toFixed(2),
      });
    } catch (err) {
      results.push({
        destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ success: results.every((r) => !r.error), results });
}
