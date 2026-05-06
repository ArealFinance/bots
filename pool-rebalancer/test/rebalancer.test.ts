import { describe, it, expect } from 'vitest';
import { RWTVAULT_DISCRIMINATOR } from '@areal/sdk/rwt-engine';
import { decodeNavPrice } from '../src/rebalancer.js';

/**
 * Regression test for the Phase 4 R3 NAV byte-offset bug.
 *
 * Previous versions of `rebalancer.ts` read `nav_book_value` at offset 8 (right
 * after the 8-byte discriminator), but the actual RwtVault layout is:
 *
 *   8  bytes — discriminator
 *  16  bytes — total_invested_capital   (u128)
 *   8  bytes — total_rwt_supply         (u64)
 *   8  bytes — nav_book_value           (u64)   ← offset 32 (NOT 8)
 *  …  remaining 235 bytes of fixed-size fields
 *
 * Reading at offset 8 yielded the LOW half of `total_invested_capital`, not
 * the NAV. This test pins the contract by writing a synthetic vault buffer
 * with a *unique* sentinel at every preceding u64 slot and asserting that
 * `decodeNavPrice` returns the value at offset 32.
 */
describe('decodeNavPrice (Phase 4 R3 regression)', () => {
  function buildVaultBuffer(opts: {
    totalInvestedCapital: bigint;
    totalRwtSupply: bigint;
    navBookValue: bigint;
  }): Buffer {
    const buf = Buffer.alloc(267); // 8 disc + 259 data
    Buffer.from(RWTVAULT_DISCRIMINATOR).copy(buf, 0);

    // total_invested_capital (u128 LE) at offset 8
    const tic = opts.totalInvestedCapital;
    buf.writeBigUInt64LE(tic & 0xffffffffffffffffn, 8);
    buf.writeBigUInt64LE((tic >> 64n) & 0xffffffffffffffffn, 16);

    // total_rwt_supply (u64 LE) at offset 24
    buf.writeBigUInt64LE(opts.totalRwtSupply, 24);

    // nav_book_value (u64 LE) at offset 32
    buf.writeBigUInt64LE(opts.navBookValue, 32);

    // Trailing pubkey/bool/byte fields are left zero — parseRwtVault accepts
    // the zero-byte placeholder and we only assert on navBookValue.
    return buf;
  }

  it('reads nav_book_value at offset 32, NOT offset 8 (the old bug)', () => {
    // Make every preceding u64 slot a sentinel that is wrong on purpose:
    // - low u64 of total_invested_capital  = 11_000_000  (offset 8)
    // - high u64 of total_invested_capital = 22_000_000  (offset 16)
    // - total_rwt_supply                   = 33_000_000  (offset 24)
    // - nav_book_value                     =  5_500_000  (offset 32) ← target
    //
    // 5_500_000 / 1_000_000 (NAV_DECIMALS) = 5.5
    const buf = buildVaultBuffer({
      totalInvestedCapital: (22_000_000n << 64n) | 11_000_000n,
      totalRwtSupply: 33_000_000n,
      navBookValue: 5_500_000n,
    });

    const price = decodeNavPrice(buf);
    expect(price).toBe(5.5);

    // Cross-check: if we mistakenly read at offset 8, we'd get
    // 11_000_000 / 1_000_000 = 11 — assert we did NOT.
    expect(price).not.toBe(11);
  });

  it('returns 0 for buffers with a wrong discriminator', () => {
    const buf = Buffer.alloc(267);
    // Leave discriminator zero — does not match RWTVAULT_DISCRIMINATOR.
    buf.writeBigUInt64LE(5_500_000n, 32);
    expect(decodeNavPrice(buf)).toBe(0);
  });
});
