/**
 * Build `DEX::nexus_swap` ix.
 *
 * Account order (matches `contracts/native-dex/src/instructions/nexus_swap.rs`
 * + Layer 9 architecture §4.3) — 11 named accounts:
 *
 *   0. manager              (signer, mut)
 *   1. dex_config           (read)
 *   2. liquidity_nexus      (mut, signs vault transfers via PDA seeds)
 *   3. pool_state           (mut)
 *   4. nexus_token_in       (mut, owner = liquidity_nexus)
 *   5. nexus_token_out      (mut, owner = liquidity_nexus)
 *   6. vault_in             (mut)
 *   7. vault_out            (mut)
 *   8. areal_fee_account    (mut, == dex_config.areal_fee_destination)
 *   9. token_program        (read)
 *  remaining_accounts: token_program duplicate (R47 — Substep 5 dropped the
 *  named slot for some sibling ix; kept as remaining_accounts uniformly so
 *  TX builders never need to special-case which sibling ix needs it where).
 *
 * Discriminator: `sha256("global:nexus_swap")[..8]`.
 *
 * Args layout: [DISC(8) | amount_in(u64 LE) | min_amount_out(u64 LE) | a_to_b(u8)]
 *   = 25 bytes.
 */

import { createHash } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import type { NexusAccountContext, PoolAccountContext } from '../types.js';

/** SPL Token v1 program ID. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

let cachedDisc: Buffer | null = null;
export function discNexusSwap(): Buffer {
  if (!cachedDisc) {
    cachedDisc = createHash('sha256')
      .update('global:nexus_swap')
      .digest()
      .subarray(0, 8);
  }
  return cachedDisc;
}

export interface BuildNexusSwapArgs {
  ctx: NexusAccountContext;
  pool: PoolAccountContext;
  /** `true` → swap token A (vault_a) → token B (vault_b). */
  aToB: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
}

/**
 * Build the `nexus_swap` `TransactionInstruction`. The caller wraps it in
 * a `Transaction`, signs with the Manager keypair, and submits via
 * `MultiRpcClient.withFallback`.
 */
export function buildNexusSwapIx(args: BuildNexusSwapArgs): TransactionInstruction {
  const { ctx, pool, aToB, amountIn, minAmountOut } = args;
  validateAmount(amountIn, 'amount_in');
  validateAmount(minAmountOut, 'min_amount_out');

  const data = Buffer.alloc(8 + 8 + 8 + 1);
  discNexusSwap().copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minAmountOut, 16);
  data.writeUInt8(aToB ? 1 : 0, 24);

  // `vault_in` / `vault_out` align with the `a_to_b` flag — the on-chain
  // handler cross-validates via `pool.vault_a/b`.
  const vaultIn = aToB ? pool.vaultA : pool.vaultB;
  const vaultOut = aToB ? pool.vaultB : pool.vaultA;
  // Nexus ATAs follow the same convention. Caller resolves which Nexus ATA
  // is USDC vs RWT and the ix's `a_to_b` flag matches the pool layout.
  const nexusTokenIn = aToB ? ctx.nexusUsdcAta : ctx.nexusRwtAta;
  const nexusTokenOut = aToB ? ctx.nexusRwtAta : ctx.nexusUsdcAta;

  const keys = [
    { pubkey: ctx.manager, isSigner: true, isWritable: true },
    { pubkey: ctx.dexConfig, isSigner: false, isWritable: false },
    { pubkey: ctx.liquidityNexus, isSigner: false, isWritable: true },
    { pubkey: pool.pool, isSigner: false, isWritable: true },
    { pubkey: nexusTokenIn, isSigner: false, isWritable: true },
    { pubkey: nexusTokenOut, isSigner: false, isWritable: true },
    { pubkey: vaultIn, isSigner: false, isWritable: true },
    { pubkey: vaultOut, isSigner: false, isWritable: true },
    { pubkey: ctx.arealFeeAccount, isSigner: false, isWritable: true },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // R47 — token_program also in remaining_accounts. Pinocchio_token's
    // hardcoded program ID does NOT alleviate the requirement to pass the
    // program account in the TX accounts list; the named slot above plus
    // this remaining_accounts entry together satisfy both the named-slot
    // and remaining-accounts conventions across all 4 Layer 9 sibling ix.
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: ctx.dexProgramId,
    keys,
    data,
  });
}

/** Wrap a built `nexus_swap` ix in a fresh `Transaction`. */
export function buildNexusSwapTx(args: BuildNexusSwapArgs): Transaction {
  return new Transaction().add(buildNexusSwapIx(args));
}

function validateAmount(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Error(`nexus_swap: ${label} must be > 0 (got ${value})`);
  }
  // u64 ceiling check — TS bigint can hold larger values, but the on-chain
  // handler reads u64 LE. Reject overflow at the builder boundary.
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`nexus_swap: ${label} exceeds u64::MAX (got ${value})`);
  }
}

// `SystemProgram` is intentionally not used here — `nexus_swap` does not
// require it. Re-exported only to keep the per-ix builder signature
// uniform with `nexus-add-liquidity.ts`.
export { SystemProgram };
