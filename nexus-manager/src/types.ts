/**
 * Shared types for the nexus-manager bot.
 *
 * Pure-data shapes only — no behaviour. Behaviour lives in
 * `decision-engine.ts`, `nexus-state-reader.ts`, and the per-ix builders
 * under `tx-builders/`.
 *
 * Layout sources:
 *   - `LiquidityNexus` per `contracts/native-dex/src/state.rs` (50-byte
 *     body + 8-byte arlex discriminator). Layer 9 SD-2 / D16 — singleton
 *     PDA at seed `["liquidity_nexus"]`.
 *   - `LpPosition` per `contracts/native-dex/src/state.rs` (121-byte body +
 *     8-byte discriminator). Layer 9 D28 — `fees_claimed_per_share_{a,b}`
 *     extension.
 *   - `PoolState` (244-byte body) — used by the decision engine to read
 *     reserves and the Q64.64 fee-per-share accumulator.
 */

import type { PublicKey } from '@solana/web3.js';

/**
 * Decoded `LiquidityNexus` singleton PDA (Layer 9 §3 / SD-2 / D16).
 *
 * `manager == [0u8; 32]` is the documented kill-switch (D22) — the bot must
 * exit cleanly when this is observed because every Manager-gated ix reverts
 * `NexusManagerDisabled` regardless of which wallet signed.
 */
export interface LiquidityNexusState {
  /** Manager wallet — signs `nexus_swap` / `nexus_add_liquidity` / `nexus_remove_liquidity`. */
  manager: PublicKey;
  /** Cumulative USDC deposited via `nexus_deposit`. Monotonically non-decreasing. */
  totalDepositedUsdc: bigint;
  /** Cumulative RWT deposited via `nexus_deposit` + `withdraw_liquidity_holding`. Monotonically non-decreasing. */
  totalDepositedRwt: bigint;
  /** `false` reverts every Nexus ix with `NexusNotActive`. */
  isActive: boolean;
  /** PDA bump for `["liquidity_nexus"]`. */
  bump: number;
}

/**
 * Decoded `LpPosition` (Layer 9 D28 layout — 121 bytes body).
 *
 * Owner of every Nexus-managed position equals the LiquidityNexus PDA.
 * The Q64.64 `fees_claimed_per_share_{a,b}` snapshots are advanced by the
 * inner `add_liquidity` / `remove_liquidity` / `claim_lp_fees` paths
 * (D29 / D30 invariants — inherited automatically).
 */
export interface LpPositionState {
  pool: PublicKey;
  owner: PublicKey;
  shares: bigint;
  lastUpdateTs: bigint;
  bump: number;
  feesClaimedPerShareA: bigint;
  feesClaimedPerShareB: bigint;
}

/**
 * Subset of `PoolState` fields the decision engine reads. We do NOT decode
 * every field — keeping the parser narrow reduces drift surface against
 * Layer 4-9 PoolState extensions.
 */
export interface PoolStateInfo {
  pool: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  reserveA: bigint;
  reserveB: bigint;
  totalLpShares: bigint;
  isActive: boolean;
  cumulativeFeesPerShareA: bigint;
  cumulativeFesPerShareB: bigint;
}

/**
 * Decision emitted by the rebalance engine. Only one decision per cycle is
 * acted upon (no parallel TXs) — the engine biases towards `noop` when the
 * Nexus is in a kill-switched or idle state.
 */
export type Decision =
  | { kind: 'noop'; reason: string }
  | { kind: 'killSwitch'; reason: 'manager_zero' | 'is_active_false' }
  | {
      kind: 'swap';
      pool: PublicKey;
      amountIn: bigint;
      minAmountOut: bigint;
      aToB: boolean;
      reason: string;
    }
  | {
      kind: 'addLiquidity';
      pool: PublicKey;
      amountA: bigint;
      amountB: bigint;
      minShares: bigint;
      reason: string;
    }
  | {
      kind: 'removeLiquidity';
      pool: PublicKey;
      sharesToBurn: bigint;
      reason: string;
    };

/**
 * Account contexts for Nexus ix's are now re-exported from `@areal/sdk/tx`
 * (Phase 4 R3.B1). The SDK definitions match this bot's prior shape exactly;
 * keeping a single source of truth eliminates drift.
 */
export type { NexusAccountContext, PoolAccountContext } from '@areal/sdk/tx';

/** Snapshot of Nexus-owned ATAs used by the decision engine. */
export interface NexusBalances {
  usdc: bigint;
  rwt: bigint;
}
