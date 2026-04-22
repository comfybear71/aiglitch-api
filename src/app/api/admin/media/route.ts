/**
 * Admin media library CRUD + direct multipart upload.
 *
 * GET — list `media_library` rows (+ `?stats=1` adds video-source
 *   breakdowns, daily timeline, top video personas).
 * POST — multipart upload. Supports single `file` OR bulk `files`.
 *   Logo uploads require `persona_id = glitch-000`. Logo files land
 *   under `logo/{image|video}/`; everything else under
 *   `media-library/`. When `persona_id` is set, also INSERTs a feed
 *   post + bumps `post_count`.
 * DELETE — removes a `media_library` row by id (does not touch
 *   Blob storage; use `/api/content/media` or resync if cleanup
 *   needed).
 *
 * iOS Safari content-type fallback: when `file.type` is empty or
 * `application/octet-stream`, infer from the extension using the
 * 11-entry map so HEIC photos saved with `.jpeg` names don't get
 * stored under the wrong MIME.
 *
 * Deferred vs. legacy:
 *   • Architect auto-spread (`spreadArchitectContent`) — marketing
 *     lib not ported. Same pattern as `admin/media/save`.
 *   • `SEED_PERSONAS` FK safety INSERT — seeds already live on
 *     shared Neon.
 *   • `ensureDbReady` — schema assumed live.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHITECT_PERSONA_ID = "glitch-000";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

const VIDEO_EXTS = ["mp4", "mov", "webm", "avi"];

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const includeStats = request.nextUrl.searchParams.get("stats") === "1";

  const mediaPromise = sql`
    SELECT ml.id, ml.url, ml.media_type, ml.persona_id, ml.tags, ml.description,
      ml.used_count, ml.uploaded_at,
      ap.username as persona_username, ap.display_name as persona_name, ap.avatar_emoji as persona_emoji
    FROM media_library ml
    LEFT JOIN ai_personas ap ON ml.persona_id = ap.id
    ORDER BY ml.uploaded_at DESC
  `;

  if (!includeStats) {
    const media = await mediaPromise;
    return NextResponse.json({ media });
  }

  const [media, videoBySource, videoByType, videoTimeline, topVideoPersonas, totalVideosRows] =
    await Promise.all([
      mediaPromise,
      sql`
        SELECT COALESCE(media_source, 'unknown') as source, COUNT(*)::int as count
        FROM posts
        WHERE media_type = 'video' AND media_url IS NOT NULL
        GROUP BY media_source
        ORDER BY count DESC
      ` as unknown as Promise<{ source: string; count: number }[]>,
      sql`
        SELECT COALESCE(post_type, 'video') as post_type, COUNT(*)::int as count
        FROM posts
        WHERE media_type = 'video' AND media_url IS NOT NULL
        GROUP BY post_type
        ORDER BY count DESC
      ` as unknown as Promise<{ post_type: string; count: number }[]>,
      sql`
        SELECT DATE_TRUNC('day', created_at)::date as day, COUNT(*)::int as count
        FROM posts
        WHERE media_type = 'video' AND media_url IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      ` as unknown as Promise<{ day: string; count: number }[]>,
      sql`
        SELECT a.username, a.display_name, a.avatar_emoji,
          COUNT(p.id)::int as video_count
        FROM posts p
        JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.media_type = 'video' AND p.media_url IS NOT NULL
        GROUP BY a.id, a.username, a.display_name, a.avatar_emoji
        ORDER BY video_count DESC
        LIMIT 10
      ` as unknown as Promise<{ username: string; display_name: string; avatar_emoji: string; video_count: number }[]>,
      sql`
        SELECT COUNT(*)::int as total FROM posts WHERE media_type = 'video' AND media_url IS NOT NULL
      ` as unknown as Promise<{ total: number }[]>,
    ]);

  return NextResponse.json({
    media,
    video_stats: {
      total: totalVideosRows[0]?.total ?? 0,
      by_source: videoBySource,
      by_type: videoByType,
      daily_30d: videoTimeline,
      top_personas: topVideoPersonas,
    },
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const formData = await request.formData();
  const mediaType = (formData.get("media_type") as string) || "image";
  const tags = (formData.get("tags") as string) || "";
  const description = (formData.get("description") as string) || "";
  const personaId = (formData.get("persona_id") as string) || "";

  if (mediaType === "logo" && personaId !== ARCHITECT_PERSONA_ID) {
    return NextResponse.json(
      { error: "Only The Architect can upload logos" },
      { status: 403 },
    );
  }

  const files: File[] = [];
  const singleFile = formData.get("file");
  if (singleFile instanceof File && singleFile.size > 0) files.push(singleFile);
  for (const f of formData.getAll("files")) {
    if (f instanceof File && f.size > 0) files.push(f);
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const results: { id: string; url: string; name: string; error?: string }[] = [];

  for (const file of files) {
    try {
      const isLogo = mediaType === "logo";
      let detectedType = mediaType;
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const isVideoExt = VIDEO_EXTS.includes(ext);

      // DB constraint: only image/video/meme allowed; "logo" maps to concrete type
      if (isLogo) detectedType = isVideoExt ? "video" : "image";
      else if (isVideoExt) detectedType = "video";
      else if (ext === "gif") detectedType = "meme";

      const filename = isLogo
        ? `logo/${isVideoExt ? "video" : "image"}/${randomUUID()}.${ext || "webp"}`
        : `media-library/${randomUUID()}.${ext || (detectedType === "video" ? "mp4" : "webp")}`;

      const resolvedContentType =
        file.type && file.type !== "application/octet-stream"
          ? file.type
          : (CONTENT_TYPE_BY_EXT[ext] ?? "image/jpeg");

      const blob = await put(filename, file, {
        access: "public",
        contentType: resolvedContentType,
        addRandomSuffix: true,
      });

      const id = randomUUID();
      await sql`
        INSERT INTO media_library (id, url, media_type, persona_id, tags, description)
        VALUES (${id}, ${blob.url}, ${detectedType}, ${personaId || null}, ${tags}, ${description || file.name})
      `;

      if (personaId) {
        const postId = randomUUID();
        const postType =
          detectedType === "video"
            ? "video"
            : detectedType === "meme"
              ? "meme"
              : "image";
        const caption =
          description || tags || file.name.replace(/\.[^.]+$/, "");
        const hashtagStr = tags
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .join(",")
          : "";
        await sql`
          INSERT INTO posts (id, persona_id, content, post_type, hashtags, media_url, media_type, ai_like_count)
          VALUES (
            ${postId}, ${personaId}, ${caption}, ${postType}, ${hashtagStr},
            ${blob.url}, ${detectedType}, ${Math.floor(Math.random() * 500) + 50}
          )
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;
        // Architect auto-spread deferred — re-wires when @/lib/marketing ports.
      }

      results.push({ id, url: blob.url, name: file.name });
    } catch (err) {
      results.push({
        id: "",
        url: "",
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
    results,
    spreading: personaId === ARCHITECT_PERSONA_ID ? [] : undefined,
  });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await sql`DELETE FROM media_library WHERE id = ${body.id}`;
  return NextResponse.json({ success: true });
}
