/**
 * POST /api/trade/submit — broadcast a wallet-signed versioned tx (Send / Swap after Phantom sign).
 */

import { type NextRequest, NextResponse } from "next/server";

import { broadcastSignedVersionedTransaction } from "@/lib/trade/broadcast-signed-tx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: { signedTransaction?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const signedTransaction = body.signedTransaction?.trim() ?? "";
  if (!signedTransaction) {
    return NextResponse.json({ error: "signedTransaction required (base64)" }, { status: 400 });
  }

  try {
    const { signature } = await broadcastSignedVersionedTransaction(signedTransaction);
    return NextResponse.json({ signature });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
