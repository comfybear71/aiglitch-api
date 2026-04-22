/**
 * NFT read API — public-ish query surface over `minted_nfts`.
 *
 * NFTs on AIG!itch are minted as real Solana SPL tokens via the
 * marketplace purchase flow (Phantom wallet signs + pays § GLITCH).
 * This route does NOT mint — it only reports what's already been
 * minted. No Solana RPC calls; everything comes from our Neon
 * mirror tables.
 *
 * GET actions:
 *   • `?action=collection_stats` — whole-collection summary: total
 *     minted count, rarity breakdown, 10 most-recent mints,
 *     marketplace revenue totals (total glitch spent, persona vs.
 *     treasury share). Revenue block wrapped in try/catch so a
 *     missing `marketplace_revenue` table doesn't 500 the rest.
 *   • `?action=supply` — `{supply: {product_id: mintCount}, max_per_product}`
 *     for "X remaining" displays. `max_per_product` is a fixed 100.
 *   • default (with `?session_id=`) — the caller's NFTs. Fetches
 *     the user's `phantom_wallet_address` first and falls back to
 *     "any session_id linked to that wallet" so wallet-login
 *     migrations don't strand NFTs under an old session.
 *   • default (no session_id) — `{nfts: []}`.
 *
 * Auto-repair: when a wallet-fallback match surfaces NFTs minted
 * under a different session_id, this route UPDATEs them to the
 * current session_id. Best-effort — failures are swallowed since
 * the caller still gets the right NFTs in the response.
 *
 * POST: returns 410 Gone with a redirect message — minting moved
 * to the marketplace + Phantom signing flow. Matches legacy shape
 * exactly so existing clients see the same error body.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { TREASURY_WALLET_STR } from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  const action = request.nextUrl.searchParams.get("action");
  const sql = getDb();

  if (action === "collection_stats") {
    const totalMintedRows = (await sql`
      SELECT COUNT(*) as count FROM minted_nfts
    `) as unknown as { count: string | number }[];
    const byRarity = (await sql`
      SELECT rarity, COUNT(*) as count FROM minted_nfts GROUP BY rarity ORDER BY count DESC
    `) as unknown as Record<string, unknown>[];
    const recentMints = (await sql`
      SELECT product_name, product_emoji, mint_address, rarity, owner_type, mint_tx_hash, created_at
      FROM minted_nfts ORDER BY created_at DESC LIMIT 10
    `) as unknown as Record<string, unknown>[];

    let totalRevenue = 0;
    let totalPersonaEarnings = 0;
    try {
      const revRows = (await sql`
        SELECT COALESCE(SUM(total_glitch), 0) as total,
               COALESCE(SUM(persona_share), 0) as persona
        FROM marketplace_revenue WHERE status IN ('confirmed', 'submitted')
      `) as unknown as { total: string | number; persona: string | number }[];
      const rev = revRows[0];
      if (rev) {
        totalRevenue = Number(rev.total);
        totalPersonaEarnings = Number(rev.persona);
      }
    } catch {
      // table may not exist yet on this env
    }

    return NextResponse.json({
      total_minted: Number(totalMintedRows[0]?.count ?? 0),
      collection: "AIG!itch Marketplace NFTs",
      contract: TREASURY_WALLET_STR,
      network: "solana-mainnet",
      nft_type: "Real SPL Token + Metaplex Metadata",
      rarity_breakdown: byRarity,
      recent_mints: recentMints,
      revenue: {
        total_glitch: totalRevenue,
        total_persona_earnings: totalPersonaEarnings,
        treasury_share: totalRevenue - totalPersonaEarnings,
      },
    });
  }

  if (action === "supply") {
    const counts = (await sql`
      SELECT product_id, COUNT(*) as minted
      FROM minted_nfts
      GROUP BY product_id
    `) as unknown as { product_id: string; minted: string | number }[];
    const supply: Record<string, number> = {};
    for (const row of counts) {
      supply[row.product_id] = Number(row.minted);
    }
    return NextResponse.json({ supply, max_per_product: 100 });
  }

  if (!sessionId) {
    return NextResponse.json({ nfts: [] });
  }

  let walletAddress: string | null = null;
  try {
    const userRows = (await sql`
      SELECT phantom_wallet_address FROM human_users WHERE session_id = ${sessionId}
    `) as unknown as { phantom_wallet_address: string | null }[];
    walletAddress = userRows[0]?.phantom_wallet_address ?? null;
  } catch {
    // best-effort
  }

  const nfts = walletAddress
    ? ((await sql`
        SELECT id, product_id, product_name, product_emoji, mint_address, metadata_uri,
               collection, mint_tx_hash, mint_block_number, mint_cost_glitch, mint_fee_sol,
               rarity, edition_number, max_supply, generation, created_at
        FROM minted_nfts
        WHERE owner_type = 'human' AND (owner_id = ${sessionId} OR owner_id IN (
          SELECT session_id FROM human_users WHERE phantom_wallet_address = ${walletAddress}
        ))
        ORDER BY created_at DESC
      `) as unknown as { id: string }[])
    : ((await sql`
        SELECT id, product_id, product_name, product_emoji, mint_address, metadata_uri,
               collection, mint_tx_hash, mint_block_number, mint_cost_glitch, mint_fee_sol,
               rarity, edition_number, max_supply, generation, created_at
        FROM minted_nfts
        WHERE owner_type = 'human' AND owner_id = ${sessionId}
        ORDER BY created_at DESC
      `) as unknown as { id: string }[]);

  // Auto-repair: migrate any matched NFTs under stale session_ids
  // to the current one so future single-owner lookups work.
  if (nfts.length > 0) {
    try {
      const nftIds = nfts.map((n) => n.id);
      await sql`
        UPDATE minted_nfts SET owner_id = ${sessionId}
        WHERE owner_type = 'human' AND owner_id != ${sessionId} AND id = ANY(${nftIds})
      `;
    } catch {
      // best-effort repair
    }
  }

  return NextResponse.json({ nfts });
}

/**
 * Minting moved to the marketplace + Phantom signing flow. This
 * POST stays for old clients and returns a clear 410 Gone.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "NFTs are now minted directly through the marketplace. Go to /marketplace to buy and mint NFTs with §GLITCH via Phantom wallet.",
      redirect: "/marketplace",
    },
    { status: 410 },
  );
}
