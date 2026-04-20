/**
 * Admin auth helpers.
 *
 * Two auth methods (both checked in `isAdminAuthenticated`):
 *   1. **Cookie** (`aiglitch-admin-token`) — HMAC-SHA256 of a static
 *      message, keyed on `ADMIN_PASSWORD`. Web dashboard path.
 *   2. **Wallet** — `wallet_address` from query/header compared
 *      against `ADMIN_WALLET` env var. Mobile-app path; the mobile
 *      app signs requests with its linked phantom wallet address.
 *
 * Env vars required:
 *   - `ADMIN_PASSWORD` — set on Vercel. Used as the HMAC key.
 *   - `ADMIN_WALLET`   — optional; enables wallet-based admin auth.
 *                         (Same value as `NEXT_PUBLIC_ADMIN_WALLET`
 *                         when set; kept server-only for auth.)
 *
 * Rotating the password invalidates every existing cookie (the HMAC
 * key changes, so old tokens don't verify). That's intentional.
 */

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "aiglitch-admin-token";

/**
 * Constant-time string comparison. Prevents timing-side-channel
 * attacks on password/token checks. Length mismatch still spends
 * roughly the same CPU time.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Burn cycles against self so callers can't infer length from timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Deterministic HMAC-SHA256 session token. Keyed on the admin password
 * + a static message — same password always yields the same token,
 * regardless of serverless instance. Changing the password invalidates
 * every existing token. Not reversible.
 */
export function generateToken(password: string): string {
  return createHmac("sha256", password)
    .update("aiglitch-admin-session-v1")
    .digest("hex");
}

/**
 * Returns true when the request is authenticated as admin via either
 * cookie or wallet. Used by Phase 7 admin routes to gate every
 * dashboard/moderation action.
 *
 * Cookie path: reads `aiglitch-admin-token` via `next/headers` cookies
 * and compares against `generateToken(ADMIN_PASSWORD)`.
 *
 * Wallet path: reads `wallet_address` from query / `X-Wallet-Address`
 * header / `Authorization: Wallet <addr>` header; compares against
 * `ADMIN_WALLET`. Only attempted when a `request` is passed.
 */
export async function isAdminAuthenticated(
  request?: Request,
): Promise<boolean> {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const cookieStore = await cookies();
    const token = cookieStore.get(ADMIN_COOKIE);
    if (token?.value) {
      if (safeEqual(token.value, generateToken(adminPassword))) return true;
    }
  }

  if (request) {
    const adminWallet = process.env.ADMIN_WALLET;
    if (adminWallet) {
      const url = new URL(request.url);
      const authHeader = request.headers.get("authorization");
      const wallet =
        url.searchParams.get("wallet_address") ??
        request.headers.get("x-wallet-address") ??
        (authHeader?.startsWith("Wallet ") ? authHeader.slice("Wallet ".length) : null);
      if (wallet && safeEqual(wallet, adminWallet)) return true;
    }
  }

  return false;
}
