import type { PublicKey } from '@solana/web3.js';

/**
 * Layer 8 — convert-and-fund-crank shared types.
 */

/** Slimmed-down view of a DEX classic pool we care about for swap estimation. */
export interface PoolSnapshot {
  address: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  reserveA: bigint;
  reserveB: bigint;
  /** Areal protocol fee charged on the output side, in basis points. */
  feeBps: number;
  /** True if the pool can serve a swap right now (active + non-empty). */
  isActive: boolean;
}

/** The two read-only inputs the convert decision needs. */
export interface ConvertContext {
  /** Total USDC currently sitting in the OT's Accumulator USDC ATA. */
  accumulatorUsdcBalance: bigint;
  /** Current RWT NAV (USD per RWT) scaled by 1e6 — read from RwtVault. */
  navBookValue: bigint;
  /** Master RWT/USDC pool snapshot, or null if we can't read it. */
  pool: PoolSnapshot | null;
}

export type ConvertDecision =
  | {
      kind: 'send';
      usdcAmount: bigint;
      minRwtOut: bigint;
      swapFirst: boolean;
      expectedRwt: bigint;
    }
  | { kind: 'skip'; reason: ConvertSkipReason; details?: Record<string, unknown> };

export type ConvertSkipReason =
  | 'below_min'
  | 'zero_balance'
  | 'no_pool_no_nav'
  | 'rpc_error'
  | 'in_flight'
  // Sec M-1 — slippage rounded `min_rwt_out` to 0; sandwich-attack surface.
  | 'zero_min_out'
  // Sec M-3/M-4 — distinct skip reasons split out from the historic
  // `rpc_error` catch-all so log analytics can triage incidents:
  | 'low_sol' // pre-flight balance check failed
  | 'slippage_drift' // pool moved between decide and submit
  | 'on_chain_revert' // handler rejected the TX (slippage, invalid arg)
  | 'submit_failed' // transport / RPC error during sendAndConfirm
  | 'account_list_incomplete' // dynamic account resolver returned partial set
  | 'pool_missing'; // master pool snapshot couldn't be read
