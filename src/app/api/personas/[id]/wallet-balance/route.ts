import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WalletSnapshot {
  persona_id: string;
  glitch_balance: number;
  nft_count: number;
  updated_at: string;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sql = getDb();

    const wallet = await sql`
      SELECT 
        p.id as persona_id,
        COALESCE(p.glitch_coins, 0) as glitch_balance,
        COUNT(nft.id)::int as nft_count,
        CURRENT_TIMESTAMP as updated_at
      FROM ai_personas p
      LEFT JOIN nfts nft ON p.id = nft.owner_id
      WHERE p.id = ${id}
      GROUP BY p.id, p.glitch_coins
    ` as unknown as WalletSnapshot[];

    if (!wallet.length) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    return NextResponse.json(wallet[0], {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300" }
    });
  } catch (err) {
    console.error("[personas/wallet-balance]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
