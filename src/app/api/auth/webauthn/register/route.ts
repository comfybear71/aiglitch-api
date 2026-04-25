/**
 * GET  /api/auth/webauthn/register — issues registration options for
 *      a new passkey on the current device. Excludes any already-
 *      registered credentials so the user can't register the same
 *      authenticator twice.
 *
 * POST /api/auth/webauthn/register — verifies the attestation against
 *      the stashed challenge and stores the new credential row.
 *
 * Auth: BOTH paths require admin authentication first (cookie or
 * wallet). Passkeys augment, not replace, password login — you must
 * already be in to add one.
 */

import { randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  CHALLENGE_COOKIE,
  CHALLENGE_MAX_AGE_SECONDS,
  ensureWebauthnTable,
  getRpInfo,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Must be logged in as admin first" },
      { status: 401 },
    );
  }

  await ensureWebauthnTable();
  const sql = getDb();
  const existing = (await sql`
    SELECT credential_id FROM webauthn_credentials
  `) as unknown as { credential_id: string }[];

  const { rpID, rpName } = getRpInfo(request);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "admin",
    userDisplayName: "AIG!itch Admin",
    attestationType: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform", // built-in biometric only
      userVerification: "required",
      residentKey: "preferred",
    },
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      type: "public-key" as const,
      transports: ["internal"] as AuthenticatorTransportFuture[],
    })),
  });

  const response = NextResponse.json(options);
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
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Must be logged in as admin first" },
      { status: 401 },
    );
  }

  const challenge = request.cookies.get(CHALLENGE_COOKIE)?.value;
  if (!challenge) {
    return NextResponse.json(
      { error: "No challenge found — try again" },
      { status: 400 },
    );
  }

  const { rpID, origin } = getRpInfo(request);
  const body = (await request.json().catch(() => null)) as Parameters<
    typeof verifyRegistrationResponse
  >[0]["response"] | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json(
        { error: "Verification failed" },
        { status: 400 },
      );
    }

    const { credential, credentialDeviceType } = verification.registrationInfo;

    await ensureWebauthnTable();
    const sql = getDb();
    const id = randomUUID();
    const credentialIdBase64 = Buffer.from(credential.id).toString("base64url");
    const publicKeyBase64 = Buffer.from(credential.publicKey).toString("base64url");

    await sql`
      INSERT INTO webauthn_credentials (id, credential_id, public_key, counter, device_name)
      VALUES (
        ${id}, ${credentialIdBase64}, ${publicKeyBase64},
        ${credential.counter}, ${credentialDeviceType ?? "platform"}
      )
    `;

    const resp = NextResponse.json({ success: true });
    resp.cookies.delete(CHALLENGE_COOKIE);
    return resp;
  } catch (err) {
    console.error("[webauthn/register] verification error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Registration failed",
      },
      { status: 400 },
    );
  }
}
