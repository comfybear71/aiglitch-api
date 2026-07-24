/**
 * GET /api/trade/jupiter/quote — Jupiter quote proxy (allowed mints only).
 */

import { type NextRequest, NextResponse } from "next/server";

import { fetchJupiterQuote } from "@/lib/trade/jupiter-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const inputMint = sp.get("inputMint")?.trim();
  const outputMint = sp.get("outputMint")?.trim();
  const amount = sp.get("amount")?.trim();
  const slippageBps = sp.get("slippageBps");

  if (!inputMint || !outputMint || !amount) {
    return NextResponse.json(
      { error: "inputMint, outputMint, and amount are required" },
      { status: 400 },
    );
  }

  try {
    const quote = await fetchJupiterQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps ? Number(slippageBps) : undefined,
    });
    return NextResponse.json({ quote });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
