/**
 * Client-upload token handler for large premiere / news videos.
 *
 * POST — called by `@vercel/blob/client#upload()` in the browser.
 * Returns a short-lived token so the browser uploads the file
 * directly to Vercel Blob, bypassing the 4.5 MB serverless body
 * limit. Cap is 500 MB per file.
 *
 * Unlike `/api/admin/media/upload` (which allows images + 10+ video
 * content types + adds a random suffix), this endpoint is
 * specialized for premiere / news video uploads:
 *   • allowlist limited to 4 video content types
 *   • `addRandomSuffix: false` — keeps the clean folder path so
 *     `detectGenreFromPath` can infer genre from `/premiere/<genre>/`
 *     without being disrupted by random suffixes.
 *
 * Supports both JSON and `multipart/form-data` bodies (Safari/iOS
 * WebKit fallback — client wraps the JSON under a `__json` form
 * key). Same pattern as the other client-upload routes.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: HandleUploadBody;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    body = JSON.parse(formData.get("__json") as string) as HandleUploadBody;
  } else {
    body = (await request.json()) as HandleUploadBody;
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "video/mp4",
          "video/quicktime",
          "video/webm",
          "video/x-msvideo",
        ],
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: false,
      }),
      onUploadCompleted: async () => {},
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
