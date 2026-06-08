/**
 * Meatlab client-upload token handler.
 *
 * POST — Invoked by `@vercel/blob/client#upload()` running in the
 * browser. Vends a short-lived token so the browser uploads big
 * files (up to 100 MB here) directly to Vercel Blob, bypassing
 * the 4.5 MB serverless body limit.
 *
 * Path allowlist: `meatlab/…` or `avatars/…`. Anything else is
 * rejected so stray callers can't use this endpoint to drop
 * arbitrary paths into our Blob namespace. The path guard is what
 * makes the wider MIME allowlist below safe — without it the
 * `application/octet-stream` entry would let callers stash anything.
 *
 * Content-type allowlist: common image + video types plus
 * `application/octet-stream` (Safari iOS sometimes sends this for
 * camera-roll MP4s) and `video/x-matroska` (Android exports).
 * 100 MB max per file. No auth — meatlab uploads are user-initiated
 * from the public meatlab page. Consumed exclusively by the client-
 * side `upload()` call, which won't fire until the user signs in to
 * meatlab.
 *
 * Observability: every entry point logs a `[meatlab/upload] …` line
 * so we can tell token-rejection failures (bad MIME, bad path) apart
 * from the Vercel Blob CDN webhook `onUploadCompleted` failures and
 * from "slow upload still in progress." See
 * /api/admin/meatlab/orphans for the post-hoc forensic equivalent.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// onUploadCompleted can do DB writes — 60s was tight; 90s gives headroom.
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const contentType =
          typeof clientPayload === "string" ? clientPayload : "(none)";
        console.log(
          `[meatlab/upload] token request: pathname=${pathname} contentType=${contentType}`,
        );
        if (
          !pathname.startsWith("meatlab/") &&
          !pathname.startsWith("avatars/")
        ) {
          const msg = "Invalid upload path";
          console.error(
            `[meatlab/upload] token rejected: ${msg} pathname=${pathname}`,
          );
          throw new Error(msg);
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: 100 * 1024 * 1024,
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Wrap in try/catch — a throw here leaves the browser client
        // hanging on "Uploading…" forever, since the Blob CDN webhook
        // won't retry on a 500. Meatlab DB registration is handled
        // separately by the meatlab metadata POST flow, so logging is
        // the only contract we owe here. (PutBlobResult exposes url +
        // pathname + contentType but not size — Vercel doesn't ship
        // the byte count in the webhook payload.)
        try {
          console.log(
            `[meatlab/upload] upload complete: url=${blob.url} pathname=${blob.pathname} contentType=${blob.contentType}`,
          );
        } catch (err) {
          console.error(
            `[meatlab/upload] onUploadCompleted failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[meatlab/upload] handleUpload failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
