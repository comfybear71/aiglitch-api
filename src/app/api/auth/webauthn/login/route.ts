/**
 * GET  /api/auth/webauthn/login — issues authentication options for any
 *      registered passkey on the device. Returns `{ available: false }`
 *      when no credentials exist so the UI can hide the button.
 *
 * POST /api/auth/webauthn/login — verifies the signed assertion against
 *      the stashed challenge cookie. On success: bumps the credential's
 *      counter, sets the `aiglitch-admin-token` cookie (same as
 *      password login) and clears the challenge cookie.
 *
 * Auth: GET is public (anyone can attempt to passkey-login), POST is
 * implicitly auth'd by the signed challenge — only someone holding the
 * private key tied to a stored `credential_id` can succeed.
 */

import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { type NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  generateToken,
} from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  CHALLENGE_COOKIE,
  CHALLENGE_MAX_AGE_SECONDS,
  ensureWebauthnTable,
  getRpInfo,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CredentialRow {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number | string;
}

export async function GET(request: NextRequest) {
  await ensureWebauthnTable();
  const sql = getDb();
  const credentials = (await sql`
    SELECT credential_id FROM webauthn_credentials
  `) as unknown as { credential_id: string }[];

  if (credentials.length === 0) {
    return NextResponse.json({ available: false });
  }

  const { rpID } = getRpInfo(request);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      type: "public-key" as const,
      transports: ["internal"] as AuthenticatorTransportFuture[],
    })),
  });

  const response = NextResponse.json({ available: true, options });
  response.cookies.set(CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: CHALLENGE_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}

export async function POST(request: NextRequest) {
  const challenge = request.cookies.get(CHALLENGE_COOKIE)?.value;
  if (!challenge) {
    return NextResponse.json(
      { error: "No challenge found — try again" },
      { status: 400 },
    );
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error("[webauthn/login] ADMIN_PASSWORD not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as
    | { id?: string }
    | null;
  const credentialId = body?.id;
  if (!credentialId) {
    return NextResponse.json(
      { error: "Missing credential id" },
      { status: 400 },
    );
  }

  await ensureWebauthnTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT id, credential_id, public_key, counter
    FROM webauthn_credentials WHERE credential_id = ${credentialId}
  `) as unknown as CredentialRow[];

  if (rows.length === 0) {
    return NextResponse.json({ error: "Credential not found" }, { status: 400 });
  }

  const stored = rows[0]!;
  const { rpID, origin } = getRpInfo(request);

  try {
    const verification = await verifyAuthenticationResponse({
      response: body as unknown as Parameters<
        typeof verifyAuthenticationResponse
      >[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
        counter: Number(stored.counter),
        transports: ["internal"] as AuthenticatorTransportFuture[],
      },
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: "Biometric verification failed" },
        { status: 401 },
      );
    }

    await sql`
      UPDATE webauthn_credentials
      SET counter = ${verification.authenticationInfo.newCounter}
      WHERE id = ${stored.id}
    `;

    const token = generateToken(adminPassword);
    const resp = NextResponse.json({ success: true });
    resp.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days, matches /api/auth/admin
      path: "/",
    });
    resp.cookies.delete(CHALLENGE_COOKIE);
    return resp;
  } catch (err) {
    console.error("[webauthn/login] verification error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      { status: 400 },
    );
  }
}
