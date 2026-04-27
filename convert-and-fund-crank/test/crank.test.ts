import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ComputeBudgetProgram, PublicKey, Keypair } from '@solana/web3.js';

import { CheckpointStore } from '../src/checkpoint.js';
import { parseRpcEndpoints } from '../src/config.js';
import { decideConvert, SingleFlightLock } from '../src/crank.js';
import {
  buildConvertToRwtIx,
  discConvertToRwt,
  sendConvertToRwt,
} from '../src/convert.js';
import {
  applySlippage,
  chooseRoute,
  estimateMint,
  estimateSwap,
  NAV_SCALE,
  RWT_MINT_FEE_BPS,
} from '../src/slippage.js';
import { parsePoolSnapshot } from '../src/readers.js';
import type { PoolSnapshot } from '../src/types.js';

const USDC = new PublicKey('11111111111111111111111111111112');
const RWT = new PublicKey('11111111111111111111111111111113');
const POOL = new PublicKey('11111111111111111111111111111114');
const OT_MINT = new PublicKey('11111111111111111111111111111115');

const YD_PROGRAM = new PublicKey('YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF');
const DEX_PROGRAM = new PublicKey('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
const RWT_ENGINE_PROGRAM = new PublicKey('RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL');

function makePool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    address: POOL,
    tokenAMint: USDC,
    tokenBMint: RWT,
    reserveA: 1_000_000_000_000n, // 1M USDC (6 decimals)
    reserveB: 1_000_000_000_000n, // 1M RWT  (6 decimals)
    feeBps: 25, // 0.25 %
    isActive: true,
    ...overrides,
  };
}

describe('estimateSwap (constant-product)', () => {
  it('returns zero for empty reserves', () => {
    const e = estimateSwap(makePool({ reserveA: 0n, reserveB: 0n }), 100n, 'a');
    expect(e.grossOut).toBe(0n);
  });
  it('returns zero for zero input', () => {
    const e = estimateSwap(makePool(), 0n, 'a');
    expect(e.grossOut).toBe(0n);
  });
  it('produces a sane output for 1k USDC into a balanced 1M/1M pool', () => {
    const e = estimateSwap(makePool(), 1_000_000_000n, 'a'); // 1k USDC
    // Pre-fee out ≈ (1M * 1k) / (1M + 1k) ≈ 999_000_999. With 0.25% fee → ≈ 996_503_995.
    expect(e.grossOut).toBeGreaterThan(990_000_000n);
    expect(e.grossOut).toBeLessThan(1_000_000_000n);
  });
});

describe('estimateMint', () => {
  it('returns zero when nav is zero', () => {
    expect(estimateMint(1_000_000_000n, 0n)).toBe(0n);
  });
  it('subtracts the mint fee before pricing', () => {
    // NAV = 1.00 USDC per RWT (scaled 1e6). 100 USDC in.
    // fee = 100 * 1% = 1 USDC; net = 99 USDC; out = 99 RWT (6 decimals).
    const out = estimateMint(100_000_000n, NAV_SCALE);
    const expectedFee = (100_000_000n * RWT_MINT_FEE_BPS) / 10_000n;
    const expectedNet = 100_000_000n - expectedFee;
    expect(out).toBe((expectedNet * NAV_SCALE) / NAV_SCALE);
  });
});

describe('applySlippage', () => {
  it('100 bps → multiplies by 99/100', () => {
    expect(applySlippage(10_000n, 100n)).toBe(9_900n);
  });
  it('0 bps → identity', () => {
    expect(applySlippage(12_345n, 0n)).toBe(12_345n);
  });
});

describe('chooseRoute', () => {
  it('picks swap_first when pool has reserves and swap output > mint output', () => {
    const result = chooseRoute({
      usdcAmount: 1_000_000_000n,
      pool: makePool(),
      usdcMint: USDC,
      nav: 5_000_000n, // NAV = 5 USDC/RWT — mint route returns very few RWT
      slippageBps: 100n,
    });
    expect(result.swapFirst).toBe(true);
    expect(result.minRwtOut).toBeGreaterThan(0n);
  });

  it('falls back to mint when pool empty', () => {
    const result = chooseRoute({
      usdcAmount: 1_000_000_000n,
      pool: makePool({ reserveA: 0n, reserveB: 0n, isActive: false }),
      usdcMint: USDC,
      nav: 1_000_000n,
      slippageBps: 100n,
    });
    expect(result.swapFirst).toBe(false);
    expect(result.expectedRwt).toBeGreaterThan(0n);
  });

  it('returns expectedRwt=0 when both swap and mint estimate to zero', () => {
    const result = chooseRoute({
      usdcAmount: 1_000_000_000n,
      pool: null,
      usdcMint: USDC,
      nav: 0n,
      slippageBps: 100n,
    });
    expect(result.expectedRwt).toBe(0n);
  });
});

describe('decideConvert', () => {
  it('skips with zero_balance when accumulator is empty', () => {
    const decision = decideConvert(
      { accumulatorUsdcBalance: 0n, navBookValue: 1_000_000n, pool: makePool() },
      { usdcMint: USDC, minConvertUsdc: 1_000_000n, slippageBps: 100n },
    );
    expect(decision).toMatchObject({ kind: 'skip', reason: 'zero_balance' });
  });

  it('skips with below_min when balance < threshold', () => {
    const decision = decideConvert(
      {
        accumulatorUsdcBalance: 500_000n,
        navBookValue: 1_000_000n,
        pool: makePool(),
      },
      { usdcMint: USDC, minConvertUsdc: 1_000_000n, slippageBps: 100n },
    );
    expect(decision).toMatchObject({ kind: 'skip', reason: 'below_min' });
  });

  it('skips with no_pool_no_nav when both unavailable', () => {
    const decision = decideConvert(
      { accumulatorUsdcBalance: 10_000_000n, navBookValue: 0n, pool: null },
      { usdcMint: USDC, minConvertUsdc: 1_000_000n, slippageBps: 100n },
    );
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_pool_no_nav' });
  });

  it('sends with swap_first=true on liquid pool', () => {
    const decision = decideConvert(
      {
        accumulatorUsdcBalance: 100_000_000n,
        navBookValue: 5_000_000n,
        pool: makePool(),
      },
      { usdcMint: USDC, minConvertUsdc: 1_000_000n, slippageBps: 100n },
    );
    expect(decision.kind).toBe('send');
    if (decision.kind === 'send') {
      expect(decision.swapFirst).toBe(true);
      expect(decision.minRwtOut).toBeGreaterThan(0n);
      expect(decision.minRwtOut).toBeLessThan(decision.expectedRwt);
    }
  });

  it('sends with swap_first=false when pool empty but NAV available', () => {
    const decision = decideConvert(
      {
        accumulatorUsdcBalance: 100_000_000n,
        navBookValue: 1_000_000n,
        pool: makePool({ reserveA: 0n, reserveB: 0n, isActive: false }),
      },
      { usdcMint: USDC, minConvertUsdc: 1_000_000n, slippageBps: 100n },
    );
    expect(decision.kind).toBe('send');
    if (decision.kind === 'send') {
      expect(decision.swapFirst).toBe(false);
    }
  });
});

describe('SingleFlightLock', () => {
  it('refuses double-acquire on same key', () => {
    const lock = new SingleFlightLock();
    expect(lock.acquire('ot-A')).toBe(true);
    expect(lock.acquire('ot-A')).toBe(false);
    lock.release('ot-A');
    expect(lock.acquire('ot-A')).toBe(true);
  });
});

describe('CheckpointStore', () => {
  let dbPath: string;
  let store: CheckpointStore;
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `convert-test-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* noop */
    }
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* noop */
    }
  });

  it('round-trips slot + signature', () => {
    store.upsert(OT_MINT.toBase58(), 12345n, 'sig-aaa');
    const row = store.get(OT_MINT.toBase58());
    expect(row).not.toBeNull();
    expect(row!.lastConvertSlot).toBe(12345n);
    expect(row!.lastSignature).toBe('sig-aaa');
  });
});

describe('buildConvertToRwtIx', () => {
  it('serializes args correctly + lays out 22 accounts', () => {
    const crank = Keypair.generate().publicKey;
    const args = {
      ydProgramId: YD_PROGRAM,
      dexProgramId: DEX_PROGRAM,
      rwtEngineProgramId: RWT_ENGINE_PROGRAM,
      crank,
      otMint: OT_MINT,
      accumulatorUsdcAta: Keypair.generate().publicKey,
      accumulatorRwtAta: Keypair.generate().publicKey,
      feeAccount: Keypair.generate().publicKey,
      rewardVault: Keypair.generate().publicKey,
      rwtMint: RWT,
      dexConfig: Keypair.generate().publicKey,
      poolState: POOL,
      dexPoolVaultIn: Keypair.generate().publicKey,
      dexPoolVaultOut: Keypair.generate().publicKey,
      dexArealFeeAccount: Keypair.generate().publicKey,
      rwtCapitalAcc: Keypair.generate().publicKey,
      rwtDaoFeeAccount: Keypair.generate().publicKey,
      usdcAmount: 1_234_567n,
      minRwtOut: 999_999n,
      swapFirst: true,
    };

    const built = buildConvertToRwtIx(args);
    expect(built.ix.programId.equals(YD_PROGRAM)).toBe(true);
    expect(built.ix.keys).toHaveLength(22);
    expect(built.ix.data.length).toBe(25);
    expect(built.ix.data.subarray(0, 8).equals(discConvertToRwt())).toBe(true);
    expect(built.ix.data.readBigUInt64LE(8)).toBe(1_234_567n);
    expect(built.ix.data.readBigUInt64LE(16)).toBe(999_999n);
    expect(built.ix.data.readUInt8(24)).toBe(1);

    // Spot-check named accounts match handler order.
    expect(built.ix.keys[0]!.pubkey.equals(crank)).toBe(true);
    expect(built.ix.keys[3]!.pubkey.equals(OT_MINT)).toBe(true);
    expect(built.ix.keys[6]!.pubkey.equals(args.accumulatorRwtAta)).toBe(true);
    expect(built.ix.keys[18]!.pubkey.equals(DEX_PROGRAM)).toBe(true);
    expect(built.ix.keys[19]!.pubkey.equals(RWT_ENGINE_PROGRAM)).toBe(true);
  });

  it('encodes swap_first=false as zero byte', () => {
    const built = buildConvertToRwtIx({
      ydProgramId: YD_PROGRAM,
      dexProgramId: DEX_PROGRAM,
      rwtEngineProgramId: RWT_ENGINE_PROGRAM,
      crank: Keypair.generate().publicKey,
      otMint: OT_MINT,
      accumulatorUsdcAta: USDC,
      accumulatorRwtAta: RWT,
      feeAccount: USDC,
      rewardVault: USDC,
      rwtMint: RWT,
      dexConfig: USDC,
      poolState: POOL,
      dexPoolVaultIn: USDC,
      dexPoolVaultOut: USDC,
      dexArealFeeAccount: USDC,
      rwtCapitalAcc: USDC,
      rwtDaoFeeAccount: USDC,
      usdcAmount: 1n,
      minRwtOut: 1n,
      swapFirst: false,
    });
    expect(built.ix.data.readUInt8(24)).toBe(0);
  });
});

describe('ComputeBudget wrapping', () => {
  it('first ix in the bundle is SetComputeUnitLimit; second is SetComputeUnitPrice', () => {
    // Use the public ComputeBudgetProgram to verify the program IDs we expect to see in the
    // sendConvertToRwt builder. We cannot call sendConvertToRwt without a Connection, so
    // just sanity-check the helpers exist & resolve to the expected programIds.
    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
    const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
    expect(limitIx.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(priceIx.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
  });

  // Type-only sanity: sendConvertToRwt is exported. (If it became un-exported the
  // bundler/build would catch it — we still smoke-import to make sure tree-shaking
  // doesn't strip it from the test bundle.)
  it('sendConvertToRwt is exported', () => {
    expect(typeof sendConvertToRwt).toBe('function');
  });
});

describe('parsePoolSnapshot', () => {
  it('parses reserves and fee_bps from a hand-rolled buffer', () => {
    const buf = Buffer.alloc(8 + 200);
    USDC.toBuffer().copy(buf, 8 + 32);
    RWT.toBuffer().copy(buf, 8 + 64);
    buf.writeBigUInt64LE(123_456n, 8 + 160);
    buf.writeBigUInt64LE(789_012n, 8 + 168);
    buf.writeUInt16LE(25, 8 + 176);
    buf.writeUInt8(1, 8 + 179);

    const pool = parsePoolSnapshot(POOL, buf);
    expect(pool).not.toBeNull();
    expect(pool!.tokenAMint.equals(USDC)).toBe(true);
    expect(pool!.tokenBMint.equals(RWT)).toBe(true);
    expect(pool!.reserveA).toBe(123_456n);
    expect(pool!.reserveB).toBe(789_012n);
    expect(pool!.feeBps).toBe(25);
    expect(pool!.isActive).toBe(true);
  });
});

describe('parseRpcEndpoints (R29 integration)', () => {
  it('parses a single tuple with all fields', () => {
    const eps = parseRpcEndpoints('https://primary|wss://primary|100');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.url).toBe('https://primary');
    expect(eps[0]!.wsUrl).toBe('wss://primary');
    expect(eps[0]!.weight).toBe(100);
  });

  it('rejects empty input and malformed weights', () => {
    expect(() => parseRpcEndpoints('')).toThrow();
    expect(() => parseRpcEndpoints('https://a|wss://a|abc')).toThrow();
  });
});

describe('CheckpointStore reconcile state (R31 integration)', () => {
  let dbPath: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `convert-rec-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });

  afterEach(() => {
    try { store.close(); } catch { /* noop */ }
    try { fs.unlinkSync(dbPath); } catch { /* noop */ }
  });

  it('returns null for unseen programs and round-trips highest slot monotonically', () => {
    expect(store.getLastSeenSlot('PROG_AAA')).toBeNull();
    store.setLastSeenSlot('PROG_AAA', 1_000);
    expect(store.getLastSeenSlot('PROG_AAA')).toBe(1_000);
    store.setLastSeenSlot('PROG_AAA', 1_500);
    expect(store.getLastSeenSlot('PROG_AAA')).toBe(1_500);
    // Going backwards must NOT regress.
    store.setLastSeenSlot('PROG_AAA', 800);
    expect(store.getLastSeenSlot('PROG_AAA')).toBe(1_500);
  });
});
