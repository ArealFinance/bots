/**
 * Build `DEX::nexus_add_liquidity` ix.
 *
 * Account order (matches `contracts/native-dex/src/instructions/nexus_add_liquidity.rs`
 * + Layer 9 architecture §4.4) — 11 named accounts (Substep 3 architect-review
 * M-1: Manager wallet is `payer` for first-time `LpPosition` creation):
 *
 *   0. manager              (signer, mut — also rent-payer on first deploy)
 *   1. dex_config           (read)
 *   2. liquidity_nexus      (mut, signs vault transfers via PDA seeds)
 *   3. pool_state           (mut)
 *   4. lp_position          (mut, init_if_needed seed = ["lp", pool, nexus])
 *   5. nexus_token_a        (mut, owner = liquidity_nexus)
 *   6. nexus_token_b        (mut, owner = liquidity_nexus)
 *   7. vault_a              (mut)
 *   8. vault_b              (mut)
 *   9. token_program        (read)
 *  10. system_program       (read)
 *  remaining_accounts: token_program (R47).
 *
 * Discriminator: `sha256("global:nexus_add_liquidity")[..8]`.
 *
 * Args layout: [DISC(8) | amount_a(u64 LE) | amount_b(u64 LE) | min_shares(u128 LE)]
 *   = 40 bytes.
 */

import { createHash } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import type { NexusAccountContext, PoolAccountContext } from '../types.js';
import { SPL_TOKEN_PROGRAM_ID } from './nexus-swap.js';

let cachedDisc: Buffer | null = null;
export function discNexusAddLiquidity(): Buffer {
  if (!cachedDisc) {
    cachedDisc = createHash('sha256')
      .update('global:nexus_add_liquidity')
      .digest()
      .subarray(0, 8);
  }
  return cachedDisc;
}

export interface BuildNexusAddLiquidityArgs {
  ctx: NexusAccountContext;
  pool: PoolAccountContext;
  amountA: bigint;
  amountB: bigint;
  minShares: bigint;
}

export function buildNexusAddLiquidityIx(
  args: BuildNexusAddLiquidityArgs,
): TransactionInstruction {
  const { ctx, pool, amountA, amountB, minShares } = args;
  if (amountA <= 0n && amountB <= 0n) {
    throw new Error('nexus_add_liquidity: amount_a + amount_b must be > 0');
  }
  validateU64(amountA, 'amount_a');
  validateU64(amountB, 'amount_b');
  if (minShares <= 0n) {
    throw new Error(`nexus_add_liquidity: min_shares must be > 0 (got ${minShares})`);
  }
  validateU128(minShares, 'min_shares');

  const data = Buffer.alloc(8 + 8 + 8 + 16);
  discNexusAddLiquidity().copy(data, 0);
  data.writeBigUInt64LE(amountA, 8);
  data.writeBigUInt64LE(amountB, 16);
  // u128 LE — split into two u64 LE halves.
  data.writeBigUInt64LE(minShares & 0xffff_ffff_ffff_ffffn, 24);
  data.writeBigUInt64LE(minShares >> 64n, 32);

  // Token A / B in pool ordering — caller's `pool` context already
  // holds the correct vault assignment. Nexus's USDC vs RWT ATA is
  // resolved by checking which mint is on side A — V1 keeps this
  // inline with the decision engine's pool selection (USDC↔RWT only).
  // For future multi-mint support the caller may need to re-resolve
  // ATAs against pool token mints.
  const nexusTokenA = ctx.nexusUsdcAta; // resolved by caller — see decision-engine
  const nexusTokenB = ctx.nexusRwtAta;

  const keys = [
    { pubkey: ctx.manager, isSigner: true, isWritable: true },
    { pubkey: ctx.dexConfig, isSigner: false, isWritable: false },
    { pubkey: ctx.liquidityNexus, isSigner: false, isWritable: true },
    { pubkey: pool.pool, isSigner: false, isWritable: true },
    { pubkey: pool.lpPosition, isSigner: false, isWritable: true },
    { pubkey: nexusTokenA, isSigner: false, isWritable: true },
    { pubkey: nexusTokenB, isSigner: false, isWritable: true },
    { pubkey: pool.vaultA, isSigner: false, isWritable: true },
    { pubkey: pool.vaultB, isSigner: false, isWritable: true },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // R47 — token_program also in remaining_accounts. Builder-level uniformity
    // across all 4 Layer 9 sibling ix.
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: ctx.dexProgramId,
    keys,
    data,
  });
}

export function buildNexusAddLiquidityTx(
  args: BuildNexusAddLiquidityArgs,
): Transaction {
  return new Transaction().add(buildNexusAddLiquidityIx(args));
}

function validateU64(value: bigint, label: string): void {
  if (value < 0n) {
    throw new Error(`nexus_add_liquidity: ${label} must be ≥ 0 (got ${value})`);
  }
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`nexus_add_liquidity: ${label} exceeds u64::MAX (got ${value})`);
  }
}

function validateU128(value: bigint, label: string): void {
  if (value < 0n) {
    throw new Error(`nexus_add_liquidity: ${label} must be ≥ 0 (got ${value})`);
  }
  const u128Max = (1n << 128n) - 1n;
  if (value > u128Max) {
    throw new Error(`nexus_add_liquidity: ${label} exceeds u128::MAX (got ${value})`);
  }
}
