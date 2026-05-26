/**
 * /api/otc-swap — Direct over-the-counter §GLITCH purchases.
 *
 * Port of legacy aiglitch/src/app/api/otc-swap/route.ts. Approved per
 * locked decision #6 (sequential batch 2026-05-26). **REAL on-chain
 * SPL transfers from treasury to buyers in exchange for SOL paid TO
 * treasury.** Highest user-facing risk in the migration.
 *
 * Atomic 3-step transaction (one tx, all-or-nothing):
 *   1. (optional) Create buyer's GLITCH ATA if missing
 *   2. Buyer sends SOL → treasury
 *   3. Treasury sends GLITCH → buyer
 *
 * Treasury partially signs server-side (authorizes the GLITCH transfer),
 * buyer signs from Phantom (authorizes the SOL transfer), then submits.
 * Either both sides settle or neither does — no half-swaps.
 *
 * Safety layers (preserved verbatim from legacy):
 *   - Per-wallet rate limit: 5 swaps / minute (in-memory map)
 *   - Per-wallet 24h SOL cap: 0.5 SOL (DB-aggregated from otc_swaps)
 *   - Treasury keypair MUST derive to TREASURY_WALLET_STR (env-key
 *     drift guard — refuses to sign with a stale key)
 *   - Transaction expires in 120s (buyer can't sit on a stale swap)
 *   - On-chain confirmation gate before marking 'completed' in DB
 *   - Bonding curve = function of total GLITCH already sold (price
 *     rises with demand; cannot be gamed mid-tx)
 *
 * Endpoints:
 *   GET  ?action=config              — bonding curve + supply + limits
 *   GET  ?action=history&wallet=...  — wallet's swap history
 *   POST { action: "create_swap", buyer_wallet, glitch_amount }
 *                                    — returns unsigned tx (base64)
 *   POST { action: "submit_swap", swap_id, signed_transaction }
 *                                    — submits buyer-signed tx to chain
 *   POST { action: "confirm_swap", swap_id, tx_signature }
 *                                    — verifies on-chain status of an
 *                                      already-submitted tx
 *   POST { action: "set_price", admin_wallet, price_sol }
 *                                    — admin override of OTC price
 *
 * Drops `ensureDbReady` per CLAUDE.md migration rule #4. Drops the
 * unused `SERVER_RPC_URL` import (legacy imported but never referenced).
 * `SOLANA_NETWORK` console-log usage → `getSolanaNetwork()` calls.
 *
 * **Vercel env vars required on api.aiglitch.app (NOT legacy) before
 * the strangler flips:**
 *   - TREASURY_PRIVATE_KEY  (base58 or JSON array)
 *   - ADMIN_TOKEN           (for set_price admin path)
 *   - NEXT_PUBLIC_SOLANA_REAL_MODE / Helius key for the RPC connection
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";
import {
  ADMIN_WALLET_STR,
  GLITCH_TOKEN_MINT_STR,
  TREASURY_WALLET_STR,
  getServerSolanaConnection,
  getSolanaNetwork,
} from "@/lib/solana-config";
import { OTC } from "@/lib/bible/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ── Bonding curve (constants sourced from bible OTC config) ─────────
const BONDING_CURVE = {
  BASE_PRICE_USD: OTC.basePriceUsd,
  INCREMENT_USD: OTC.incrementUsd,
  TIER_SIZE: OTC.tierSize,
};

function calculateBondingCurvePrice(totalGlitchSold: number, solPriceUsd: number) {
  const tier = Math.floor(totalGlitchSold / BONDING_CURVE.TIER_SIZE);
  const priceUsd = BONDING_CURVE.BASE_PRICE_USD + tier * BONDING_CURVE.INCREMENT_USD;
  const priceSol = solPriceUsd > 0 ? priceUsd / solPriceUsd : 0;
  const nextTierAt = (tier + 1) * BONDING_CURVE.TIER_SIZE;
  const remainingInTier = nextTierAt - totalGlitchSold;
  const nextPriceUsd = priceUsd + BONDING_CURVE.INCREMENT_USD;

  return {
    price_usd: priceUsd,
    price_sol: priceSol,
    tier,
    next_tier_at: nextTierAt,
    remaining_in_tier: remainingInTier,
    next_price_usd: nextPriceUsd,
    next_price_sol: solPriceUsd > 0 ? nextPriceUsd / solPriceUsd : 0,
  };
}

// ── ATA detection (Token + Token-2022 support) ──────────────────────
// Detects which token program owns the mint, then derives + verifies
// the buyer/treasury ATA under that program. Falls back to the other
// program if the first guess doesn't pan out. Returns null only when
// the mint itself doesn't exist on the configured network.
async function findTokenAccountForMint(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<{ address: PublicKey; tokenProgram: PublicKey; exists: boolean } | null> {
  console.log(
    `findTokenAccountForMint: network=${getSolanaNetwork()}, owner=${owner.toBase58()}, mint=${mint.toBase58()}`,
  );
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    console.error(
      `Mint account ${mint.toBase58()} NOT FOUND on ${getSolanaNetwork()}! ` +
        "Network mismatch? Token may only exist on mainnet-beta.",
    );
    return null;
  }

  const detectedProgram = mintInfo.owner;
  console.log(
    `Mint ${mint.toBase58()} owned by program: ${detectedProgram.toBase58()}`,
  );

  const programsToTry = detectedProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const tokenProgram of programsToTry) {
    try {
      const ata = await getAssociatedTokenAddress(
        mint,
        owner,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const ataInfo = await connection.getAccountInfo(ata);
      if (ataInfo) {
        return { address: ata, tokenProgram, exists: true };
      }
      // ATA derives but doesn't exist yet — that's OK if it's under the
      // mint-detected program (we'll create it).
      if (tokenProgram.equals(detectedProgram)) {
        return { address: ata, tokenProgram, exists: false };
      }
    } catch (err) {
      console.warn(
        `Error checking ATA under ${tokenProgram.toBase58()}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return null;
}

// ── Treasury keypair ────────────────────────────────────────────────
function getTreasuryKeypair(): Keypair | null {
  const keyStr = process.env.TREASURY_PRIVATE_KEY;
  if (!keyStr) return null;
  try {
    const trimmed = keyStr.trim();
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (err) {
    console.error("Failed to parse TREASURY_PRIVATE_KEY:", err);
    return null;
  }
}

// ── In-memory per-wallet rate limiter ───────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(wallet: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(wallet);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(wallet, { count: 1, resetAt: now + OTC.rateLimitWindowMs });
    return true;
  }
  if (entry.count >= OTC.rateLimitSwapsPerMin) return false;
  entry.count++;
  return true;
}

/** Test-only helper to reset the rate limiter map between specs. */
export function __resetOtcRateLimit(): void {
  rateLimitMap.clear();
}

// ── GET handler ─────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const sql = getDb();

  if (action === "config") {
    // Clean up stale pending swaps (> 5 min old).
    try {
      await sql`
        UPDATE otc_swaps SET status = 'expired'
        WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
      `;
    } catch {
      /* table may not exist on first deploy — non-fatal */
    }

    const [solSetting] = (await sql`
      SELECT value FROM platform_settings WHERE key = 'sol_price_usd'
    `.catch(() => [null])) as unknown as Array<{ value: string } | null>;
    const solPriceUsd = parseFloat(solSetting?.value ?? "164");

    let availableSupply = 0;
    let rpcError = "";
    try {
      const connection = getServerSolanaConnection();
      const treasuryPubkey = new PublicKey(TREASURY_WALLET_STR);
      const glitchMint = new PublicKey(GLITCH_TOKEN_MINT_STR);
      const treasuryAccount = await findTokenAccountForMint(
        connection,
        treasuryPubkey,
        glitchMint,
      );
      if (treasuryAccount && treasuryAccount.exists) {
        const accountInfo = await connection.getTokenAccountBalance(
          treasuryAccount.address,
        );
        availableSupply = parseFloat(accountInfo.value.uiAmountString ?? "0");
      } else {
        rpcError = treasuryAccount
          ? "Treasury ATA exists=false"
          : "Treasury GLITCH token account not found";
        availableSupply = 30_000_000;
      }
    } catch (err) {
      rpcError = err instanceof Error ? err.message : "RPC failed";
      availableSupply = 30_000_000;
    }

    const hasPrivateKey = !!process.env.TREASURY_PRIVATE_KEY;

    let totalSwaps = 0;
    let totalGlitchSold = 0;
    let totalSolReceived = 0;
    try {
      const [stats] = (await sql`
        SELECT COUNT(*) as total,
               COALESCE(SUM(glitch_amount), 0) as glitch_sold,
               COALESCE(SUM(sol_cost), 0) as sol_received
        FROM otc_swaps WHERE status = 'completed'
      `) as unknown as Array<{ total: number; glitch_sold: number; sol_received: number }>;
      totalSwaps = Number(stats.total);
      totalGlitchSold = Number(stats.glitch_sold);
      totalSolReceived = Number(stats.sol_received);
    } catch {
      /* table may not exist yet */
    }

    const curve = calculateBondingCurvePrice(totalGlitchSold, solPriceUsd);

    return NextResponse.json({
      enabled: hasPrivateKey,
      price_sol: curve.price_sol,
      price_usd: curve.price_usd,
      sol_price_usd: solPriceUsd,
      available_supply: availableSupply,
      min_purchase: OTC.minPurchase,
      max_purchase: OTC.maxPurchase,
      treasury_wallet: TREASURY_WALLET_STR,
      treasury_sol: totalSolReceived,
      token_mint: GLITCH_TOKEN_MINT_STR,
      stats: {
        total_swaps: totalSwaps,
        total_glitch_sold: totalGlitchSold,
        total_sol_received: totalSolReceived,
      },
      bonding_curve: {
        tier: curve.tier,
        tier_size: BONDING_CURVE.TIER_SIZE,
        remaining_in_tier: curve.remaining_in_tier,
        next_price_usd: curve.next_price_usd,
        next_price_sol: curve.next_price_sol,
        base_price_usd: BONDING_CURVE.BASE_PRICE_USD,
        increment_usd: BONDING_CURVE.INCREMENT_USD,
      },
      ...(rpcError ? { rpc_note: rpcError } : {}),
      network: getSolanaNetwork(),
    });
  }

  if (action === "history") {
    const wallet = request.nextUrl.searchParams.get("wallet");
    if (!wallet) {
      return NextResponse.json(
        { error: "Missing wallet parameter" },
        { status: 400 },
      );
    }
    try {
      const swaps = await sql`
        SELECT id, glitch_amount, sol_cost, price_per_glitch, tx_signature,
               status, created_at, completed_at
        FROM otc_swaps
        WHERE buyer_wallet = ${wallet} AND status IN ('completed', 'submitted')
        ORDER BY created_at DESC LIMIT 50
      `;
      return NextResponse.json({ swaps });
    } catch {
      return NextResponse.json({ swaps: [] });
    }
  }

  return NextResponse.json(
    { error: "Invalid action. Use ?action=config or ?action=history&wallet=..." },
    { status: 400 },
  );
}

// ── POST handler ────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action as string | undefined;
  const sql = getDb();

  // ── create_swap: build atomic 3-instruction tx, treasury partial-signs ──
  if (action === "create_swap") {
    const buyer_wallet = body.buyer_wallet as string | undefined;
    const glitch_amount = body.glitch_amount as number | string | undefined;

    if (!buyer_wallet || glitch_amount === undefined) {
      return NextResponse.json(
        { error: "Missing buyer_wallet or glitch_amount" },
        { status: 400 },
      );
    }

    let buyerPubkey: PublicKey;
    try {
      buyerPubkey = new PublicKey(buyer_wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const amount = parseFloat(String(glitch_amount));
    if (isNaN(amount) || amount < OTC.minPurchase) {
      return NextResponse.json(
        { error: `Minimum purchase is ${OTC.minPurchase} §GLITCH` },
        { status: 400 },
      );
    }
    if (amount > OTC.maxPurchase) {
      return NextResponse.json(
        { error: `Maximum purchase is ${OTC.maxPurchase.toLocaleString()} §GLITCH per swap` },
        { status: 400 },
      );
    }

    if (!checkRateLimit(buyer_wallet)) {
      return NextResponse.json(
        { error: "Too many swap requests. Wait a moment." },
        { status: 429 },
      );
    }

    // Daily 0.5 SOL spend cap per wallet (over completed + submitted).
    try {
      const [daily] = (await sql`
        SELECT COALESCE(SUM(sol_cost), 0) as total_sol
        FROM otc_swaps
        WHERE buyer_wallet = ${buyer_wallet}
          AND status IN ('completed', 'submitted')
          AND created_at > NOW() - INTERVAL '24 hours'
      `) as unknown as Array<{ total_sol: number }>;
      const dailySpent = Number(daily?.total_sol ?? 0);
      if (dailySpent >= OTC.dailySolLimit) {
        return NextResponse.json(
          {
            error: `Daily limit reached. You've spent ${dailySpent.toFixed(4)} SOL in the last 24h (max ${OTC.dailySolLimit} SOL/day). Try again later.`,
            daily_limit: OTC.dailySolLimit,
            daily_spent: dailySpent,
          },
          { status: 429 },
        );
      }
    } catch {
      /* table may not exist yet, allow through */
    }

    const treasuryKeypair = getTreasuryKeypair();
    if (!treasuryKeypair) {
      return NextResponse.json(
        {
          error: "OTC swaps not available yet. Treasury key not configured.",
          setup_needed: true,
        },
        { status: 503 },
      );
    }

    // Env-key-drift guard — refuse to sign with a stale key.
    if (treasuryKeypair.publicKey.toBase58() !== TREASURY_WALLET_STR) {
      console.error(
        "Treasury keypair mismatch! Expected:",
        TREASURY_WALLET_STR,
        "Got:",
        treasuryKeypair.publicKey.toBase58(),
      );
      return NextResponse.json({ error: "Treasury configuration error" }, { status: 500 });
    }

    const [solSetting] = (await sql`
      SELECT value FROM platform_settings WHERE key = 'sol_price_usd'
    `.catch(() => [null])) as unknown as Array<{ value: string } | null>;
    const solPriceUsd = parseFloat(solSetting?.value ?? "164");

    let totalGlitchSold = 0;
    try {
      const [stats] = (await sql`
        SELECT COALESCE(SUM(glitch_amount), 0) as glitch_sold
        FROM otc_swaps WHERE status = 'completed'
      `) as unknown as Array<{ glitch_sold: number }>;
      totalGlitchSold = Number(stats.glitch_sold);
    } catch {
      /* table may not exist yet */
    }

    const curve = calculateBondingCurvePrice(totalGlitchSold, solPriceUsd);
    const priceSol = curve.price_sol;
    const solCost = amount * priceSol;
    const solCostLamports = Math.ceil(solCost * LAMPORTS_PER_SOL);
    const glitchAmountRaw = Math.floor(amount * 1e9); // 9 decimals

    if (solCostLamports < OTC.minOrderLamports) {
      return NextResponse.json({ error: "Order too small" }, { status: 400 });
    }

    try {
      const connection = getServerSolanaConnection();
      const glitchMint = new PublicKey(GLITCH_TOKEN_MINT_STR);
      const treasuryPubkey = treasuryKeypair.publicKey;

      const treasuryAccount = await findTokenAccountForMint(
        connection,
        treasuryPubkey,
        glitchMint,
      );
      if (!treasuryAccount || !treasuryAccount.exists) {
        console.error(
          "Treasury GLITCH ATA not found or doesn't exist on-chain!",
          treasuryAccount
            ? {
                derived_ata: treasuryAccount.address.toBase58(),
                token_program: treasuryAccount.tokenProgram.toBase58(),
                exists: treasuryAccount.exists,
              }
            : "null",
        );
        return NextResponse.json(
          { error: "Treasury GLITCH token account not found on-chain. Contact admin." },
          { status: 500 },
        );
      }

      const treasuryAta = treasuryAccount.address;
      const tokenProgram = treasuryAccount.tokenProgram;

      const buyerAccount = await findTokenAccountForMint(
        connection,
        buyerPubkey,
        glitchMint,
      );
      const buyerAta = buyerAccount
        ? buyerAccount.address
        : await getAssociatedTokenAddress(
            glitchMint,
            buyerPubkey,
            false,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          );
      const buyerAtaExists = buyerAccount?.exists ?? false;

      try {
        const treasuryBalance = await connection.getTokenAccountBalance(treasuryAta);
        const available = parseFloat(treasuryBalance.value.uiAmountString ?? "0");
        if (available < amount) {
          return NextResponse.json(
            {
              error: `Not enough §GLITCH in treasury. Available: ${available.toLocaleString()}`,
              available_supply: available,
            },
            { status: 400 },
          );
        }
      } catch (balErr) {
        console.warn(
          "Could not check treasury balance:",
          balErr instanceof Error ? balErr.message : balErr,
        );
      }

      const tx = new Transaction();

      if (!buyerAtaExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            buyerPubkey,
            buyerAta,
            buyerPubkey,
            glitchMint,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }

      tx.add(
        SystemProgram.transfer({
          fromPubkey: buyerPubkey,
          toPubkey: treasuryPubkey,
          lamports: solCostLamports,
        }),
      );

      tx.add(
        createTransferInstruction(
          treasuryAta,
          buyerAta,
          treasuryPubkey,
          BigInt(glitchAmountRaw),
          [],
          tokenProgram,
        ),
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = buyerPubkey;

      // Treasury partial-signs (authorizes the GLITCH transfer);
      // buyer signs the SOL transfer + ATA-create in Phantom.
      tx.partialSign(treasuryKeypair);

      const swapId = uuidv4();
      await sql`
        INSERT INTO otc_swaps (id, buyer_wallet, glitch_amount, sol_cost, price_per_glitch, status, blockhash, created_at)
        VALUES (${swapId}, ${buyer_wallet}, ${amount}, ${solCost}, ${priceSol}, 'pending', ${blockhash}, NOW())
      `;

      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });

      return NextResponse.json({
        success: true,
        swap_id: swapId,
        transaction: serialized.toString("base64"),
        glitch_amount: amount,
        sol_cost: solCost,
        price_per_glitch: priceSol,
        expires_at: new Date(Date.now() + OTC.txExpiryMs).toISOString(),
      });
    } catch (err) {
      console.error("OTC swap creation error:", err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: `Swap failed: ${msg}` }, { status: 500 });
    }
  }

  // ── submit_swap: forward buyer-signed tx to chain ──
  if (action === "submit_swap") {
    const swap_id = body.swap_id as string | undefined;
    const signed_transaction = body.signed_transaction as string | undefined;
    if (!swap_id || !signed_transaction) {
      return NextResponse.json(
        { error: "Missing swap_id or signed_transaction" },
        { status: 400 },
      );
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(swap_id)) {
      return NextResponse.json({ error: "Invalid swap ID" }, { status: 400 });
    }

    const [pendingSwap] = (await sql`
      SELECT id, created_at FROM otc_swaps
      WHERE id = ${swap_id} AND status = 'pending'
    `) as unknown as Array<{ id: string; created_at: string }>;
    if (!pendingSwap) {
      return NextResponse.json(
        { error: "Swap not found or already processed" },
        { status: 404 },
      );
    }
    const swapAge = Date.now() - new Date(pendingSwap.created_at).getTime();
    if (swapAge > OTC.txExpiryMs) {
      await sql`UPDATE otc_swaps SET status = 'expired' WHERE id = ${swap_id} AND status = 'pending'`;
      return NextResponse.json(
        { error: "Swap expired. Please create a new one." },
        { status: 410 },
      );
    }

    try {
      const connection = getServerSolanaConnection();
      const txBuf = Buffer.from(signed_transaction, "base64");

      const txid = await connection.sendRawTransaction(txBuf, {
        skipPreflight: false,
        maxRetries: 3,
      });
      console.log(`OTC swap ${swap_id} submitted: ${txid}`);

      let confirmed = false;
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
          "confirmed",
        );
        const confirmation = await connection.confirmTransaction(
          { signature: txid, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        if (confirmation.value.err) {
          console.error(`TX ${txid} confirmed but FAILED on-chain:`, confirmation.value.err);
          await sql`
            UPDATE otc_swaps
            SET status = 'failed', tx_signature = ${txid}, completed_at = NOW()
            WHERE id = ${swap_id} AND status = 'pending'
          `;
          return NextResponse.json(
            { error: `Transaction failed on-chain. TX: ${txid}`, tx_signature: txid },
            { status: 400 },
          );
        }
        confirmed = true;
        console.log(`OTC swap ${swap_id} CONFIRMED on-chain: ${txid}`);
      } catch (confirmErr) {
        console.warn(
          `TX ${txid} confirmation timeout:`,
          confirmErr instanceof Error ? confirmErr.message : confirmErr,
        );
      }

      await sql`
        UPDATE otc_swaps
        SET status = ${confirmed ? "completed" : "submitted"},
            tx_signature = ${txid}, completed_at = NOW()
        WHERE id = ${swap_id} AND status = 'pending'
      `;

      // Mirror into exchange_orders for unified trade history.
      try {
        const [swap] = (await sql`
          SELECT * FROM otc_swaps WHERE id = ${swap_id}
        `) as unknown as Array<{
          buyer_wallet: string;
          glitch_amount: number;
          sol_cost: number;
          price_per_glitch: number;
        }>;
        if (swap) {
          const orderId = uuidv4();
          await sql`
            INSERT INTO exchange_orders (id, session_id, wallet_address, order_type, amount, price_per_coin, total_sol, trading_pair, base_token, quote_token, quote_amount, status, created_at)
            VALUES (${orderId}, ${swap.buyer_wallet}, ${swap.buyer_wallet}, 'buy', ${swap.glitch_amount}, ${swap.price_per_glitch}, ${swap.sol_cost}, 'GLITCH_SOL', 'GLITCH', 'SOL', ${swap.sol_cost}, 'filled', NOW())
          `;
        }
      } catch {
        /* non-critical — swap still completed */
      }

      return NextResponse.json({
        success: true,
        swap_id,
        tx_signature: txid,
        confirmed,
        message: confirmed
          ? "Swap confirmed on-chain! §GLITCH tokens are in your wallet."
          : "Swap submitted — confirming on-chain. Check Solscan for status.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Submission failed";
      console.error("TX submission error:", msg);
      return NextResponse.json({ error: `Transaction failed: ${msg}` }, { status: 500 });
    }
  }

  // ── confirm_swap: verify on-chain status of an already-submitted tx ──
  if (action === "confirm_swap") {
    const swap_id = body.swap_id as string | undefined;
    const tx_signature = body.tx_signature as string | undefined;
    if (!swap_id || !tx_signature) {
      return NextResponse.json(
        { error: "Missing swap_id or tx_signature" },
        { status: 400 },
      );
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(swap_id)) {
      return NextResponse.json({ error: "Invalid swap ID" }, { status: 400 });
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(tx_signature)) {
      return NextResponse.json({ error: "Invalid transaction signature" }, { status: 400 });
    }

    const [swap] = (await sql`
      SELECT id, buyer_wallet, status FROM otc_swaps WHERE id = ${swap_id}
    `) as unknown as Array<{ id: string; buyer_wallet: string; status: string }>;
    if (!swap) {
      return NextResponse.json({ error: "Swap not found" }, { status: 404 });
    }
    if (swap.status === "completed") {
      return NextResponse.json({ success: true, swap_id, message: "Already confirmed." });
    }
    if (swap.status !== "pending" && swap.status !== "submitted") {
      return NextResponse.json(
        { error: "Swap is not in a confirmable state" },
        { status: 400 },
      );
    }

    try {
      const connection = getServerSolanaConnection();
      const txInfo = await connection.getTransaction(tx_signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!txInfo) {
        return NextResponse.json(
          {
            error: "Transaction not found on-chain. It may still be processing.",
            status: "pending",
          },
          { status: 202 },
        );
      }

      if (txInfo.meta?.err) {
        await sql`
          UPDATE otc_swaps
          SET status = 'failed', tx_signature = ${tx_signature}, completed_at = NOW()
          WHERE id = ${swap_id}
        `;
        return NextResponse.json(
          { error: "Transaction failed on-chain", tx_signature },
          { status: 400 },
        );
      }

      await sql`
        UPDATE otc_swaps
        SET status = 'completed', tx_signature = ${tx_signature}, completed_at = NOW()
        WHERE id = ${swap_id} AND status IN ('pending', 'submitted')
      `;

      return NextResponse.json({
        success: true,
        swap_id,
        tx_signature,
        message: "Swap verified on-chain and confirmed!",
      });
    } catch (err) {
      console.error("On-chain verification failed:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "Could not verify transaction on-chain. Try again shortly." },
        { status: 503 },
      );
    }
  }

  // ── set_price (admin only) ──
  if (action === "set_price") {
    const price_sol = body.price_sol as number | string | undefined;
    const admin_wallet = body.admin_wallet as string | undefined;
    const adminToken = request.headers.get("x-admin-token");
    const isAdminAuth = adminToken === process.env.ADMIN_TOKEN;
    const isAdminWallet = admin_wallet === ADMIN_WALLET_STR;

    if (!isAdminAuth && !isAdminWallet) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }
    const newPrice = parseFloat(String(price_sol));
    if (!newPrice || newPrice <= 0 || !isFinite(newPrice)) {
      return NextResponse.json({ error: "Invalid price" }, { status: 400 });
    }

    await sql`
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES ('otc_glitch_price_sol', ${String(newPrice)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${String(newPrice)}, updated_at = NOW()
    `;

    return NextResponse.json({
      success: true,
      new_price_sol: newPrice,
      message: `OTC price updated to ${newPrice} SOL per §GLITCH`,
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
