import { type NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

/** Proxies images for Instagram + admin downloads (1080 JPEG). */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  try {
    const parsed = new URL(url);
    const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254"];
    if (blocked.some((d) => parsed.hostname.includes(d))) {
      return NextResponse.json({ error: "Domain not allowed" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const isDownload = request.nextUrl.searchParams.get("download") === "1";
  const filename =
    request.nextUrl.searchParams.get("filename")?.replace(/"/g, "") ||
    "aiglitch-image.jpg";

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${response.status}` },
        { status: 502 },
      );
    }

    const inputBuffer = Buffer.from(await response.arrayBuffer());
    const outputBuffer = await sharp(inputBuffer)
      .resize(1080, 1080, { fit: "cover", position: "centre" })
      .jpeg({ quality: 90 })
      .toBuffer();

    const headers: Record<string, string> = {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    };
    if (isDownload) {
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }

    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Proxy failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
