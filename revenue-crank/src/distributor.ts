import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import type { RevenueAccount, RevenueConfig } from './types.js';

/**
 * Build + send `OT::distribute_revenue`.
 *
 * Account order (matches contracts/ownership-token/src/instructions/distribute_revenue.rs:9):
 *   0. crank                  (signer)
 *   1. ot_mint                (read)
 *   2. revenue_account        (mut)   — `["revenue", ot_mint]`
 *   3. revenue_token_account  (mut)   — USDC ATA owned by revenue_account
 *   4. revenue_config         (read)  — `["revenue_config", ot_mint]`
 *   5. areal_fee_account      (mut)   — must equal revenue_config.areal_fee_destination
 *   6. token_program          (read)
 *   remaining_accounts: each active destination ATA, in active order.
 *
 * Discriminator: sha256("global:distribute_revenue")[..8].
 *
 * Instruction data: just the discriminator (no args).
 */

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let cachedDisc: Buffer | null = null;
export function discDistributeRevenue(): Buffer {
  if (!cachedDisc) {
    const h = createHash('sha256');
    h.update('global:distribute_revenue');
    cachedDisc = h.digest().subarray(0, 8);
  }
  return cachedDisc;
}

export interface BuildArgs {
  otProgramId: PublicKey;
  crank: PublicKey;
  otMint: PublicKey;
  revenueAccount: PublicKey;
  revenueConfig: PublicKey;
  account: RevenueAccount;
  config: RevenueConfig;
}

export function buildDistributeRevenueIx(args: BuildArgs): TransactionInstruction {
  const data = Buffer.alloc(8);
  discDistributeRevenue().copy(data, 0);

  const keys = [
    { pubkey: args.crank, isSigner: true, isWritable: true },
    { pubkey: args.otMint, isSigner: false, isWritable: false },
    { pubkey: args.revenueAccount, isSigner: false, isWritable: true },
    { pubkey: args.account.revenueTokenAccount, isSigner: false, isWritable: true },
    { pubkey: args.revenueConfig, isSigner: false, isWritable: false },
    { pubkey: args.config.arealFeeDestination, isSigner: false, isWritable: true },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // remaining_accounts: each destination ATA in active order
    ...args.config.destinations.map(d => ({
      pubkey: d.address,
      isSigner: false,
      isWritable: true,
    })),
  ];

  return new TransactionInstruction({
    programId: args.otProgramId,
    keys,
    data,
  });
}

export async function sendDistributeRevenueTx(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
}
