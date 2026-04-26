import type { PoolSnapshot } from './types.js';

/**
 * Slippage / route estimation for `convert_to_rwt`.
 *
 * Two paths (architecture §8.2.2):
 *   - swap_first=true: DEX swaps USDC → RWT, then any USDC leftover is minted
 *     via RWT Engine. We currently never split the input across the two legs
 *     (the on-chain handler hands the FULL `usdc_amount` to one or the other),
 *     so the swap path here estimates the full swap output only.
 *   - swap_first=false: skip DEX entirely; mint full USDC via RWT Engine
 *     (bootstrap / pool-empty path).
 *
 * The bot does NOT replicate the contract's exact arithmetic (a single fee
 * unit-test drift would diverge); instead it computes a CONSERVATIVE estimate
 * using:
 *   - constant-product formula for swap (matches `native_dex::math`)
 *   - net_deposit / NAV for mint (matches `rwt_engine::nav`)
 * Then applies an extra `slippageBps` margin (default 1%) before passing
 * `min_rwt_out` down to the on-chain ix.
 *
 * NAV scale: NAV stored as u64 with 6 decimal places (constants
 * NAV_SCALE = 1_000_000 in rwt-engine). RWT mint is also 6 decimals.
 * USDC is 6 decimals. So:
 *   rwt_out_lamports = (net_deposit_usdc_lamports * NAV_SCALE) / nav
 */

export const NAV_SCALE = 1_000_000n;

/**
 * Mint fee charged by `rwt_engine::mint_rwt` — must match
 * contracts/rwt-engine/src/constants.rs MINT_FEE_BPS (currently 100 = 1%).
 *
 * If the on-chain constant changes, update this AND a regression test will
 * surface the drift on the next contract bump.
 */
export const RWT_MINT_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;

export interface EstimateSwap {
  /** Estimated RWT lamports out (BEFORE outer slippage tolerance). */
  grossOut: bigint;
}

/**
 * Constant-product swap estimate. `usdcSide` indicates which side of the pool
 * is USDC — `'a'` if `pool.tokenAMint == USDC`, else `'b'`.
 *
 * Pool fee is charged on the OUTPUT side (Areal DEX convention).
 */
export function estimateSwap(
  pool: PoolSnapshot,
  usdcIn: bigint,
  usdcSide: 'a' | 'b',
): EstimateSwap {
  if (usdcIn <= 0n) return { grossOut: 0n };
  const reserveIn = usdcSide === 'a' ? pool.reserveA : pool.reserveB;
  const reserveOut = usdcSide === 'a' ? pool.reserveB : pool.reserveA;
  if (reserveIn <= 0n || reserveOut <= 0n) return { grossOut: 0n };
  // x * y = k → out = reserveOut - k/(reserveIn + amountIn)
  // Equivalent: (reserveOut * amountIn) / (reserveIn + amountIn)
  const grossOutBeforeFee = (reserveOut * usdcIn) / (reserveIn + usdcIn);
  const fee = (grossOutBeforeFee * BigInt(pool.feeBps)) / BPS_DENOMINATOR;
  return { grossOut: grossOutBeforeFee - fee };
}

/**
 * Mint estimate: `rwt_engine::mint_rwt`'s output for a given USDC input,
 * using current NAV.
 */
export function estimateMint(usdcIn: bigint, nav: bigint): bigint {
  if (usdcIn <= 0n) return 0n;
  if (nav <= 0n) return 0n;
  const fee = (usdcIn * RWT_MINT_FEE_BPS) / BPS_DENOMINATOR;
  const netDeposit = usdcIn - fee;
  return (netDeposit * NAV_SCALE) / nav;
}

/**
 * Apply the bot's outer slippage margin: returns `expected * (10_000 - bps) / 10_000`.
 */
export function applySlippage(expected: bigint, slippageBps: bigint): bigint {
  if (expected <= 0n) return 0n;
  return (expected * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

/**
 * Decide swap_first vs mint-only and compute (expected, min_rwt_out).
 *
 * Heuristic (architecture §8.2):
 *   - If pool has NON-ZERO reserves AND swap output > mint output → swap_first=true.
 *   - If pool empty / unavailable / mint estimate higher → swap_first=false.
 *
 * Both branches return an `expectedRwt` (0 means we couldn't estimate; the
 * caller should skip with reason `no_pool_no_nav` in that case).
 */
export function chooseRoute(args: {
  usdcAmount: bigint;
  pool: PoolSnapshot | null;
  usdcMint: { equals: (other: PoolSnapshot['tokenAMint']) => boolean };
  nav: bigint;
  slippageBps: bigint;
}): { swapFirst: boolean; expectedRwt: bigint; minRwtOut: bigint } {
  const { usdcAmount, pool, usdcMint, nav, slippageBps } = args;

  let swapEstimate = 0n;
  if (pool && pool.isActive && pool.reserveA > 0n && pool.reserveB > 0n) {
    const usdcSide = usdcMint.equals(pool.tokenAMint) ? 'a' : 'b';
    swapEstimate = estimateSwap(pool, usdcAmount, usdcSide).grossOut;
  }
  const mintEstimate = estimateMint(usdcAmount, nav);

  const swapFirst = swapEstimate > 0n && swapEstimate >= mintEstimate;
  const expectedRwt = swapFirst ? swapEstimate : mintEstimate;
  const minRwtOut = applySlippage(expectedRwt, slippageBps);
  return { swapFirst, expectedRwt, minRwtOut };
}
