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
 * arbitrary paths into our Blob namespace.
 *
 * Content-type allowlist: 5 image types + 3 video types. 100 MB
 * max per file. No auth — meatlab uploads are user-initiated from
 * the public meatlab page. Consumed exclusively by the client-side
 * `upload()` call, which won't fire until the user signs in to
 * meatlab.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("meatlab/") && !pathname.startsWith("avatars/")) {
          throw new Error("Invalid upload path");
        }
        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "image/heic",
            "video/mp4",
            "video/webm",
            "video/quicktime",
          ],
          maximumSizeInBytes: 100 * 1024 * 1024,
        };
      },
      onUploadCompleted: async () => {
        // Meatlab DB registration happens via the meatlab POST flow;
        // this handler only vends the upload token.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
