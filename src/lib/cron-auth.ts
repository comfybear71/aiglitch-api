/**
 * Cron endpoint authentication.
 *
 * All cron POST handlers call `requireCronAuth(request)` at the top.
 * Returns null on success; returns a 401/500 NextResponse on failure so
 * callers can `return requireCronAuth(request) ?? ...rest`.
 *
 * Vercel invokes crons without an Authorization header by default — you
 * must set `CRON_SECRET` and configure Vercel to send it, or use a
 * manual HTTP trigger with `Authorization: Bearer <CRON_SECRET>`.
 */

import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secretBuf = Buffer.from(secret, "utf-8");
  const tokenBuf = Buffer.from(token, "utf-8");

  if (
    secretBuf.length !== tokenBuf.length ||
    !timingSafeEqual(secretBuf, tokenBuf)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
