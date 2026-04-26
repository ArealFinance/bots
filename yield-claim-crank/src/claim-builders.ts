import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { decodeProofNodes } from './proof-fetcher.js';
import type { ProofFile } from './types.js';

/**
 * Builders for the three Layer 8 claim instructions:
 *   1. RWT::claim_yield                — RwtVault PDA claims, splits 70/15/15
 *   2. DEX::compound_yield             — pool PDA claims, folds into reserve
 *   3. OT::claim_yd_for_treasury       — OtTreasury PDA claims for that OT
 *
 * Each ix shares the YD::claim instruction-data layout:
 *   [DISC(8) | cumulative_amount(u64 LE) | proof_len(u32 LE) | proof_bytes(32*N)]
 * BUT each WRAPPER program has its own discriminator + account list.
 */

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const discCache = new Map<string, Buffer>();
function disc(name: string): Buffer {
  let buf = discCache.get(name);
  if (!buf) {
    buf = createHash('sha256').update(name).digest().subarray(0, 8);
    discCache.set(name, buf);
  }
  return buf;
}
export const discRwtClaimYield = (): Buffer => disc('global:claim_yield');
export const discDexCompoundYield = (): Buffer => disc('global:compound_yield');
export const discOtClaimYdForTreasury = (): Buffer => disc('global:claim_yd_for_treasury');

/**
 * Encode the variable-length args body shared across all 3 wrappers.
 * Caller prepends the program-specific discriminator.
 */
export function encodeClaimArgsBody(cumulativeAmount: bigint, proofNodes: Buffer[]): Buffer {
  const buf = Buffer.alloc(8 + 4 + 32 * proofNodes.length);
  buf.writeBigUInt64LE(cumulativeAmount, 0);
  buf.writeUInt32LE(proofNodes.length, 8);
  let off = 12;
  for (const node of proofNodes) {
    if (node.length !== 32) throw new Error(`proof node has length ${node.length}, expected 32`);
    node.copy(buf, off);
    off += 32;
  }
  return buf;
}

export function encodeIxData(discriminator: Buffer, body: Buffer): Buffer {
  const out = Buffer.alloc(8 + body.length);
  discriminator.copy(out, 0);
  body.copy(out, 8);
  return out;
}

// ───────────────────── RWT::claim_yield ─────────────────────

export interface BuildRwtClaimArgs {
  rwtEngineProgramId: PublicKey;
  ydProgramId: PublicKey;
  crank: PublicKey;
  rwtVault: PublicKey;
  distConfig: PublicKey;
  rwtClaimAta: PublicKey;
  liquidityDest: PublicKey;
  protocolRevenueDest: PublicKey;
  ydConfig: PublicKey;
  otMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Buffer[];
}

/**
 * Build `rwt_engine::claim_yield` instruction.
 *
 * Account order (claim_yield.rs:53):
 *   0. crank                  (signer, mut)
 *   1. rwt_vault              (mut)
 *   2. dist_config            (read)
 *   3. rwt_claim_ata          (mut)
 *   4. liquidity_dest         (mut)
 *   5. protocol_revenue_dest  (mut)
 *   6. yd_config              (read)
 *   7. ot_mint                (read)
 *   8. yd_distributor         (mut)
 *   9. yd_claim_status        (mut)
 *  10. yd_reward_vault        (mut)
 *  11. yd_program             (read)
 *  12. token_program          (read)
 *  13. system_program         (read)
 */
export function buildRwtClaimYieldIx(args: BuildRwtClaimArgs): TransactionInstruction {
  const data = encodeIxData(
    discRwtClaimYield(),
    encodeClaimArgsBody(args.cumulativeAmount, args.proof),
  );
  return new TransactionInstruction({
    programId: args.rwtEngineProgramId,
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.rwtVault, isSigner: false, isWritable: true },
      { pubkey: args.distConfig, isSigner: false, isWritable: false },
      { pubkey: args.rwtClaimAta, isSigner: false, isWritable: true },
      { pubkey: args.liquidityDest, isSigner: false, isWritable: true },
      { pubkey: args.protocolRevenueDest, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─────────────────── DEX::compound_yield ────────────────────

export interface BuildDexCompoundArgs {
  dexProgramId: PublicKey;
  ydProgramId: PublicKey;
  crank: PublicKey;
  poolState: PublicKey;
  targetVault: PublicKey;
  ydConfig: PublicKey;
  otMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Buffer[];
}

/**
 * Build `native_dex::compound_yield` instruction.
 *
 * Account order (compound_yield.rs:32):
 *   0. crank             (signer, mut)
 *   1. pool_state        (mut)
 *   2. target_vault      (mut)
 *   3. yd_config         (read)
 *   4. ot_mint           (read)
 *   5. yd_distributor    (mut)
 *   6. yd_claim_status   (mut)
 *   7. yd_reward_vault   (mut)
 *   8. yd_program        (read)
 *   9. token_program     (read)
 *  10. system_program    (read)
 */
export function buildDexCompoundIx(args: BuildDexCompoundArgs): TransactionInstruction {
  const data = encodeIxData(
    discDexCompoundYield(),
    encodeClaimArgsBody(args.cumulativeAmount, args.proof),
  );
  return new TransactionInstruction({
    programId: args.dexProgramId,
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.targetVault, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─────────────── OT::claim_yd_for_treasury ──────────────────

export interface BuildOtTreasuryClaimArgs {
  otProgramId: PublicKey;
  ydProgramId: PublicKey;
  crank: PublicKey;
  /** Mint of the THIS treasury (used to derive OtTreasury PDA). */
  otMint: PublicKey;
  otTreasury: PublicKey;
  treasuryRwtAta: PublicKey;
  ydConfig: PublicKey;
  /** Mint of the OT distributor we claim FROM (may differ from otMint). */
  ydOtMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Buffer[];
}

/**
 * Build `ownership_token::claim_yd_for_treasury`.
 *
 * Account order (claim_yd_for_treasury.rs:27):
 *   0. crank             (signer, mut)
 *   1. ot_mint           (read)
 *   2. ot_treasury       (read)
 *   3. treasury_rwt_ata  (mut)
 *   4. yd_config         (read)
 *   5. yd_ot_mint        (read)
 *   6. yd_distributor    (mut)
 *   7. yd_claim_status   (mut)
 *   8. yd_reward_vault   (mut)
 *   9. yd_program        (read)
 *  10. token_program     (read)
 *  11. system_program    (read)
 */
export function buildOtTreasuryClaimIx(args: BuildOtTreasuryClaimArgs): TransactionInstruction {
  const data = encodeIxData(
    discOtClaimYdForTreasury(),
    encodeClaimArgsBody(args.cumulativeAmount, args.proof),
  );
  return new TransactionInstruction({
    programId: args.otProgramId,
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.otTreasury, isSigner: false, isWritable: false },
      { pubkey: args.treasuryRwtAta, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.ydOtMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─────────────────── Helpers used by the crank ──────────────

/**
 * Convert a {@link ProofFile} into the (cumulativeAmount, proofNodes) tuple
 * the builders need.
 */
export function proofFileToArgs(file: ProofFile): { cumulativeAmount: bigint; proof: Buffer[] } {
  return {
    cumulativeAmount: BigInt(file.cumulativeAmount),
    proof: decodeProofNodes(file.proof),
  };
}

/**
 * Wrap any single-ix claim builder in a transaction with the standard
 * compute-budget prefix.
 */
export function wrapClaimTx(args: {
  ix: TransactionInstruction;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}): Transaction {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: args.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: args.computeUnitPriceMicroLamports,
    }),
    args.ix,
  );
  return tx;
}

export type SignerKey = Keypair;
