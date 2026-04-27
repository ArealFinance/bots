import type { PublicKey } from '@solana/web3.js';

/**
 * Layer 8 — revenue-crank shared types.
 */

/**
 * Mirror of the on-chain `RevenueAccount` struct
 * (contracts/ownership-token/src/state.rs:67).
 *
 * Layout (98 bytes after 8-byte discriminator):
 *   ot_mint                  [u8;32]
 *   revenue_token_account    [u8;32]   — canonical USDC ATA owned by this PDA
 *   total_distributed        u64
 *   distribution_count       u64
 *   last_distribution_ts     i64
 *   min_distribution_amount  u64
 *   is_distributing          bool (1)
 *   bump                     u8 (1)
 */
export interface RevenueAccount {
  otMint: PublicKey;
  revenueTokenAccount: PublicKey;
  totalDistributed: bigint;
  distributionCount: bigint;
  lastDistributionTs: number;
  minDistributionAmount: bigint;
  isDistributing: boolean;
  bump: number;
}

/**
 * Mirror of `RevenueConfig` (contracts/ownership-token/src/state.rs:82) —
 * only the parts we need to build the TX. Each `RevenueDestination` is
 * 66 bytes: address(32) || allocation_bps(u16) || label(32).
 */
export interface RevenueDestination {
  address: PublicKey;
  allocationBps: number;
  label: string;
}

export interface RevenueConfig {
  otMint: PublicKey;
  destinations: RevenueDestination[]; // active destinations only (length = active_count)
  activeCount: number;
  configVersion: bigint;
  arealFeeDestination: PublicKey;
  bump: number;
}

/**
 * Decision context for whether to fire `distribute_revenue` for an OT this
 * tick. Captured as a value object so failure modes are easy to log + test.
 */
export type DistributionDecision =
  | { kind: 'send'; balance: bigint }
  | { kind: 'skip'; reason: SkipReason; details?: Record<string, unknown> };

export type SkipReason =
  | 'below_min'
  | 'cooldown'
  | 'concurrent_distribution'
  | 'no_destinations'
  | 'rpc_error'
  | 'low_sol';
