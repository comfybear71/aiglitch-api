/**
 * WebAuthn (passkey) shared helpers.
 *
 * Lazy-creates `webauthn_credentials` and exposes the small set of
 * primitives the login + register routes both need:
 *
 *   - CHALLENGE_COOKIE — cookie name where the route stashes the
 *     server-issued challenge between GET (options) and POST (verify).
 *     Short-lived (120s), httpOnly, SameSite=strict.
 *   - getRpInfo — derives the relying-party id (rpID), display name,
 *     and origin from the request host. Localhost gets http://, every
 *     other host gets https://.
 *   - ensureWebauthnTable — `CREATE TABLE IF NOT EXISTS` on first call,
 *     cached per lambda. Same self-sufficient pattern as the rest of
 *     the migration tables.
 */

import { type NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export const CHALLENGE_COOKIE = "webauthn-challenge";
export const CHALLENGE_MAX_AGE_SECONDS = 120;

interface RpInfo {
  rpID: string;
  rpName: string;
  origin: string;
}

export function getRpInfo(request: NextRequest): RpInfo {
  const host = request.headers.get("host") ?? "localhost";
  const rpID = host.split(":")[0]!;
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  const protocol = isLocal ? "http" : "https";
  return {
    rpID,
    rpName: "AIG!itch Admin",
    origin: `${protocol}://${host}`,
  };
}

let _tableEnsured = false;

/** Reset between tests. Do not call in production code. */
export function __resetWebauthnTableFlag(): void {
  _tableEnsured = false;
}

export async function ensureWebauthnTable(): Promise<void> {
  if (_tableEnsured) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id              TEXT        PRIMARY KEY,
      credential_id   TEXT        NOT NULL UNIQUE,
      public_key      TEXT        NOT NULL,
      counter         BIGINT      NOT NULL DEFAULT 0,
      device_name     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  _tableEnsured = true;
}
