/**
 * Admin API — NFT reconciliation tooling.
 *
 * Ported from legacy aiglitch/src/app/api/admin/nfts/route.ts. Used by
 * the admin dashboard to clean up the `minted_nfts` ↔ on-chain Solana
 * state mismatch that happens when:
 *
 *   - the Metaplex mint tx succeeds but the DB row's `mint_tx_hash`
 *     never gets updated past `'pending'`
 *   - a mint tx fails but the DB row stays in place
 *   - an admin needs to manually reassign an existing on-chain NFT
 *     to a different user (support flows)
 *
 * All on-chain interactions are READ-ONLY (`getTransaction`,
 * `getAccountInfo`, `getSignaturesForAddress`) — no signing, no
 * treasury key, no Phase 8 trading exposure. Decision #6's "trading
 * endpoints" lock doesn't apply; this is straight Phase 7 admin work
 * that was waiting on the Solana foundation deps (v1.19.0).
 *
 * Cleanup vs legacy: dropped the dynamic `await import("@solana/web3.js")`
 * inside auto_reconcile. The lazy pattern existed because legacy was
 * trying to defer the heavy web3.js import at module load — but now
 * that `getServerSolanaConnection()` from solana-config already imports
 * the same lib at module top-level, the dynamic import was just adding
 * latency without any tree-shaking benefit. Top-level import is
 * cleaner.
 */

import { type NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { getServerSolanaConnection } from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Extract a base58 tx signature from a raw sig or a Solscan/Explorer URL.
// Accepts: "abc...123" | "https://solscan.io/tx/abc...123" |
//          "https://explorer.solana.com/tx/abc...123"
function extractTxSignature(input: string): string {
  const solscan = input.match(/solscan\.io\/tx\/([A-Za-z0-9]+)/);
  if (solscan) return solscan[1];
  const explorer = input.match(/explorer\.solana\.com\/tx\/([A-Za-z0-9]+)/);
  if (explorer) return explorer[1];
  return input;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const action = request.nextUrl.searchParams.get("action") ?? "list";

  if (action === "list") {
    const nfts = await sql`
      SELECT n.*,
             hu.display_name as owner_name,
             hu.username as owner_username,
             hu.avatar_emoji as owner_emoji
      FROM minted_nfts n
      LEFT JOIN human_users hu
        ON n.owner_type = 'human' AND n.owner_id = hu.session_id
      ORDER BY n.created_at DESC
      LIMIT 200
    `;
    return NextResponse.json({ nfts });
  }

  if (action === "pending") {
    const pending = await sql`
      SELECT n.*,
             hu.display_name as owner_name,
             hu.username as owner_username
      FROM minted_nfts n
      LEFT JOIN human_users hu
        ON n.owner_type = 'human' AND n.owner_id = hu.session_id
      WHERE n.mint_tx_hash = 'pending'
      ORDER BY n.created_at DESC
    `;
    return NextResponse.json({ pending });
  }

  if (action === "lookup_tx") {
    const raw = request.nextUrl.searchParams.get("tx");
    if (!raw) {
      return NextResponse.json({ error: "tx parameter required" }, { status: 400 });
    }
    const txSig = extractTxSignature(raw);

    try {
      const connection = getServerSolanaConnection();
      const txInfo = await connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!txInfo) {
        return NextResponse.json(
          { error: "Transaction not found on Solana", tx: txSig },
          { status: 404 },
        );
      }

      const [existing] = (await sql`
        SELECT id, product_name, owner_id, mint_tx_hash
        FROM minted_nfts WHERE mint_tx_hash = ${txSig}
      `) as unknown as Array<{ id: string; product_name: string; owner_id: string; mint_tx_hash: string }>;

      const [btx] = (await sql`
        SELECT id, memo, status FROM blockchain_transactions
        WHERE tx_hash = ${txSig}
      `) as unknown as Array<{ id: string; memo: string | null; status: string }>;

      return NextResponse.json({
        tx_signature: txSig,
        on_chain: {
          slot: txInfo.slot,
          blockTime: txInfo.blockTime,
          fee: txInfo.meta?.fee,
          success: txInfo.meta?.err === null,
          accounts: txInfo.transaction.message
            .getAccountKeys()
            .staticAccountKeys.map((k) => k.toBase58()),
        },
        db_nft: existing ?? null,
        db_blockchain_tx: btx ?? null,
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Solana lookup failed: ${err instanceof Error ? err.message : "unknown"}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    nft_id?: string;
    tx_signature?: string;
    session_id?: string;
    older_than_hours?: number;
  };
  const { action } = body;

  if (action === "reconcile") {
    const { nft_id } = body;
    if (!nft_id || !body.tx_signature) {
      return NextResponse.json(
        { error: "nft_id and tx_signature required" },
        { status: 400 },
      );
    }
    const txSig = extractTxSignature(body.tx_signature);

    const [nft] = (await sql`
      SELECT id, mint_tx_hash, owner_id, product_name
      FROM minted_nfts WHERE id = ${nft_id}
    `) as unknown as Array<{ id: string; mint_tx_hash: string; owner_id: string; product_name: string }>;
    if (!nft) {
      return NextResponse.json({ error: "NFT not found" }, { status: 404 });
    }

    try {
      const connection = getServerSolanaConnection();
      const txInfo = await connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!txInfo) {
        return NextResponse.json(
          { error: "Transaction not found on Solana" },
          { status: 404 },
        );
      }
      if (txInfo.meta?.err) {
        return NextResponse.json(
          { error: "Transaction failed on-chain", details: txInfo.meta.err },
          { status: 400 },
        );
      }
    } catch (err) {
      return NextResponse.json(
        {
          error: `Solana verification failed: ${err instanceof Error ? err.message : "unknown"}`,
        },
        { status: 500 },
      );
    }

    await sql`
      UPDATE minted_nfts
      SET mint_tx_hash = ${txSig}, mint_block_number = 0
      WHERE id = ${nft_id}
    `;

    return NextResponse.json({
      success: true,
      message: `NFT "${nft.product_name}" reconciled with tx ${txSig}`,
    });
  }

  if (action === "auto_reconcile") {
    const { session_id } = body;

    const pending = (session_id
      ? await sql`
          SELECT id, mint_address, owner_id, product_name, created_at
          FROM minted_nfts
          WHERE mint_tx_hash = 'pending' AND owner_id = ${session_id}
        `
      : await sql`
          SELECT id, mint_address, owner_id, product_name, created_at
          FROM minted_nfts WHERE mint_tx_hash = 'pending'
        `) as unknown as Array<{
      id: string;
      mint_address: string | null;
      owner_id: string;
      product_name: string;
      created_at: string;
    }>;

    if (pending.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending NFTs to reconcile",
        reconciled: 0,
      });
    }

    const connection = getServerSolanaConnection();
    let reconciled = 0;
    const results: Array<{
      nft_id: string;
      product: string;
      status: string;
      tx?: string;
    }> = [];

    for (const nft of pending) {
      try {
        const mintAddress = nft.mint_address;
        if (!mintAddress || mintAddress === "pending") {
          results.push({
            nft_id: nft.id,
            product: nft.product_name,
            status: "no_mint_address",
          });
          continue;
        }

        const mintPubkey = new PublicKey(mintAddress);
        const accountInfo = await connection.getAccountInfo(mintPubkey);

        if (!accountInfo) {
          results.push({
            nft_id: nft.id,
            product: nft.product_name,
            status: "not_minted_on_chain",
          });
          continue;
        }

        // Mint exists on-chain. Find the creation tx (oldest signature).
        const signatures = await connection.getSignaturesForAddress(mintPubkey, {
          limit: 5,
        });
        if (signatures.length === 0) {
          results.push({
            nft_id: nft.id,
            product: nft.product_name,
            status: "mint_exists_no_tx",
          });
          continue;
        }

        const sig = signatures[signatures.length - 1];
        await sql`
          UPDATE minted_nfts
          SET mint_tx_hash = ${sig.signature}, mint_block_number = ${sig.slot ?? 0}
          WHERE id = ${nft.id}
        `;
        reconciled++;
        results.push({
          nft_id: nft.id,
          product: nft.product_name,
          status: "reconciled",
          tx: sig.signature,
        });
      } catch (err) {
        results.push({
          nft_id: nft.id,
          product: nft.product_name,
          status: `error: ${err instanceof Error ? err.message : "unknown"}`,
        });
      }
    }

    return NextResponse.json({
      success: true,
      reconciled,
      total_pending: pending.length,
      results,
    });
  }

  if (action === "assign_by_tx") {
    const { tx_signature, session_id } = body;
    if (!tx_signature || !session_id) {
      return NextResponse.json(
        { error: "tx_signature and session_id required" },
        { status: 400 },
      );
    }
    const txSig = extractTxSignature(tx_signature);

    const [existing] = (await sql`
      SELECT id FROM minted_nfts WHERE mint_tx_hash = ${txSig}
    `) as unknown as Array<{ id: string }>;

    if (!existing) {
      return NextResponse.json(
        {
          error: "No NFT found with this tx signature. Use reconcile for pending NFTs.",
        },
        { status: 404 },
      );
    }

    await sql`
      UPDATE minted_nfts SET owner_id = ${session_id} WHERE id = ${existing.id}
    `;
    return NextResponse.json({
      success: true,
      message: "NFT ownership updated",
      nft_id: existing.id,
    });
  }

  if (action === "cleanup_pending") {
    const hours = body.older_than_hours ?? 24;

    const deleted = (await sql`
      DELETE FROM minted_nfts
      WHERE mint_tx_hash = 'pending'
        AND created_at < NOW() - INTERVAL '1 hour' * ${hours}
      RETURNING id, product_name, owner_id
    `) as unknown as Array<{ id: string; product_name: string; owner_id: string }>;

    // Best-effort cleanup of marketplace_purchases for the orphans. The
    // legacy logic uses a NOT IN subquery that intentionally preserves
    // purchase rows still referenced by non-pending NFTs.
    for (const nft of deleted) {
      await sql`
        DELETE FROM marketplace_purchases
        WHERE session_id = ${nft.owner_id}
          AND product_name = ${nft.product_name}
          AND id NOT IN (
            SELECT mp.id FROM marketplace_purchases mp
            JOIN minted_nfts mn
              ON mp.session_id = mn.owner_id
             AND mp.product_name = mn.product_name
            WHERE mn.mint_tx_hash != 'pending'
          )
      `;
    }

    return NextResponse.json({
      success: true,
      deleted: deleted.length,
      items: deleted,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
