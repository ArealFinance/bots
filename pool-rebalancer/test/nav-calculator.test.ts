// CP-12.5 sanity test for the off-chain NAV → bin → price round-trip.
//
// The on-chain `grow_liquidity` / `compress_liquidity` instructions reject
// (`NavBinMismatch`) when the rebalancer's `new_nav_bin` is more than
// ±2× `bin_step_bps` away from the live NAV. If the bot's off-chain math
// drifts beyond that tolerance — even by a sub-ULP — every submitted tx
// would revert at runtime.
//
// This test pins the invariant pre-flight:
//
//   for nav ∈ {1.0, 1.07, 2.0, 5.0} (USDC, 6-decimal):
//     bin = navToBin(nav, step)
//     price_back = priceAtBinFloat(step, bin)
//     |price_back − nav| / nav ≤ 2 × bin_step_bps / 10_000
//
// It mirrors the on-chain tolerance gate in
// `contracts/native-dex/src/concentrated.rs::nav_bin_within_tolerance`
// (Q-fixed-point), using the same algebraic relationship in float space.
// A failure here means: ship breaks before deploy, not after.

import { describe, it, expect } from 'vitest';
import {
  navToBin,
  priceAtBinFloat,
  deviation,
} from '../src/nav-calculator.js';

const NAV_DECIMALS = 1_000_000n;

/** Convert a float NAV to the 6-decimal-USDC `bigint` scale the bot uses. */
function navToScale(nav: number): bigint {
  return BigInt(Math.round(nav * Number(NAV_DECIMALS)));
}

describe('navToBin / priceAtBinFloat round-trip (CP-12.5 sanity)', () => {
  // Representative (NAV, bin_step_bps) fixtures.
  //
  // The on-chain ladder spans ±MAX_BINS (= 630) bins, so for any given
  // bin_step_bps the reachable NAV range is `(1 + step/10_000)^±630`. NAVs
  // outside that window are off-pool — `navToBin` saturates at the boundary
  // and any tolerance check on that saturation point is meaningless
  // (the bot would have to widen `bin_step_bps`, not pin a tighter test).
  //
  // The fixtures below are chosen so each NAV is comfortably *inside* the
  // ladder range for its step:
  //   - step =  10 bps (0.1%): range ≈ [0.53, 1.88]. NAVs: 1.00, 1.07, 1.50.
  //   - step =  50 bps (0.5%): range ≈ [0.04, 23.5]. NAVs: 1.00, 1.50, 2.00, 5.00.
  //   - step = 100 bps (1.0%): range ≈ [0.002, 525].  NAVs: 1.00, 1.50, 2.00, 5.00.
  const FIXTURES: Array<{ nav: number; step: number }> = [
    { nav: 1.0, step: 10 },
    { nav: 1.07, step: 10 },
    { nav: 1.5, step: 10 },
    { nav: 1.0, step: 50 },
    { nav: 1.5, step: 50 },
    { nav: 2.0, step: 50 },
    { nav: 5.0, step: 50 },
    { nav: 1.0, step: 100 },
    { nav: 1.5, step: 100 },
    { nav: 2.0, step: 100 },
    { nav: 5.0, step: 100 },
  ];

  for (const { nav, step } of FIXTURES) {
    it(`stays within ±2× bin_step_bps for NAV=${nav}, step=${step}bps`, () => {
      const navRaw = navToScale(nav);
      const bin = navToBin(navRaw, step);
      const priceBack = priceAtBinFloat(step, bin);

      // |deviation| ≤ 2 × bin_step_bps / 10_000 (matches on-chain gate
      // exactly). `deviation()` returns a signed fraction so we abs() it.
      const dev = Math.abs(deviation(priceBack, nav));
      const tolerance = (2 * step) / 10_000;

      expect(dev).toBeLessThanOrEqual(tolerance);

      // Also check that `bin + 1` would overshoot — i.e. `navToBin` is
      // genuinely returning the floor of the bin ladder. Without this
      // the round-trip could pass trivially by always returning bin 0.
      const priceAtNextBin = priceAtBinFloat(step, bin + 1);
      expect(priceAtNextBin).toBeGreaterThan(nav);
    });
  }

  it('round-trip at NAV = 1.0 lands exactly on bin 0', () => {
    // Special case: priceAtBin(_, 0) = 1.0 by definition, so the round-trip
    // is a hard equality — any drift here would be a serious bug in the
    // SDK helper, not a tolerance question.
    const bin = navToBin(navToScale(1.0), 10);
    expect(bin).toBe(0);
    expect(priceAtBinFloat(10, bin)).toBe(1.0);
  });
});
