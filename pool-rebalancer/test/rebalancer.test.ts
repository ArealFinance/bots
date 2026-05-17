import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'buffer';
import {
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { RWTVAULT_DISCRIMINATOR } from '@areal/sdk/rwt-engine';
import {
  POOLSTATE_DISCRIMINATOR,
  parsePoolState,
} from '@areal/sdk/native-dex';
import { navToBin as sdkNavToBin } from '@areal/sdk/tx';
import {
  findBinArrayPda,
  findDexConfigPda,
  findLiquidityNexusPda,
  findRwtVaultPda,
  findAssociatedTokenAddressPda,
} from '@areal/sdk/pda';

import {
  decodeNavPrice,
  Rebalancer,
  type PoolInfo,
  type RpcAdapter,
} from '../src/rebalancer.js';
import { CONFIG } from '../src/config.js';

// ─────────────────────────── decodeNavPrice ────────────────────────────────

/**
 * Regression test for the Phase 4 R3 NAV byte-offset bug.
 *
 * Previous versions of `rebalancer.ts` read `nav_book_value` at offset 8
 * (right after the 8-byte discriminator), but the actual RwtVault layout is:
 *
 *   8  bytes — discriminator
 *  16  bytes — total_invested_capital   (u128)
 *   8  bytes — total_rwt_supply         (u64)
 *   8  bytes — nav_book_value           (u64)   ← offset 32 (NOT 8)
 *  …  remaining bytes of fixed-size fields
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

    const tic = opts.totalInvestedCapital;
    buf.writeBigUInt64LE(tic & 0xffffffffffffffffn, 8);
    buf.writeBigUInt64LE((tic >> 64n) & 0xffffffffffffffffn, 16);
    buf.writeBigUInt64LE(opts.totalRwtSupply, 24);
    buf.writeBigUInt64LE(opts.navBookValue, 32);
    return buf;
  }

  it('reads nav_book_value at offset 32, NOT offset 8 (the old bug)', () => {
    const buf = buildVaultBuffer({
      totalInvestedCapital: (22_000_000n << 64n) | 11_000_000n,
      totalRwtSupply: 33_000_000n,
      navBookValue: 5_500_000n,
    });

    const out = decodeNavPrice(buf);
    expect(out).not.toBeNull();
    expect(out!.navRaw).toBe(5_500_000n);
    expect(out!.navPrice).toBe(5.5);
    // Cross-check: if we mistakenly read at offset 8 we'd get 11.
    expect(out!.navPrice).not.toBe(11);
  });

  it('returns null for buffers with a wrong discriminator', () => {
    const buf = Buffer.alloc(267);
    buf.writeBigUInt64LE(5_500_000n, 32);
    expect(decodeNavPrice(buf)).toBeNull();
  });
});

// ───────────────────────── decision-tree harness ───────────────────────────

const DEX_PROGRAM_ID = new PublicKey(CONFIG.DEX_PROGRAM_ID);
const RWT_ENGINE_PROGRAM_ID = new PublicKey(
  // Any valid pubkey works for the harness — the bot never compares it.
  'EngineEngineEngineEngineEngineEngineEngine11',
);

const [RWT_VAULT_PDA] = findRwtVaultPda(RWT_ENGINE_PROGRAM_ID);
const [LIQUIDITY_NEXUS_PDA] = findLiquidityNexusPda(DEX_PROGRAM_ID);
const [DEX_CONFIG_PDA] = findDexConfigPda(DEX_PROGRAM_ID);

/** Stub `Connection.getAccountInfo` payload for the RWT vault. */
function buildRwtVaultAccount(navRaw: bigint): { data: Buffer } {
  const buf = Buffer.alloc(267);
  Buffer.from(RWTVAULT_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(navRaw, 32);
  return { data: buf };
}

interface FakeRpcOptions {
  vaultNavRaw: bigint | null; // null = vault not found
  nexusUsdcBalance: bigint | 'throw';
  /** If set, sendAndConfirm throws this on every attempt instead of returning. */
  failTx?: Error;
  /** Override the returned signature (defaults to deterministic "sig-N"). */
  signature?: string;
}

function buildFakeRpc(opts: FakeRpcOptions): {
  rpc: RpcAdapter;
  txAttempts: () => number;
  lastTx: () => Transaction | null;
} {
  let attempts = 0;
  let lastTx: Transaction | null = null;

  const rpc: RpcAdapter = {
    async getAccountInfo(pubkey) {
      if (pubkey.equals(RWT_VAULT_PDA)) {
        if (opts.vaultNavRaw === null) return null;
        return buildRwtVaultAccount(opts.vaultNavRaw);
      }
      return null;
    },
    async getTokenAccountBalance(_pubkey) {
      if (opts.nexusUsdcBalance === 'throw') {
        throw new Error('ATA not found');
      }
      return { value: { amount: opts.nexusUsdcBalance.toString() } };
    },
    async sendAndConfirm(tx, _signers) {
      attempts += 1;
      lastTx = tx;
      if (opts.failTx) throw opts.failTx;
      return opts.signature ?? `sig-${attempts}`;
    },
  };
  return { rpc, txAttempts: () => attempts, lastTx: () => lastTx };
}

function makePool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  const poolAddr = PublicKey.unique();
  const [binArrayPda] = findBinArrayPda(poolAddr, DEX_PROGRAM_ID);
  return {
    address: poolAddr,
    binArrayPda,
    poolType: 1, // CONCENTRATED
    isActive: true,
    reserveA: 1_000_000n,
    reserveB: 1_000_000n,
    binStepBps: 10, // 0.1% per bin
    activeBinId: 0,
    lastRebalanceNavBin: 0,
    vaultB: PublicKey.unique(),
    tokenBMint: PublicKey.unique(),
    ...overrides,
  };
}

describe('Rebalancer decision tree (CP-9)', () => {
  const wallet = Keypair.generate();

  beforeEach(() => {
    // No persistent state between tests — debounce map is per-Rebalancer-instance.
  });

  it('skips non-concentrated pools', async () => {
    const { rpc } = buildFakeRpc({ vaultNavRaw: 1_000_000n, nexusUsdcBalance: 0n });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ poolType: 0 }); // CLASSIC
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('wrong_pool_type');
  });

  it('skips inactive pools', async () => {
    const { rpc } = buildFakeRpc({ vaultNavRaw: 1_000_000n, nexusUsdcBalance: 0n });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ isActive: false });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('pool_inactive');
  });

  it('skips when |deviation| < threshold', async () => {
    // refBin = 0 → refPrice = 1.0. NAV = 1.005 (0.5% drift) is below the
    // 1% threshold.
    const { rpc } = buildFakeRpc({
      vaultNavRaw: 1_005_000n, // 1.005 in NAV-scale (6 dec)
      nexusUsdcBalance: 1_000_000n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('below_threshold');
  });

  it('skips growth path when Nexus accumulator is empty (balance=0)', async () => {
    // refBin = 0, NAV = 1.05 → +5% > threshold. Growth direction.
    // Nexus balance = 0 → skip with reason="nexus_empty".
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 1_050_000n,
      nexusUsdcBalance: 0n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('nexus_empty');
    expect(txAttempts()).toBe(0); // No tx attempted.
  });

  it('skips growth path when Nexus ATA is missing (throws)', async () => {
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 1_050_000n,
      nexusUsdcBalance: 'throw',
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('nexus_empty');
    expect(txAttempts()).toBe(0);
  });

  it('submits grow_liquidity when NAV rises and Nexus is funded', async () => {
    const { rpc, txAttempts, lastTx } = buildFakeRpc({
      vaultNavRaw: 1_050_000n, // 1.05
      nexusUsdcBalance: 10_000_000n,
      signature: 'grow-sig-1',
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('grow_submitted');
    if (decision.kind === 'grow_submitted') {
      const expectedBin = sdkNavToBin(1_050_000n, 10)!;
      expect(decision.newNavBin).toBe(expectedBin);
      expect(decision.newNavBin).toBeGreaterThan(0); // direction sanity
      expect(decision.signature).toBe('grow-sig-1');
      expect(decision.nexusBalance).toBe(10_000_000n);
    }
    expect(txAttempts()).toBe(1);

    // The submitted instruction must reference the resolved Nexus ATA, the
    // dex-config PDA, and the dex-program-id (positional sanity check).
    const tx = lastTx();
    expect(tx).not.toBeNull();
    const ix = tx!.instructions[0];
    expect(ix.programId.equals(DEX_PROGRAM_ID)).toBe(true);
    expect(ix.keys[1].pubkey.equals(DEX_CONFIG_PDA)).toBe(true);
    expect(ix.keys[4].pubkey.equals(LIQUIDITY_NEXUS_PDA)).toBe(true);
    const [expectedAta] = findAssociatedTokenAddressPda(
      LIQUIDITY_NEXUS_PDA,
      pool.tokenBMint,
    );
    expect(ix.keys[5].pubkey.equals(expectedAta)).toBe(true);
    expect(ix.keys[6].pubkey.equals(pool.vaultB)).toBe(true);
    expect(ix.keys[7].pubkey.equals(RWT_VAULT_PDA)).toBe(true);
  });

  it('submits compress_liquidity when NAV falls below refBin', async () => {
    // refBin = 100, NAV ≈ 0.9 → newNavBin < refBin → compress.
    // (Pick a NAV well below price_at_bin(10, 100) = (1.001)^100 ≈ 1.1052.)
    const { rpc, txAttempts, lastTx } = buildFakeRpc({
      vaultNavRaw: 900_000n,
      nexusUsdcBalance: 0n, // irrelevant for compress
      signature: 'compress-sig-1',
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 100, binStepBps: 10 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('compression_submitted');
    if (decision.kind === 'compression_submitted') {
      const expectedBin = sdkNavToBin(900_000n, 10)!;
      expect(decision.newNavBin).toBe(expectedBin);
      expect(decision.newNavBin).toBeLessThan(100);
      expect(decision.signature).toBe('compress-sig-1');
    }
    expect(txAttempts()).toBe(1);

    // compress_liquidity has 5 accounts (no Nexus / no token vaults).
    const tx = lastTx();
    const ix = tx!.instructions[0];
    expect(ix.keys.length).toBe(5);
    expect(ix.keys[2].pubkey.equals(pool.address)).toBe(true);
    expect(ix.keys[4].pubkey.equals(RWT_VAULT_PDA)).toBe(true);
  });

  it('debounces back-to-back successful submissions on the same pool', async () => {
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 1_050_000n,
      nexusUsdcBalance: 10_000_000n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });

    const first = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(first.kind).toBe('grow_submitted');
    expect(txAttempts()).toBe(1);

    const second = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(second.kind).toBe('skip');
    if (second.kind === 'skip') expect(second.reason).toBe('debounce');
    expect(txAttempts()).toBe(1); // No further submission.
  });

  it('returns submission_failed after exhausting MAX_RETRIES (no debounce stamp)', async () => {
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 1_050_000n,
      nexusUsdcBalance: 10_000_000n,
      failTx: new Error('simulated CPI failure'),
    });
    // Shrink the backoff so the test doesn't sleep 75+ seconds.
    const originalBase = CONFIG.RETRY_BASE_DELAY_MS;
    const originalMax = CONFIG.MAX_RETRIES;
    CONFIG.RETRY_BASE_DELAY_MS = 1;
    CONFIG.MAX_RETRIES = 3;
    try {
      const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
      const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 10 });
      const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
      expect(decision.kind).toBe('submission_failed');
      if (decision.kind === 'submission_failed') {
        expect(decision.pathway).toBe('grow');
        expect(decision.error).toContain('simulated CPI failure');
      }
      expect(txAttempts()).toBe(3);

      // Failure must NOT stamp debounce — next cycle should retry, not skip.
      const retry = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
      expect(retry.kind).toBe('submission_failed');
      expect(txAttempts()).toBe(6); // 3 + 3
    } finally {
      CONFIG.RETRY_BASE_DELAY_MS = originalBase;
      CONFIG.MAX_RETRIES = originalMax;
    }
  });

  it('returns noop when float deviation crosses threshold but newNavBin == refBin', async () => {
    // With binStepBps = 1000 (10% step) and refBin = 0, the bin boundary
    // around 1.0 is wide. NAV = 1.05 is +5% (above 1%) but still rounds
    // down to bin 0 (price_at_bin(1000, 0) = 1.0; bin 1 = 1.10 > 1.05).
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 1_050_000n,
      nexusUsdcBalance: 10_000_000n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool({ lastRebalanceNavBin: 0, binStepBps: 1000 });
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('noop');
    expect(txAttempts()).toBe(0);
  });

  it('skips when RWT vault account is missing', async () => {
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: null,
      nexusUsdcBalance: 10_000_000n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool();
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('nav_unreadable');
    expect(txAttempts()).toBe(0);
  });

  it('skips when NAV is zero (post-writedown vault wipe)', async () => {
    const { rpc, txAttempts } = buildFakeRpc({
      vaultNavRaw: 0n,
      nexusUsdcBalance: 10_000_000n,
    });
    const r = new Rebalancer(rpc, wallet, { dexProgramId: DEX_PROGRAM_ID });
    const pool = makePool();
    const decision = await r.checkAndRebalance(pool, RWT_VAULT_PDA);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('nav_zero');
    expect(txAttempts()).toBe(0);
  });
});

// ──────────── sanity: SDK discriminator wired through to bot ────────────

describe('parsePoolState wiring', () => {
  it('exposes POOLSTATE_DISCRIMINATOR (Layer 9 + CP-1 size drift safety)', () => {
    // The bot's discovery loop uses this discriminator directly via memcmp.
    // If the SDK regenerates and changes it, this assertion fails loudly
    // here rather than silently returning zero pools at runtime.
    expect(POOLSTATE_DISCRIMINATOR.length).toBe(8);
    // Discriminator is content-addressed via sha256("account:PoolState")[..8].
    // We don't pin the exact bytes here (that's the SDK's job) — just shape.
  });

  it('parsePoolState is the source of truth for byte layout', () => {
    // Cross-check that the SDK helper is callable. Actual byte-layout
    // pinning lives in the SDK's own test suite.
    expect(typeof parsePoolState).toBe('function');
  });
});
