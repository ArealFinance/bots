import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { buildConvertToRwtIx as sdkBuildConvertToRwtIx } from '@areal/sdk/tx';

import {
  deriveAccumulatorPda,
  deriveDistConfigPda,
  deriveDistributorPda,
  deriveRwtVaultPda,
} from './readers.js';

/**
 * Build + send `YD::convert_to_rwt`.
 *
 * Account list, args layout, and discriminator now sourced from
 * `@areal/sdk/tx` (Phase 4.1 B.1.1 — single source of truth across crank
 * + dashboard). The wrapper here derives the Layer 8 PDAs and calls the
 * SDK builder, returning both the ix and the derived PDAs for downstream
 * logging/diagnostics.
 *
 * Wraps the ix in a 3-ix transaction:
 *   - ComputeBudgetProgram.setComputeUnitLimit(300_000)   (D5)
 *   - ComputeBudgetProgram.setComputeUnitPrice(P)         (D5)
 *   - YD::convert_to_rwt (from @areal/sdk/tx)
 */

export interface BuildConvertArgs {
  ydProgramId: PublicKey;
  dexProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  crank: PublicKey;
  otMint: PublicKey;
  accumulatorUsdcAta: PublicKey;
  accumulatorRwtAta: PublicKey;
  feeAccount: PublicKey;
  rewardVault: PublicKey;
  rwtMint: PublicKey;
  dexConfig: PublicKey;
  poolState: PublicKey;
  dexPoolVaultIn: PublicKey;
  dexPoolVaultOut: PublicKey;
  dexArealFeeAccount: PublicKey;
  rwtCapitalAcc: PublicKey;
  rwtDaoFeeAccount: PublicKey;

  usdcAmount: bigint;
  minRwtOut: bigint;
  swapFirst: boolean;
}

export interface BuiltConvertIx {
  ix: TransactionInstruction;
  accumulator: PublicKey;
  distributor: PublicKey;
  config: PublicKey;
  rwtVault: PublicKey;
}

export function buildConvertToRwtIx(args: BuildConvertArgs): BuiltConvertIx {
  const accumulator = deriveAccumulatorPda(args.otMint, args.ydProgramId);
  const distributor = deriveDistributorPda(args.otMint, args.ydProgramId);
  const config = deriveDistConfigPda(args.ydProgramId);
  const rwtVault = deriveRwtVaultPda(args.rwtEngineProgramId);

  const ix = sdkBuildConvertToRwtIx({
    ydProgramId: args.ydProgramId,
    dexProgramId: args.dexProgramId,
    rwtEngineProgramId: args.rwtEngineProgramId,
    crank: args.crank,
    config,
    distributor,
    otMint: args.otMint,
    accumulator,
    accumulatorUsdcAta: args.accumulatorUsdcAta,
    accumulatorRwtAta: args.accumulatorRwtAta,
    feeAccount: args.feeAccount,
    rewardVault: args.rewardVault,
    rwtMint: args.rwtMint,
    dexConfig: args.dexConfig,
    poolState: args.poolState,
    dexPoolVaultIn: args.dexPoolVaultIn,
    dexPoolVaultOut: args.dexPoolVaultOut,
    dexArealFeeAccount: args.dexArealFeeAccount,
    rwtVault,
    rwtCapitalAcc: args.rwtCapitalAcc,
    rwtDaoFeeAccount: args.rwtDaoFeeAccount,
    usdcAmount: args.usdcAmount,
    minRwtOut: args.minRwtOut,
    swapFirst: args.swapFirst,
  });

  return { ix, accumulator, distributor, config, rwtVault };
}

export interface BuildAndSendArgs extends BuildConvertArgs {
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}

/**
 * Build the complete TX (CU budget + price + convert_to_rwt) and send it with
 * the provided crank keypair.
 */
export async function sendConvertToRwt(
  conn: Connection,
  payer: Keypair,
  args: BuildAndSendArgs,
): Promise<{ signature: string; built: BuiltConvertIx }> {
  const built = buildConvertToRwtIx(args);

  const tx = new Transaction();
  // D5: explicit CU budget for convert_to_rwt — defaults are too low for the
  // double-CPI path (DEX swap + RWT mint).
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: args.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: args.computeUnitPriceMicroLamports,
    }),
    built.ix,
  );

  const signature = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  return { signature, built };
}
