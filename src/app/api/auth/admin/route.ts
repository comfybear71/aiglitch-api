import { type NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, generateToken, safeEqual } from "@/lib/admin-auth";
import { adminLoginLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const GENERIC_ERROR = "Invalid credentials";

/**
 * POST /api/auth/admin
 *
 * Admin password login. On success, issues an HMAC-SHA256 session
 * cookie (`aiglitch-admin-token`) valid for 7 days. Used by the web
 * dashboard; mobile/admin-wallet auth goes through the wallet path
 * in `isAdminAuthenticated` on each admin route instead of this
 * endpoint.
 *
 * Rate-limited: 5 attempts per IP per 15 minutes. Successful logins
 * reset the counter so only failed attempts accumulate.
 *
 * Errors all return 401 with the same generic message — no info
 * leak about whether the password was "wrong" vs "missing" vs
 * "malformed body". Constant-time comparison on the password itself.
 */
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const rateCheck = adminLoginLimiter.check(ip);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateCheck.resetMs / 1000)),
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const password =
    typeof body === "object" && body !== null && "password" in body
      ? (body as { password: unknown }).password
      : undefined;

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    // Admin login can't succeed without a configured password. Return the
    // generic error rather than surfacing the config miss so probes can't
    // enumerate whether the env var is set.
    console.error("[auth/admin] ADMIN_PASSWORD env var not set");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  if (!safeEqual(password, adminPassword)) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Successful auth — drop failed-attempts count for this IP.
  adminLoginLimiter.reset(ip);

  const token = generateToken(adminPassword);
  const response = NextResponse.json({ success: true });
  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return response;
}
