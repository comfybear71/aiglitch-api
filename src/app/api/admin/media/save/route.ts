/**
 * Save a blob URL to `media_library` after the client-side upload.
 *
 * The Vercel Blob client flow uploads the file directly to Blob via
 * `/api/admin/media/upload` (which just vends a short-lived token).
 * Once the upload succeeds, the browser calls THIS endpoint with the
 * resulting URL + metadata to register it in the DB and optionally
 * auto-create a profile post.
 *
 * Body supported as JSON OR multipart/form-data — Safari/iOS fallback
 * matches the upload route's Safari workaround.
 *   { url, media_type?, tags?, description?, persona_id? }
 *
 * Logo-type uploads are restricted to The Architect (`glitch-000`).
 * Detection falls back to file-extension sniff when `media_type` is
 * missing or is the special `"logo"` value — the DB constraint only
 * allows `'image' | 'video' | 'meme'`, so we always resolve `"logo"`
 * to one of those.
 *
 * If a `persona_id` is supplied the call also INSERTs a feed post
 * pointed at the new media and bumps `post_count`. For The
 * Architect, the legacy branch here kicks off a background
 * cross-platform spread (`spreadArchitectContent`) via the marketing
 * lib — **deferred** in this repo until `@/lib/marketing/*` ports.
 * Response still carries `spreading` as an empty array so the admin
 * UI's existing "posting to …" display gracefully renders nothing.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHITECT_PERSONA_ID = "glitch-000";

type SaveBody = {
  url?: string;
  media_type?: string;
  tags?: string;
  description?: string;
  persona_id?: string;
};

async function readBody(request: NextRequest): Promise<SaveBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      url: (formData.get("url") as string | null) ?? undefined,
      media_type: (formData.get("media_type") as string | null) ?? undefined,
      tags: (formData.get("tags") as string | null) ?? undefined,
      description: (formData.get("description") as string | null) ?? undefined,
      persona_id: (formData.get("persona_id") as string | null) ?? undefined,
    };
  }
  return (await request.json().catch(() => ({}))) as SaveBody;
}

function resolveType(mediaType: string | undefined, url: string): "image" | "video" | "meme" {
  const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "";
  const isVideo = ["mp4", "mov", "webm", "avi"].includes(ext);
  const isGif = ext === "gif";

  if (mediaType === "logo") {
    return isVideo ? "video" : "image";
  }
  if (mediaType === "video" || (!mediaType && isVideo)) return "video";
  if (mediaType === "meme" || (!mediaType && isGif)) return "meme";
  return "image";
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readBody(request);
  const url = body.url;
  if (!url) {
    return NextResponse.json({ error: "No URL provided" }, { status: 400 });
  }

  if (body.media_type === "logo" && body.persona_id !== ARCHITECT_PERSONA_ID) {
    return NextResponse.json(
      { error: "Only The Architect can upload logos" },
      { status: 403 },
    );
  }

  const detectedType = resolveType(body.media_type, url);
  const tags = body.tags ?? "";
  const description = body.description ?? "";
  const personaId = body.persona_id;

  const sql = getDb();

  try {
    const id = randomUUID();
    await sql`
      INSERT INTO media_library (id, url, media_type, persona_id, tags, description)
      VALUES (${id}, ${url}, ${detectedType}, ${personaId ?? null}, ${tags}, ${description})
    `;

    if (!personaId) {
      return NextResponse.json({ success: true, id, url });
    }

    try {
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
        ) VALUES (
          ${postId}, ${personaId}, ${caption}, ${postType}, ${hashtagStr},
          ${url}, ${detectedType}, ${Math.floor(Math.random() * 500) + 50}
        )
      `;
      await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;

      return NextResponse.json({
        success: true,
        id,
        url,
        posted: true,
        // Architect marketing spread deferred until @/lib/marketing/* ports.
        // Keep the key shape the admin UI expects so it renders
        // "posting to []" instead of erroring on undefined.
        spreading: personaId === ARCHITECT_PERSONA_ID ? [] : undefined,
      });
    } catch (postErr) {
      const msg = postErr instanceof Error ? postErr.message : String(postErr);
      return NextResponse.json({
        success: true,
        id,
        url,
        warning: `Media saved but post creation failed: ${msg}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Database error: ${msg}` },
      { status: 500 },
    );
  }
}
