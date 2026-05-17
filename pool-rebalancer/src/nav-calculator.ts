// Off-chain NAV ↔ bin math for the Pool Rebalancer (CP-9).
//
// The bot makes two qualitatively different decisions and uses two different
// precisions:
//
//   1. "Is the deviation above the threshold?" — a float compare against
//      `REBALANCE_THRESHOLD` (e.g. 0.01). Tolerance-OK; the threshold
//      itself is a 1% bucket so sub-ULP precision is meaningless.
//
//   2. "What new_nav_bin do we submit?" — this value lands on-chain and
//      must agree with the contract's Q-fixed-point ladder. We delegate to
//      the SDK's `navToBin` helper, which mirrors `pow_bps` byte-for-byte.
//
// Keeping both helpers in one place lets the decision logic stay obvious
// (`shouldRebalance(navPrice, refPrice)` vs `targetNavBin(nav, binStepBps)`).

import { navToBin as sdkNavToBin } from '@areal/sdk/tx';

/**
 * Float price at a given bin: `(1 + binStepBps / 10_000) ** bin`.
 *
 * Used only for the deviation float compare — never sent on-chain. For the
 * Q-fixed-point version (used in routing decisions across the SDK) see
 * `priceAtBin` in `@areal/sdk/tx`.
 */
export function priceAtBinFloat(binStepBps: number, bin: number): number {
  if (binStepBps <= 0) {
    throw new Error(`priceAtBinFloat: binStepBps must be > 0 (got ${binStepBps})`);
  }
  return Math.pow(1 + binStepBps / 10_000, bin);
}

/**
 * Signed fractional deviation of `navPrice` from `refPrice`.
 *
 * `(navPrice - refPrice) / refPrice` — positive when NAV has risen above
 * the last rebalance reference (→ grow path), negative when it has fallen
 * (→ compress path).
 */
export function deviation(navPrice: number, refPrice: number): number {
  if (refPrice === 0) return navPrice === 0 ? 0 : Infinity;
  return (navPrice - refPrice) / refPrice;
}

/**
 * Off-chain inverse of `priceAtBin`: given a NAV in NAV-scale units
 * (default 6-decimal USDC, matching `RwtVault.nav_book_value`), return the
 * largest bin whose Q-fixed-point price is ≤ NAV.
 *
 * Thin wrapper around the SDK helper so the bot has a single, named
 * import for this math and the SDK source-of-truth dependency is visible
 * to grep / `npm ls`.
 *
 * Throws (rather than returning `null`) so callers don't have to thread
 * an extra error branch through the decision tree — `navToBin` only
 * returns `null` for inputs that the bot already filters out
 * (`nav <= 0`, `binStepBps` out of range), so a thrown error here is a
 * genuine bug / corrupted state.
 */
export function navToBin(nav: bigint, binStepBps: number): number {
  const bin = sdkNavToBin(nav, binStepBps);
  if (bin === null) {
    throw new Error(
      `navToBin: SDK returned null for nav=${nav}, binStepBps=${binStepBps}`,
    );
  }
  return bin;
}
