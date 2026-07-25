import { BN, Program, AnchorProvider, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { getServerSolanaConnection } from "@/lib/solana-config";
import { getMagicClaimProgramId } from "@/lib/trade/magic-claim/config";
import idlJson from "@/lib/trade/magic-claim/idl/aiglitch_magic_claim.json";

const idl = idlJson as Idl;

function program(): Program {
  const programId = getMagicClaimProgramId();
  if (!programId) throw new Error("TRADE_MAGIC_CLAIM_PROGRAM_ID not configured");
  const connection = getServerSolanaConnection();
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    },
    { commitment: "confirmed" },
  );
  return new Program(idl, provider);
}

function claimPda(claimId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), claimId], programId)[0];
}

export async function buildMagicCreateDepositTx(params: {
  sender: string;
  mint: string;
  claimIdBytes: Buffer;
  amountAtomic: string;
  expiresAtSec: number;
}): Promise<{ transaction: string }> {
  const prog = program();
  const programId = prog.programId;
  const sender = new PublicKey(params.sender);
  const mint = new PublicKey(params.mint);
  const claimIdArr = [...params.claimIdBytes];
  const claim = claimPda(params.claimIdBytes, programId);
  const senderAta = getAssociatedTokenAddressSync(mint, sender);
  const vaultAta = getAssociatedTokenAddressSync(mint, claim, true);

  const tx = await prog.methods
    .createDeposit(claimIdArr, new BN(params.amountAtomic), new BN(params.expiresAtSec))
    .accounts({
      sender,
      claim,
      mint,
      senderTokenAccount: senderAta,
      vaultTokenAccount: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const connection = getServerSolanaConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = sender;

  const message = tx.compileMessage();
  const vtx = new VersionedTransaction(message);
  return { transaction: Buffer.from(vtx.serialize()).toString("base64") };
}

export async function buildMagicClaimTx(params: {
  recipient: string;
  mint: string;
  claimIdBytes: Buffer;
}): Promise<{ transaction: string }> {
  const prog = program();
  const programId = prog.programId;
  const recipient = new PublicKey(params.recipient);
  const mint = new PublicKey(params.mint);
  const claim = claimPda(params.claimIdBytes, programId);
  const vaultAta = getAssociatedTokenAddressSync(mint, claim, true);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  const tx = await prog.methods
    .claim()
    .accounts({
      recipient,
      claim,
      mint,
      vaultTokenAccount: vaultAta,
      recipientTokenAccount: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const connection = getServerSolanaConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = recipient;

  const message = tx.compileMessage();
  const vtx = new VersionedTransaction(message);
  return { transaction: Buffer.from(vtx.serialize()).toString("base64") };
}

export async function buildMagicRefundTx(params: {
  sender: string;
  mint: string;
  claimIdBytes: Buffer;
}): Promise<{ transaction: string }> {
  const prog = program();
  const programId = prog.programId;
  const sender = new PublicKey(params.sender);
  const mint = new PublicKey(params.mint);
  const claim = claimPda(params.claimIdBytes, programId);
  const vaultAta = getAssociatedTokenAddressSync(mint, claim, true);
  const senderAta = getAssociatedTokenAddressSync(mint, sender);

  const tx = await prog.methods
    .refund()
    .accounts({
      sender,
      claim,
      mint,
      vaultTokenAccount: vaultAta,
      senderTokenAccount: senderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const connection = getServerSolanaConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = sender;

  const message = tx.compileMessage();
  const vtx = new VersionedTransaction(message);
  return { transaction: Buffer.from(vtx.serialize()).toString("base64") };
}
