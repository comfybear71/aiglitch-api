/**
 * POST /api/trade/magic-link/create — build escrow deposit tx + claim URL (devnet-first).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { mintDecimals } from "@/lib/trade/build-transfer";
import { buildMagicCreateDepositTx } from "@/lib/trade/magic-claim/client";
import { newClaimIdBase58, resolveMagicLinkMint } from "@/lib/trade/magic-claim/claim-id";
import {
  MAGIC_LINK_EXPIRY_SEC,
  claimUrl,
  isMagicLinkEnabled,
  magicLinkSymbolsAllowed,
} from "@/lib/trade/magic-claim/config";
import { insertMagicClaim } from "@/lib/trade/magic-claim/db";
import { assertMagicLinkWithinUsdCap } from "@/lib/trade/magic-claim/usd-cap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isMagicLinkEnabled()) {
    return NextResponse.json(
      {
        error:
          "Magic link not enabled — deploy program on devnet and set TRADE_MAGIC_CLAIM_PROGRAM_ID (see docs/trade-magic-link-devnet.md)",
      },
      { status: 503 },
    );
  }

  let body: { senderPublicKey?: string; symbol?: string; amountAtomic?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const senderPublicKey = body.senderPublicKey?.trim() ?? "";
  const symbol = body.symbol?.trim().toUpperCase() ?? "";
  const amountAtomic = body.amountAtomic?.trim() ?? "";

  if (!senderPublicKey || !isValidSolanaAddress(senderPublicKey)) {
    return NextResponse.json({ error: "Invalid senderPublicKey" }, { status: 400 });
  }
  if (!magicLinkSymbolsAllowed().includes(symbol)) {
    return NextResponse.json(
      { error: `Magic link on this network supports: ${magicLinkSymbolsAllowed().join(", ")}` },
      { status: 400 },
    );
  }
  if (!amountAtomic || !/^\d+$/.test(amountAtomic) || amountAtomic === "0") {
    return NextResponse.json({ error: "Invalid amountAtomic" }, { status: 400 });
  }

  const mint = resolveMagicLinkMint(symbol);
  if (!mint) {
    return NextResponse.json({ error: "Token not enabled" }, { status: 400 });
  }

  const decimals = mintDecimals(mint);
  const amountHuman = Number(amountAtomic) / 10 ** decimals;

  try {
    await assertMagicLinkWithinUsdCap(symbol, amountHuman);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { id: claimId, bytes } = newClaimIdBase58();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_SEC * 1000);
  const expiresAtSec = Math.floor(expiresAt.getTime() / 1000);

  try {
    await insertMagicClaim({
      claimId,
      senderWallet: senderPublicKey,
      symbol,
      mint,
      amountAtomic,
      expiresAt,
    });

    const built = await buildMagicCreateDepositTx({
      sender: senderPublicKey,
      mint,
      claimIdBytes: bytes,
      amountAtomic,
      expiresAtSec,
    });

    return NextResponse.json({
      claimId,
      claimUrl: claimUrl(claimId),
      expiresAt: expiresAt.toISOString(),
      transaction: built.transaction,
      symbol,
      amountAtomic,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
