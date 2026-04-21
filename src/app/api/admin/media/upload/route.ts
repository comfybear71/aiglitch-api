/**
 * Client-side Vercel Blob upload token handler.
 *
 * POST — Invoked by `@vercel/blob/client#upload()` running in the
 * browser. Serves a short-lived client token so the browser can
 * upload large files (video especially) directly to Vercel Blob,
 * bypassing the 4.5 MB serverless request body limit.
 *
 * After upload the browser hits `/api/admin/media/save` (still on
 * legacy pending marketing-lib port) to register the blob in
 * `media_library`. The `onUploadCompleted` Vercel webhook is NOT
 * used — DB save is handled by the client flow instead.
 *
 * Supports both JSON and multipart/form-data bodies — Safari/iOS
 * sometimes barks at `fetch` with a JSON string body
 * ("The string did not match the expected pattern" TypeError), so
 * the client wraps the JSON in FormData under the `__json` key.
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
          "image/png",
          "image/jpeg",
          "image/jpg",
          "image/webp",
          "image/gif",
          "image/heic",
          "image/heif",
          "image/avif",
          "video/mp4",
          "video/quicktime",
          "video/webm",
          "video/x-msvideo",
          "video/3gpp",
          "application/octet-stream",
        ],
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: true,
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
