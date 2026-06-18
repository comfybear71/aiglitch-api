/**
 * /api/admin/ads/[id]/upload — Vercel Blob client-upload token handler.
 *
 * Mirrors the `/api/meatlab/upload` pattern. The browser SDK
 * (`@vercel/blob/client.upload`) calls this route to vend a short-lived
 * upload token, then uploads the asset directly to Blob from the
 * browser (bypassing the 4.5 MB serverless body limit). When the upload
 * completes, Vercel Blob webhooks us back via `onUploadCompleted` so we
 * can insert the asset row pointing at the new blob URL.
 *
 * Allowed paths:  ad-briefs/<brief_id>/...
 * Allowed MIMEs:  image/jpeg|png|webp|gif|heic, video/mp4|webm|quicktime|
 *                 x-matroska, application/octet-stream (iOS Safari quirk).
 * Max size:       500 MB (matches /api/meatlab/upload after v1.45.1).
 *
 * Admin auth required on the token request itself. The blob CDN webhook
 * carries a signed token from Vercel — we trust that path and don't
 * re-auth there.
 *
 * Pathname structure: ad-briefs/<brief_id>/<random>-<filename>. The
 * `<brief_id>` path segment is enforced against the [id] route param
 * so a token vended for brief A can't be used to dump assets into
 * brief B's directory.
 */

import {
  handleUpload,
  type HandleUploadBody,
} from "@vercel/blob/client";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  createAsset,
  getBrief,
} from "@/lib/content/ad-briefs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "application/octet-stream",
];

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: briefId } = await ctx.params;

  // Validate brief exists before vending an upload token. Avoids
  // orphaned blob writes for typos / deleted briefs.
  const brief = await getBrief(briefId);
  if (!brief) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 });
  }

  const expectedPrefix = `ad-briefs/${briefId}/`;
  const body = (await request.json().catch(() => ({}))) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const contentType =
          typeof clientPayload === "string" ? clientPayload : "(none)";
        console.log(
          `[admin/ads/upload] token request: brief=${briefId} pathname=${pathname} contentType=${contentType}`,
        );
        if (!pathname.startsWith(expectedPrefix)) {
          const msg = `Invalid upload path — expected ${expectedPrefix} prefix`;
          console.error(
            `[admin/ads/upload] token rejected: ${msg} pathname=${pathname}`,
          );
          throw new Error(msg);
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: 500 * 1024 * 1024,
          // Stash the brief id in the token so the completion webhook
          // can attach the asset to the right brief even if multiple
          // uploads complete concurrently.
          tokenPayload: JSON.stringify({ briefId }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        try {
          let attachedBriefId = briefId;
          if (tokenPayload) {
            try {
              const parsed = JSON.parse(tokenPayload) as { briefId?: string };
              if (parsed.briefId) attachedBriefId = parsed.briefId;
            } catch {
              // Token payload isn't required — fall back to the route id.
            }
          }
          const isVideo =
            (blob.contentType ?? "").startsWith("video/") ||
            /\.(mp4|mov|webm|m4v|mkv)(\?|$)/i.test(blob.url);
          const originalFilename =
            blob.pathname.split("/").pop() ?? "uploaded.bin";
          await createAsset({
            ad_brief_id: attachedBriefId,
            asset_type: isVideo ? "video" : "image",
            blob_url: blob.url,
            original_filename: originalFilename,
            // PutBlobResult doesn't expose size in v3; nullable.
            size_bytes: null,
          });
          console.log(
            `[admin/ads/upload] asset attached: brief=${attachedBriefId} url=${blob.url}`,
          );
        } catch (err) {
          console.error(
            `[admin/ads/upload] onUploadCompleted failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    });
    return NextResponse.json(json);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[admin/ads/upload] handleUpload failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
