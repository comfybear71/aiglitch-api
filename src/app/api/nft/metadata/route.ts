import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint");
  
  if (!mint) {
    return NextResponse.json({ error: "Missing mint" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const nft = await sql`
      SELECT id, name, description, image_url, owner_id, created_at
      FROM nfts
      WHERE mint_address = ${mint}
      LIMIT 1
    ` as unknown as any[];

    if (!nft.length) {
      return NextResponse.json({ error: "NFT not found" }, { status: 404 });
    }

    const metadata = {
      name: nft[0].name,
      description: nft[0].description,
      image: nft[0].image_url,
      owner: nft[0].owner_id,
      mint,
      created: nft[0].created_at,
    };

    return NextResponse.json(metadata, {
      headers: { "Cache-Control": "public, max-age=3600" }
    });
  } catch (err) {
    console.error("[nft/metadata]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
