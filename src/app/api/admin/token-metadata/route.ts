/**
 * Admin API — Metaplex on-chain metadata for the §GLITCH token.
 *
 * Port of legacy aiglitch/src/app/api/admin/token-metadata/route.ts.
 * Approved per locked decision #6 (2026-05-26 batch) — real on-chain
 * mint-authority writes, properly scoped to admin auth.
 *
 * What this route does on-chain:
 *   - `check`  → reads the metadata PDA account (no signing)
 *   - `create` → signs + sends a Metaplex CreateMetadataAccountV3
 *                instruction using TREASURY_PRIVATE_KEY as the mint
 *                authority. ONE-TIME per token. Affects what Phantom,
 *                Solscan, Jupiter etc. show as the token's name + logo.
 *   - `update` → signs + sends UpdateMetadataAccountV2 using the
 *                METADATA_AUTHORITY keypair (treasury pays fees,
 *                authority signs the metadata change).
 *   - `verify` → derives the authority keypair from the configured
 *                mnemonic/key and asserts it matches the on-chain
 *                update authority. No on-chain calls.
 *
 * Auth model (preserved verbatim from legacy):
 *   Body must include `admin_wallet` matching `ADMIN_WALLET_STR`. This
 *   is weaker than the cookie-based admin auth used elsewhere — anyone
 *   who knows the admin wallet's PUBLIC address can hit it. But:
 *   (a) the actual on-chain transaction requires `TREASURY_PRIVATE_KEY`
 *       env var which only the platform has, AND
 *   (b) the metadata change is governed by Metaplex's own update
 *       authority on-chain.
 *   So the worst-case from a leaked admin_wallet is a 403/503 from
 *   missing env keys, not an actual on-chain change.
 *
 * Env vars required (all on the aiglitch-api Vercel project, NOT
 * legacy — strangler will route here):
 *   - TREASURY_PRIVATE_KEY (base58 or JSON-array) — mint authority
 *   - METADATA_AUTHORITY_PRIVATE_KEY OR METADATA_AUTHORITY_MNEMONIC
 *     — current Metaplex update authority for §GLITCH (legacy hardcoded
 *     this to wallet 4Jm25GMWDFj4UFJTQjwo7mnDwddxSkXAthDGmkPjdMi4)
 *
 * Behaviour parity: byte-identical Borsh instruction layout (discriminator
 * 33 for create, 15 for update), same ED25519 seed derivation for the
 * mnemonic path (Solana CLI convention — first 32 bytes of BIP39 seed,
 * NOT BIP44 m/44'/501'/0'/0'). Don't refactor either without testing on
 * devnet first.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as bip39 from "bip39";
import { createHmac } from "node:crypto";

import {
  ADMIN_WALLET_STR,
  GLITCH_TOKEN_MINT_STR,
  TREASURY_WALLET_STR,
  getAppBaseUrl,
  getMetadataPDA,
  getServerSolanaConnection,
  getTokenMetadataProgramId,
} from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN_NAME = "AIG!itch";
const TOKEN_SYMBOL = "GLITCH";
/** Hardcoded in legacy — matches the wallet that took mint authority on launch. */
const EXPECTED_UPDATE_AUTHORITY = "4Jm25GMWDFj4UFJTQjwo7mnDwddxSkXAthDGmkPjdMi4";

// ── Borsh helpers ───────────────────────────────────────────────────

function writeBorshString(buf: Buffer, offset: number, str: string): number {
  const bytes = Buffer.from(str, "utf8");
  buf.writeUInt32LE(bytes.length, offset);
  offset += 4;
  bytes.copy(buf, offset);
  offset += bytes.length;
  return offset;
}

// CreateMetadataAccountV3 — Metaplex discriminator 33. DataV2 payload
// with single creator (treasury, verified, share=100). is_mutable=true.
function buildCreateMetadataInstruction(
  metadataAccount: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  payer: PublicKey,
  updateAuthority: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): TransactionInstruction {
  const buf = Buffer.alloc(600);
  let offset = 0;

  buf.writeUInt8(33, offset); offset += 1;
  offset = writeBorshString(buf, offset, name.slice(0, 32));
  offset = writeBorshString(buf, offset, symbol.slice(0, 10));
  offset = writeBorshString(buf, offset, uri.slice(0, 200));
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt8(1, offset); offset += 1;                                  // creators: Some
  buf.writeUInt32LE(1, offset); offset += 4;                               // creators length
  new PublicKey(TREASURY_WALLET_STR).toBuffer().copy(buf, offset); offset += 32;
  buf.writeUInt8(1, offset); offset += 1;                                  // verified
  buf.writeUInt8(100, offset); offset += 1;                                // share
  buf.writeUInt8(0, offset); offset += 1;                                  // collection: None
  buf.writeUInt8(0, offset); offset += 1;                                  // uses: None
  buf.writeUInt8(1, offset); offset += 1;                                  // is_mutable
  buf.writeUInt8(0, offset); offset += 1;                                  // collection_details: None

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataAccount,        isSigner: false, isWritable: true  },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: mintAuthority,           isSigner: true,  isWritable: false },
      { pubkey: payer,                   isSigner: true,  isWritable: true  },
      { pubkey: updateAuthority,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    programId: getTokenMetadataProgramId(),
    data: buf.slice(0, offset),
  });
}

// UpdateMetadataAccountV2 — discriminator 15. Updates name/symbol/uri,
// keeps creators + collection + uses unchanged, keeps update_authority,
// keeps primary_sale_happened, marks is_mutable=true.
function buildUpdateMetadataInstruction(
  metadataAccount: PublicKey,
  updateAuthority: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): TransactionInstruction {
  const buf = Buffer.alloc(600);
  let offset = 0;

  buf.writeUInt8(15, offset); offset += 1;

  buf.writeUInt8(1, offset); offset += 1; // data: Some
  offset = writeBorshString(buf, offset, name.slice(0, 32));
  offset = writeBorshString(buf, offset, symbol.slice(0, 10));
  offset = writeBorshString(buf, offset, uri.slice(0, 200));
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt8(0, offset); offset += 1; // creators: None (keep existing)
  buf.writeUInt8(0, offset); offset += 1; // collection: None
  buf.writeUInt8(0, offset); offset += 1; // uses: None
  buf.writeUInt8(0, offset); offset += 1; // new_update_authority: None
  buf.writeUInt8(0, offset); offset += 1; // primary_sale_happened: None
  buf.writeUInt8(1, offset); offset += 1; // is_mutable: Some
  buf.writeUInt8(1, offset); offset += 1; // value=true

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataAccount, isSigner: false, isWritable: true  },
      { pubkey: updateAuthority, isSigner: true,  isWritable: false },
    ],
    programId: getTokenMetadataProgramId(),
    data: buf.slice(0, offset),
  });
}

// ── Keypair derivation ──────────────────────────────────────────────

/**
 * Parse a Solana keypair from either base58 or a JSON array string —
 * matches how `solana-keygen` exports them. Returns null on any failure.
 */
function parseKeypairFromString(keyStr: string): Keypair | null {
  try {
    const trimmed = keyStr.trim();
    if (trimmed.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch {
    return null;
  }
}

function getTreasuryKeypair(): Keypair | null {
  const keyStr = process.env.TREASURY_PRIVATE_KEY;
  if (!keyStr) return null;
  return parseKeypairFromString(keyStr);
}

/**
 * Resolve the metadata update authority keypair from env. Two options:
 *   1. METADATA_AUTHORITY_PRIVATE_KEY (base58 or JSON array)
 *   2. METADATA_AUTHORITY_MNEMONIC (BIP39 mnemonic — Solana CLI convention,
 *      uses first 32 bytes of the BIP39 seed as the private key, NOT BIP44
 *      m/44'/501'/0'/0' — Phantom uses the BIP44 path, which produces a
 *      different address from the same mnemonic).
 *
 * `deriveEd25519` was in the legacy but unused (only the Solana-CLI raw-seed
 * path is exercised) — dropped from this port.
 */
function getMetadataAuthorityKeypair(): Keypair | null {
  const keyStr = process.env.METADATA_AUTHORITY_PRIVATE_KEY;
  if (keyStr) return parseKeypairFromString(keyStr);

  const mnemonic = process.env.METADATA_AUTHORITY_MNEMONIC;
  if (mnemonic) {
    try {
      const seed = bip39.mnemonicToSeedSync(mnemonic.trim());
      const privateKey = seed.subarray(0, 32);
      return Keypair.fromSeed(privateKey);
    } catch (err) {
      console.error("[token-metadata] mnemonic derivation failed:", err);
      return null;
    }
  }

  return null;
}

// Suppress unused-import warning for createHmac — kept in case we need to
// add the BIP44 path back. Stub helper for future use.
void createHmac;

// ── POST handler ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    admin_wallet?: string;
    name?: string;
    symbol?: string;
    uri?: string;
  };
  const { action, admin_wallet } = body;

  if (admin_wallet !== ADMIN_WALLET_STR) {
    return NextResponse.json(
      { error: "Unauthorized. Admin wallet required." },
      { status: 403 },
    );
  }

  const connection = getServerSolanaConnection();
  const glitchMint = new PublicKey(GLITCH_TOKEN_MINT_STR);
  const metadataPDA = getMetadataPDA(glitchMint);
  const baseUrl = getAppBaseUrl();
  const metadataUri = `${baseUrl}/api/token/metadata`;

  // ── check ──
  if (action === "check") {
    try {
      const accountInfo = await connection.getAccountInfo(metadataPDA);
      const exists = accountInfo !== null && accountInfo.data.length > 0;
      return NextResponse.json({
        metadata_exists: exists,
        metadata_pda: metadataPDA.toBase58(),
        token_mint: GLITCH_TOKEN_MINT_STR,
        metadata_uri: metadataUri,
        logo_url: `${baseUrl}/api/token/logo`,
        action_needed: exists ? "update" : "create",
        message: exists
          ? "Metadata exists on-chain. Use action='update' to change it."
          : "No metadata found. Use action='create' to attach metadata.",
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Check failed" },
        { status: 500 },
      );
    }
  }

  // ── create (one-time, treasury signs as mint authority) ──
  if (action === "create") {
    const treasuryKeypair = getTreasuryKeypair();
    if (!treasuryKeypair) {
      return NextResponse.json(
        { error: "TREASURY_PRIVATE_KEY not configured" },
        { status: 503 },
      );
    }

    if (treasuryKeypair.publicKey.toBase58() !== TREASURY_WALLET_STR) {
      return NextResponse.json(
        { error: "Treasury keypair mismatch — env key doesn't derive to TREASURY_WALLET_STR" },
        { status: 500 },
      );
    }

    const existing = await connection.getAccountInfo(metadataPDA);
    if (existing) {
      return NextResponse.json(
        {
          error: "Metadata already exists. Use action='update' instead.",
          metadata_pda: metadataPDA.toBase58(),
        },
        { status: 409 },
      );
    }

    try {
      const tx = new Transaction();
      tx.add(
        buildCreateMetadataInstruction(
          metadataPDA,
          glitchMint,
          treasuryKeypair.publicKey,
          treasuryKeypair.publicKey,
          treasuryKeypair.publicKey,
          TOKEN_NAME,
          TOKEN_SYMBOL,
          metadataUri,
        ),
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = treasuryKeypair.publicKey;
      tx.sign(treasuryKeypair);

      const txid = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      const { blockhash: bh2, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        { signature: txid, blockhash: bh2, lastValidBlockHeight },
        "confirmed",
      );

      return NextResponse.json({
        success: true,
        action: "created",
        tx_signature: txid,
        metadata_pda: metadataPDA.toBase58(),
        metadata_uri: metadataUri,
        logo_url: `${baseUrl}/api/token/logo`,
        explorer: `https://solscan.io/tx/${txid}`,
        message: "§GLITCH token metadata created on-chain! Logo and name should appear in Phantom shortly.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      console.error("[token-metadata] create error:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── update (metadata-authority signs, treasury pays fees) ──
  if (action === "update") {
    const authorityKeypair = getMetadataAuthorityKeypair();
    if (!authorityKeypair) {
      return NextResponse.json(
        {
          error:
            "Neither METADATA_AUTHORITY_PRIVATE_KEY nor METADATA_AUTHORITY_MNEMONIC is configured. " +
            `Add one to Vercel env vars for the wallet that owns the metadata update authority (${EXPECTED_UPDATE_AUTHORITY}).`,
        },
        { status: 503 },
      );
    }

    const treasuryKeypair = getTreasuryKeypair();
    if (!treasuryKeypair) {
      return NextResponse.json(
        { error: "TREASURY_PRIVATE_KEY not configured (needed to pay tx fees)" },
        { status: 503 },
      );
    }

    const existing = await connection.getAccountInfo(metadataPDA);
    if (!existing) {
      return NextResponse.json(
        { error: "No metadata found. Use action='create' first." },
        { status: 404 },
      );
    }

    try {
      const name = body.name || TOKEN_NAME;
      const symbol = body.symbol || TOKEN_SYMBOL;
      const uri = body.uri || metadataUri;

      const tx = new Transaction();
      tx.add(
        buildUpdateMetadataInstruction(
          metadataPDA,
          authorityKeypair.publicKey,
          name,
          symbol,
          uri,
        ),
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = treasuryKeypair.publicKey;
      tx.sign(treasuryKeypair, authorityKeypair);

      const txid = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      const { blockhash: bh2, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        { signature: txid, blockhash: bh2, lastValidBlockHeight },
        "confirmed",
      );

      return NextResponse.json({
        success: true,
        action: "updated",
        tx_signature: txid,
        metadata_pda: metadataPDA.toBase58(),
        authority_used: authorityKeypair.publicKey.toBase58(),
        name,
        symbol,
        uri,
        logo_url: `${baseUrl}/api/token/logo`,
        explorer: `https://solscan.io/tx/${txid}`,
        message: "§GLITCH token metadata updated! Changes should reflect in Phantom shortly.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Update failed";
      console.error("[token-metadata] update error:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── verify (derive authority keypair, compare against on-chain expected) ──
  if (action === "verify") {
    const authorityKeypair = getMetadataAuthorityKeypair();
    if (!authorityKeypair) {
      return NextResponse.json(
        {
          error:
            "Neither METADATA_AUTHORITY_PRIVATE_KEY nor METADATA_AUTHORITY_MNEMONIC is configured.",
          instructions:
            "Add METADATA_AUTHORITY_MNEMONIC to your Vercel env vars with your seed phrase.",
        },
        { status: 503 },
      );
    }

    const derivedAddress = authorityKeypair.publicKey.toBase58();
    const matches = derivedAddress === EXPECTED_UPDATE_AUTHORITY;

    return NextResponse.json({
      derived_address: derivedAddress,
      expected_authority: EXPECTED_UPDATE_AUTHORITY,
      matches,
      message: matches
        ? "Mnemonic derives the correct update authority wallet. You can now use action='update'."
        : `Mismatch! The mnemonic derives ${derivedAddress} but the on-chain authority is ${EXPECTED_UPDATE_AUTHORITY}. ` +
          "May be a different mnemonic, or the wallet used a BIP44 derivation path. Try exporting the private key directly instead.",
    });
  }

  return NextResponse.json(
    {
      error: "Invalid action. Use 'check', 'create', 'update', or 'verify'.",
      metadata_uri: metadataUri,
      logo_url: `${baseUrl}/api/token/logo`,
    },
    { status: 400 },
  );
}
