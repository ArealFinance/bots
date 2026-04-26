/**
 * Build `DEX::nexus_remove_liquidity` ix.
 *
 * Account order (matches `contracts/native-dex/src/instructions/nexus_remove_liquidity.rs`
 * + Layer 9 architecture §4.5) — 9 named accounts (no `dex_config` vs swap
 * — substep-3 architect-review confirmed parity with the user-signed
 * `remove_liquidity` view; no rent payer needed because rent refund on full
 * close goes to the Nexus PDA per Substep 3 architect-review M-2):
 *
 *   0. manager              (signer)
 *   1. liquidity_nexus      (mut, signs vault transfers via PDA seeds)
 *   2. pool_state           (mut)
 *   3. lp_position          (mut, seed = ["lp", pool, nexus])
 *   4. nexus_token_a        (mut, owner = liquidity_nexus)
 *   5. nexus_token_b        (mut, owner = liquidity_nexus)
 *   6. vault_a              (mut)
 *   7. vault_b              (mut)
 *   8. token_program        (read)
 *  remaining_accounts: token_program (R47).
 *
 * Discriminator: `sha256("global:nexus_remove_liquidity")[..8]`.
 *
 * Args layout: [DISC(8) | shares_to_burn(u128 LE)] = 24 bytes.
 */

import { createHash } from 'node:crypto';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import type { NexusAccountContext, PoolAccountContext } from '../types.js';
import { SPL_TOKEN_PROGRAM_ID } from './nexus-swap.js';

let cachedDisc: Buffer | null = null;
export function discNexusRemoveLiquidity(): Buffer {
  if (!cachedDisc) {
    cachedDisc = createHash('sha256')
      .update('global:nexus_remove_liquidity')
      .digest()
      .subarray(0, 8);
  }
  return cachedDisc;
}

export interface BuildNexusRemoveLiquidityArgs {
  ctx: NexusAccountContext;
  pool: PoolAccountContext;
  sharesToBurn: bigint;
}

export function buildNexusRemoveLiquidityIx(
  args: BuildNexusRemoveLiquidityArgs,
): TransactionInstruction {
  const { ctx, pool, sharesToBurn } = args;
  if (sharesToBurn <= 0n) {
    throw new Error(
      `nexus_remove_liquidity: shares_to_burn must be > 0 (got ${sharesToBurn})`,
    );
  }
  validateU128(sharesToBurn, 'shares_to_burn');

  const data = Buffer.alloc(8 + 16);
  discNexusRemoveLiquidity().copy(data, 0);
  data.writeBigUInt64LE(sharesToBurn & 0xffff_ffff_ffff_ffffn, 8);
  data.writeBigUInt64LE(sharesToBurn >> 64n, 16);

  const keys = [
    { pubkey: ctx.manager, isSigner: true, isWritable: false },
    { pubkey: ctx.liquidityNexus, isSigner: false, isWritable: true },
    { pubkey: pool.pool, isSigner: false, isWritable: true },
    { pubkey: pool.lpPosition, isSigner: false, isWritable: true },
    { pubkey: ctx.nexusUsdcAta, isSigner: false, isWritable: true },
    { pubkey: ctx.nexusRwtAta, isSigner: false, isWritable: true },
    { pubkey: pool.vaultA, isSigner: false, isWritable: true },
    { pubkey: pool.vaultB, isSigner: false, isWritable: true },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // R47 — token_program also in remaining_accounts.
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: ctx.dexProgramId,
    keys,
    data,
  });
}

export function buildNexusRemoveLiquidityTx(
  args: BuildNexusRemoveLiquidityArgs,
): Transaction {
  return new Transaction().add(buildNexusRemoveLiquidityIx(args));
}

function validateU128(value: bigint, label: string): void {
  if (value < 0n) {
    throw new Error(`nexus_remove_liquidity: ${label} must be ≥ 0 (got ${value})`);
  }
  const u128Max = (1n << 128n) - 1n;
  if (value > u128Max) {
    throw new Error(`nexus_remove_liquidity: ${label} exceeds u128::MAX (got ${value})`);
  }
}
