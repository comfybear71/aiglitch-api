/**
 * Bulk URL import → Vercel Blob → media_library.
 *
 * POST — Body: `{urls, media_type?, tags?, description?, persona_id?}`
 *
 * For each URL: fetch the bytes with a browser-ish User-Agent, detect
 * media type from response `content-type` + URL extension, upload to
 * `media-library/{uuid}.{ext}`, INSERT `media_library`, and (when a
 * `persona_id` is provided) INSERT a profile post + bump
 * `post_count`. No auto-marketing here — architect-spread lives on
 * the non-import path and stays on legacy until the marketing lib
 * ports.
 *
 * Per-URL failures are isolated — `{results}` carries each URL's
 * outcome. `{success}` only true when every URL succeeded.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    urls?: string[];
    media_type?: string;
    tags?: string;
    description?: string;
    persona_id?: string;
  };

  const urls = body.urls ?? [];
  if (urls.length === 0) {
    return NextResponse.json({ error: "No URLs provided" }, { status: 400 });
  }

  const mediaType = body.media_type ?? "image";
  const tags = body.tags ?? "";
  const description = body.description ?? "";
  const personaId = body.persona_id ?? "";

  const sql = getDb();
  const results: { url: string; stored_url?: string; error?: string }[] = [];

  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    if (!url) continue;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        results.push({
          url,
          error: `HTTP ${response.status}: ${response.statusText}`,
        });
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "image/png";
      const buffer = await response.arrayBuffer();

      if (buffer.byteLength === 0) {
        results.push({ url, error: "Empty response" });
        continue;
      }

      let ext = "png";
      let detectedType = mediaType;

      if (contentType.includes("video/") || url.match(/\.(mp4|mov|webm|avi)(\?|$)/i)) {
        ext = contentType.includes("mp4")
          ? "mp4"
          : contentType.includes("webm")
            ? "webm"
            : "mp4";
        detectedType = "video";
      } else if (contentType.includes("gif") || url.match(/\.gif(\?|$)/i)) {
        ext = "gif";
        detectedType = "meme";
      } else if (contentType.includes("webp") || url.match(/\.webp(\?|$)/i)) {
        ext = "webp";
      } else if (
        contentType.includes("jpeg") ||
        contentType.includes("jpg") ||
        url.match(/\.jpe?g(\?|$)/i)
      ) {
        ext = "jpg";
      } else if (contentType.includes("png") || url.match(/\.png(\?|$)/i)) {
        ext = "png";
      }

      const filename = `media-library/${randomUUID()}.${ext}`;

      const blob = await put(filename, Buffer.from(buffer), {
        access: "public",
        contentType,
        addRandomSuffix: true,
      });

      const id = randomUUID();
      await sql`
        INSERT INTO media_library (id, url, media_type, persona_id, tags, description)
        VALUES (
          ${id}, ${blob.url}, ${detectedType}, ${personaId || null},
          ${tags}, ${description || url.slice(0, 100)}
        )
      `;

      if (personaId) {
        const postId = randomUUID();
        const postType =
          detectedType === "video"
            ? "video"
            : detectedType === "meme"
              ? "meme"
              : "image";
        const caption = description || tags || "";
        const hashtagStr = tags
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .join(",")
          : "";
        await sql`
          INSERT INTO posts (
            id, persona_id, content, post_type, hashtags,
            media_url, media_type, ai_like_count
          )
          VALUES (
            ${postId}, ${personaId}, ${caption}, ${postType}, ${hashtagStr},
            ${blob.url}, ${detectedType}, ${Math.floor(Math.random() * 500) + 50}
          )
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;
      }

      results.push({ url, stored_url: blob.url });
    } catch (err) {
      results.push({
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;

  return NextResponse.json({
    success: failed === 0,
    imported: succeeded,
    failed,
    results,
  });
}
