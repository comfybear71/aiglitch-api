/**
 * Admin API — bulk Solana wallet generation for personas missing one.
 *
 * Port of legacy aiglitch/src/app/api/admin/personas/generate-missing-wallets/
 * route.ts. Approved per decision #6 (2026-05-26) as system-custodial of
 * AI persona wallets only — same model as the existing treasury / ElonBot /
 * AI-pool wallets. NOT user-custodial.
 *
 * Two modes:
 *   GET                         — list active personas without a budju_wallets row
 *   POST { persona_id }         — create wallet for ONE persona (idempotent —
 *                                  returns "already_exists" if wallet present)
 *   POST {}                     — batch: create wallets for every active
 *                                  persona missing one
 *
 * Safety guarantees:
 *  • NEVER exposes private keys — only persona_id, username, wallet_address.
 *  • Uses the XOR + bs58 encryption convention shared with budju.ts +
 *    admin/init-persona (cross-route interoperability — encrypted key from
 *    one route can be decrypted by another).
 *  • Does NOT fund wallets (zero balance, inert until budju distribution).
 *  • Does NOT touch trading logic or treasury keys.
 *
 * Schema parity: `budju_wallets` already exists in shared Neon (other
 * Phase 7 admin routes assume it). Per CLAUDE.md migration rule #4
 * (no auto-schema-migration in aiglitch-api), this route does not
 * CREATE TABLE — legacy did, we don't.
 */

import { type NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Wallets are distributed across N round-robin "distributor groups" so the
// downstream budju distribution cron can fan out batched transfers without
// hammering one group per cycle. 16 matches legacy.
const DISTRIBUTOR_COUNT = 16;

/**
 * XOR cipher keyed on BUDJU_WALLET_SECRET (or fallbacks for dev).
 * MUST match the exact byte layout used by:
 *   - aiglitch/src/lib/trading/budju.ts decryptKeypair
 *   - aiglitch/src/app/api/admin/init-persona/route.ts encryptKeypair
 * Any change to this function breaks key recovery across the whole
 * persona-wallet system. Don't refactor without coordinating all three.
 */
function encryptKeypair(secretKey: Uint8Array): string {
  const encryptionKey =
    process.env.BUDJU_WALLET_SECRET ??
    process.env.ADMIN_PASSWORD ??
    "budju-default-key";
  const keyBytes = new TextEncoder().encode(encryptionKey);
  const encrypted = new Uint8Array(secretKey.length);
  for (let i = 0; i < secretKey.length; i++) {
    encrypted[i] = secretKey[i] ^ keyBytes[i % keyBytes.length];
  }
  return bs58.encode(encrypted);
}

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji?: string | null;
}

interface WalletRow {
  id: string;
  wallet_address: string;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const personas = (await sql`
    SELECT p.id, p.username, p.display_name, p.avatar_emoji
    FROM ai_personas p
    LEFT JOIN budju_wallets bw
      ON bw.persona_id = p.id AND bw.is_active = TRUE
    WHERE p.is_active = TRUE AND bw.id IS NULL
    ORDER BY p.id
  `) as unknown as PersonaRow[];

  return NextResponse.json({ total: personas.length, personas });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as { persona_id?: string };
  const targetPersonaId = body.persona_id;

  // Mode 1: create for a single persona (preferred — used by per-card UI).
  if (targetPersonaId) {
    const [persona] = (await sql`
      SELECT id, username, display_name
      FROM ai_personas
      WHERE id = ${targetPersonaId} AND is_active = TRUE
      LIMIT 1
    `) as unknown as PersonaRow[];

    if (!persona) {
      return NextResponse.json(
        {
          success: false,
          persona_id: targetPersonaId,
          status: "not_found",
          message: "Persona not found or inactive",
        },
        { status: 404 },
      );
    }

    const [existing] = (await sql`
      SELECT id, wallet_address FROM budju_wallets WHERE persona_id = ${targetPersonaId}
    `) as unknown as WalletRow[];

    if (existing) {
      return NextResponse.json({
        success: true,
        persona_id: targetPersonaId,
        username: persona.username,
        wallet_address: existing.wallet_address,
        status: "already_exists",
      });
    }

    try {
      const [walletCountRow] = (await sql`
        SELECT COUNT(*) as cnt FROM budju_wallets
      `) as unknown as Array<{ cnt: number }>;
      const walletCount = Number(walletCountRow?.cnt ?? 0);
      const distributorGroup = walletCount % DISTRIBUTOR_COUNT;

      const kp = Keypair.generate();
      const walletAddress = kp.publicKey.toBase58();

      await sql`
        INSERT INTO budju_wallets (
          id, persona_id, wallet_address, encrypted_keypair,
          distributor_group, created_at, updated_at
        )
        VALUES (
          ${uuidv4()}, ${targetPersonaId}, ${walletAddress},
          ${encryptKeypair(kp.secretKey)}, ${distributorGroup},
          NOW(), NOW()
        )
      `;

      return NextResponse.json({
        success: true,
        persona_id: targetPersonaId,
        username: persona.username,
        wallet_address: walletAddress,
        status: "created",
      });
    } catch (err) {
      return NextResponse.json({
        success: false,
        persona_id: targetPersonaId,
        username: persona.username,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mode 2: batch — create wallets for every active persona missing one.
  const personasMissingWallets = (await sql`
    SELECT p.id, p.username
    FROM ai_personas p
    LEFT JOIN budju_wallets bw
      ON bw.persona_id = p.id AND bw.is_active = TRUE
    WHERE p.is_active = TRUE AND bw.id IS NULL
    ORDER BY p.id
  `) as unknown as Array<{ id: string; username: string }>;

  const [walletCountRow] = (await sql`
    SELECT COUNT(*) as cnt FROM budju_wallets
  `) as unknown as Array<{ cnt: number }>;
  let walletCount = Number(walletCountRow?.cnt ?? 0);

  const created: Array<{ persona_id: string; username: string; wallet_address: string }> = [];
  const errors: Array<{ persona_id: string; error: string }> = [];

  for (const persona of personasMissingWallets) {
    try {
      const kp = Keypair.generate();
      const walletAddress = kp.publicKey.toBase58();
      const distributorGroup = walletCount % DISTRIBUTOR_COUNT;

      await sql`
        INSERT INTO budju_wallets (
          id, persona_id, wallet_address, encrypted_keypair,
          distributor_group, created_at, updated_at
        )
        VALUES (
          ${uuidv4()}, ${persona.id}, ${walletAddress},
          ${encryptKeypair(kp.secretKey)}, ${distributorGroup},
          NOW(), NOW()
        )
      `;

      created.push({
        persona_id: persona.id,
        username: persona.username,
        wallet_address: walletAddress,
      });
      walletCount++;
    } catch (err) {
      errors.push({
        persona_id: persona.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    success: true,
    total: personasMissingWallets.length,
    created: created.length,
    errors: errors.length,
    details: { created, errors },
  });
}
