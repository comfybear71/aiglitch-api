/**
 * Admin API — one-click initialization for a single AI persona.
 *
 * Port of legacy aiglitch/src/app/api/admin/init-persona/route.ts.
 * Approved per decision #6 (2026-05-26) — system-custodial of AI
 * persona wallets + AI image generation only. NOT user-custodial.
 *
 * Ensures a persona has:
 *   1. A row in `ai_personas` (read-only — see "Behaviour change" note)
 *   2. Fresh cache (invalidates `personas:active`)
 *   3. A §GLITCH balance (default 1000, matches hatching reward)
 *   4. A Solana wallet in `budju_wallets` (XOR+bs58 encryption matching
 *      v1.29.0 generate-missing-wallets + lib/trading/budju)
 *   5. A Grokified avatar via xAI Image Pro → Vercel Blob
 *
 * NOT included (intentionally — same as legacy):
 *   - Funding the wallet with SOL/BUDJU/USDC (use the distribution UI)
 *   - Trading logic modifications
 *
 * Behaviour changes vs legacy (documented for parity-audit transparency):
 *
 *   1. **No SEED_PERSONAS auto-upsert.** Legacy fell back to a 1027-LOC
 *      personas.ts file with an inline seed array — if the persona row
 *      didn't exist in DB, it'd insert from SEED_PERSONAS. aiglitch-api
 *      doesn't carry that seed file. If the persona doesn't exist in DB,
 *      we return 404 with a hint. To seed a brand-new persona, use the
 *      legacy aiglitch repo's seeding mechanism first, then call this.
 *
 *   2. **No persona-media-library fallback for avatars.** Legacy had a
 *      `generateImage(prompt)` from `lib/media/image-gen` (786 LOC) that
 *      tried a cached persona-media library before falling through to
 *      xAI. aiglitch-api doesn't carry that library yet. If xAI fails
 *      (circuit breaker open, network error, no API key), the avatar
 *      step records a warning and the persona row stays without an
 *      avatar_url. Admin can retry from /admin/personas.
 *
 * Body:
 *   persona_id        : string   (required)
 *   glitch_amount?    : number   (default 1000)
 *   avatar_prompt?    : string   (optional override)
 *   skip_avatar?      : boolean  (default false)
 *   skip_wallet?      : boolean  (default false)
 *   skip_glitch?      : boolean  (default false)
 */

import { type NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cache } from "@/lib/cache";
import { generateImageToBlob } from "@/lib/ai/image";
import { awardPersonaCoins } from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// Round-robin distributor group for downstream BUDJU distribution batching.
// MUST match generate-missing-wallets + lib/trading/budju.
const DISTRIBUTOR_COUNT = 16;

/**
 * XOR cipher keyed on BUDJU_WALLET_SECRET. Byte-identical to:
 *   - /api/admin/personas/generate-missing-wallets (v1.29.0)
 *   - lib/trading/budju.ts (decrypt)
 * Any change breaks cross-route key recovery. Coordinate before touching.
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
  avatar_url: string | null;
}

interface PersonaForPromptRow {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  personality: string | null;
  avatar_url: string | null;
}

interface WalletRow {
  id: string;
  wallet_address: string;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    glitch_amount?: number;
    avatar_prompt?: string;
    skip_avatar?: boolean;
    skip_wallet?: boolean;
    skip_glitch?: boolean;
  };

  const {
    persona_id,
    glitch_amount = 1000,
    avatar_prompt,
    skip_avatar = false,
    skip_wallet = false,
    skip_glitch = false,
  } = body;

  if (!persona_id) {
    return NextResponse.json({ error: "persona_id required" }, { status: 400 });
  }

  const sql = getDb();
  const steps: string[] = [];
  const warnings: string[] = [];
  const report: Record<string, unknown> = {
    persona_id,
    steps,
    warnings,
  };

  // ── Step 1: Verify persona exists in DB ──────────────────────
  // (Legacy fell back to SEED_PERSONAS inline-insert here — see header
  //  "Behaviour change #1" for why we don't.)
  try {
    const [existing] = (await sql`
      SELECT id, username, display_name, avatar_url
      FROM ai_personas WHERE id = ${persona_id}
    `) as unknown as PersonaRow[];

    if (!existing) {
      return NextResponse.json(
        {
          error: `Persona ${persona_id} not found in ai_personas. Seed via legacy first, then re-run.`,
          hint: "aiglitch-api doesn't carry SEED_PERSONAS. If the persona was just added to the legacy seed file, run the cold-start seeding there before calling this route.",
        },
        { status: 404 },
      );
    }

    steps.push(`persona_exists: ${existing.username}`);
    report.persona = {
      id: existing.id,
      username: existing.username,
      display_name: existing.display_name,
      has_avatar: !!existing.avatar_url,
    };
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to look up persona: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  // ── Step 2: Invalidate personas cache ────────────────────────
  try {
    cache.del("personas:active");
    steps.push("cache_invalidated: personas:active");
  } catch (err) {
    warnings.push(
      `cache invalidation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 3: Award §GLITCH balance ────────────────────────────
  if (!skip_glitch) {
    try {
      await awardPersonaCoins(persona_id, glitch_amount);
      steps.push(`glitch_awarded: ${glitch_amount}`);
      report.glitch_balance = glitch_amount;
    } catch (err) {
      warnings.push(
        `GLITCH award failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    steps.push("glitch_skipped");
  }

  // ── Step 4: Create Solana wallet (if not exists) ─────────────
  if (!skip_wallet) {
    try {
      const [existingWallet] = (await sql`
        SELECT id, wallet_address FROM budju_wallets WHERE persona_id = ${persona_id}
      `) as unknown as WalletRow[];

      if (existingWallet) {
        steps.push(`wallet_exists: ${existingWallet.wallet_address}`);
        report.wallet_address = existingWallet.wallet_address;
      } else {
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
            distributor_group, created_at
          )
          VALUES (
            ${uuidv4()}, ${persona_id}, ${walletAddress},
            ${encryptKeypair(kp.secretKey)}, ${distributorGroup}, NOW()
          )
        `;
        steps.push(`wallet_created: ${walletAddress}`);
        report.wallet_address = walletAddress;
        warnings.push(
          "Wallet has zero SOL/BUDJU/USDC balance. Run the next distribution job from /admin/trading to fund it.",
        );
      }
    } catch (err) {
      warnings.push(
        `wallet creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    steps.push("wallet_skipped");
  }

  // ── Step 5: Generate Grokified avatar ────────────────────────
  if (!skip_avatar) {
    try {
      const [personaRow] = (await sql`
        SELECT id, username, display_name, bio, personality, avatar_url
        FROM ai_personas WHERE id = ${persona_id}
      `) as unknown as PersonaForPromptRow[];

      if (personaRow) {
        const prompt = avatar_prompt ?? buildDefaultAvatarPrompt(personaRow);

        try {
          const { blobUrl } = await generateImageToBlob({
            prompt,
            taskType: "image_generation",
            // Aurora Pro = grok-imagine-image-pro. Same model legacy used
            // for high-quality 1:1 portraits via generateImageWithAurora.
            model: "grok-imagine-image-pro",
            aspectRatio: "1:1",
            blobPath: `avatars/${uuidv4()}.png`,
          });

          await sql`
            UPDATE ai_personas
            SET avatar_url = ${blobUrl}, avatar_updated_at = NOW()
            WHERE id = ${persona_id}
          `;
          steps.push("avatar_generated: grok-aurora");
          report.avatar_url = blobUrl;
          report.avatar_source = "grok-aurora";
        } catch (err) {
          // Legacy had a fallback to a cached persona-media library here.
          // aiglitch-api doesn't carry that library yet (~800 LOC port);
          // warn + leave avatar_url untouched. Admin can retry.
          warnings.push(
            `avatar generation failed: ${err instanceof Error ? err.message : String(err)}. ` +
              "Legacy's media-library fallback isn't ported yet — retry from /admin/personas.",
          );
        }
      }
    } catch (err) {
      warnings.push(
        `avatar step failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    steps.push("avatar_skipped");
  }

  return NextResponse.json({ success: true, ...report });
}

/**
 * Default avatar prompt builder. Matches legacy verbatim so the
 * avatars look the same across both backends during the strangler
 * transition (if anyone's diffing them).
 */
function buildDefaultAvatarPrompt(persona: PersonaForPromptRow): string {
  const personalityText = (persona.personality ?? "").slice(0, 150);
  const bioText = (persona.bio ?? "").slice(0, 100);
  return `Professional social media profile picture portrait. A character who is: ${personalityText}. Their vibe: "${bioText}". Style: vibrant, eye-catching, modern social media avatar, 1:1 square crop, centered face/character, colorful background, digital art quality. Include the text "AIG!itch" subtly somewhere in the image.`;
}
