import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { buildDistributeRevenueIx as sdkBuildDistributeRevenueIx } from '@areal/sdk/tx';

import type { RevenueAccount, RevenueConfig } from './types.js';

/**
 * Build + send `OT::distribute_revenue`.
 *
 * Account list, args layout, and discriminator now sourced from
 * `@areal/sdk/tx` (Phase 4.1 B.1.2 — single source of truth across crank
 * + dashboard). The wrapper here flattens the bot-specific RevenueAccount /
 * RevenueConfig snapshots into the SDK's positional account inputs.
 */

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
  return sdkBuildDistributeRevenueIx({
    otProgramId: args.otProgramId,
    crank: args.crank,
    otMint: args.otMint,
    revenueAccount: args.revenueAccount,
    revenueTokenAccount: args.account.revenueTokenAccount,
    revenueConfig: args.revenueConfig,
    arealFeeDestination: args.config.arealFeeDestination,
    destinations: args.config.destinations.map((d) => d.address),
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
