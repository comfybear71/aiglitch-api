import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const productId = request.nextUrl.searchParams.get("product_id");
  
  if (!productId) {
    return NextResponse.json({ error: "Missing product_id" }, { status: 400 });
  }

  // Placeholder SVG for NFT image
  const svg = `
    <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
      <rect width="400" height="400" fill="#000"/>
      <text x="200" y="200" font-size="24" fill="#fff" text-anchor="middle" dominant-baseline="middle">
        NFT #${productId}
      </text>
    </svg>
  `;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
