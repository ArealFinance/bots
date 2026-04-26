import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  deriveAccumulatorPda,
  deriveDistConfigPda,
  deriveDistributorPda,
  deriveRwtVaultPda,
} from './readers.js';

/**
 * Build + send `YD::convert_to_rwt`.
 *
 * Account order matches the on-chain handler
 * (contracts/yield-distribution/src/instructions/convert_to_rwt.rs:81), 22
 * accounts in total:
 *
 *   0. crank                    (signer, mut)
 *   1. config                   (read)
 *   2. distributor              (mut)
 *   3. ot_mint                  (read)
 *   4. accumulator              (read PDA, signer via PDA inside handler)
 *   5. accumulator_usdc_ata     (mut)
 *   6. accumulator_rwt_ata      (mut)
 *   7. fee_account              (mut)        — areal_fee_destination (RWT ATA)
 *   8. reward_vault             (mut)        — distributor.reward_vault
 *   9. rwt_mint                 (read)
 *  10. dex_config               (read)
 *  11. pool_state               (mut)
 *  12. dex_pool_vault_in        (mut)
 *  13. dex_pool_vault_out       (mut)
 *  14. dex_areal_fee_account    (mut)
 *  15. rwt_vault                (mut)
 *  16. rwt_capital_acc          (mut)
 *  17. rwt_dao_fee_account      (mut)
 *  18. dex_program              (read)
 *  19. rwt_engine_program       (read)
 *  20. token_program            (read)
 *  21. system_program           (read)
 *
 * Args layout (D7):
 *   [DISC_CONVERT_TO_RWT(8) | usdc_amount(u64 LE) | min_rwt_out(u64 LE) | swap_first(u8)]
 *   = 25 bytes total.
 *
 * Wraps the ix in a 2-ix transaction:
 *   - ComputeBudgetProgram.setComputeUnitLimit(300_000)   (D5)
 *   - ComputeBudgetProgram.setComputeUnitPrice(P)         (D5)
 *   - YD::convert_to_rwt
 */

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let cachedDisc: Buffer | null = null;
export function discConvertToRwt(): Buffer {
  if (!cachedDisc) {
    cachedDisc = createHash('sha256').update('global:convert_to_rwt').digest().subarray(0, 8);
  }
  return cachedDisc;
}

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

  const data = Buffer.alloc(8 + 8 + 8 + 1);
  discConvertToRwt().copy(data, 0);
  data.writeBigUInt64LE(args.usdcAmount, 8);
  data.writeBigUInt64LE(args.minRwtOut, 16);
  data.writeUInt8(args.swapFirst ? 1 : 0, 24);

  const keys = [
    { pubkey: args.crank, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: distributor, isSigner: false, isWritable: true },
    { pubkey: args.otMint, isSigner: false, isWritable: false },
    { pubkey: accumulator, isSigner: false, isWritable: false },
    { pubkey: args.accumulatorUsdcAta, isSigner: false, isWritable: true },
    { pubkey: args.accumulatorRwtAta, isSigner: false, isWritable: true },
    { pubkey: args.feeAccount, isSigner: false, isWritable: true },
    { pubkey: args.rewardVault, isSigner: false, isWritable: true },
    { pubkey: args.rwtMint, isSigner: false, isWritable: false },
    { pubkey: args.dexConfig, isSigner: false, isWritable: false },
    { pubkey: args.poolState, isSigner: false, isWritable: true },
    { pubkey: args.dexPoolVaultIn, isSigner: false, isWritable: true },
    { pubkey: args.dexPoolVaultOut, isSigner: false, isWritable: true },
    { pubkey: args.dexArealFeeAccount, isSigner: false, isWritable: true },
    { pubkey: rwtVault, isSigner: false, isWritable: true },
    { pubkey: args.rwtCapitalAcc, isSigner: false, isWritable: true },
    { pubkey: args.rwtDaoFeeAccount, isSigner: false, isWritable: true },
    { pubkey: args.dexProgramId, isSigner: false, isWritable: false },
    { pubkey: args.rwtEngineProgramId, isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: args.ydProgramId,
    keys,
    data,
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
