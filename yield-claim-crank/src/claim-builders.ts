import {
  ComputeBudgetProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { decodeProofNodes } from './proof-fetcher.js';
import type { ProofFile } from './types.js';

/**
 * Bot-local helpers for the Layer 8 claim flows.
 *
 * The actual ix builders (`buildRwtClaimYieldIx`, `buildDexCompoundIx`,
 * `buildOtTreasuryClaimIx`) live in `@areal/sdk/tx` after the Phase 4
 * SDK migration. This file keeps the two helpers that remain bot-local:
 *
 *   - {@link proofFileToArgs} — adapts our `ProofFile` JSON shape to the
 *     `(cumulativeAmount, proof)` tuple the SDK builders consume.
 *   - {@link wrapClaimTx}     — wraps a single claim ix in a Transaction
 *     with the standard `ComputeBudgetProgram` prefix used by the crank.
 */

/**
 * Convert a {@link ProofFile} into the (cumulativeAmount, proofNodes) tuple
 * the SDK ix builders need.
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
