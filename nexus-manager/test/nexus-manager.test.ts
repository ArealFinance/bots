import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  decideRebalance,
  type ManagerStrategyConfig,
} from '../src/decision-engine.js';
import {
  parseLiquidityNexus,
  parseLpPosition,
} from '../src/nexus-state-reader.js';
import {
  buildNexusSwapIx,
  discNexusSwap,
  SPL_TOKEN_PROGRAM_ID,
} from '../src/tx-builders/nexus-swap.js';
import {
  buildNexusAddLiquidityIx,
  discNexusAddLiquidity,
} from '../src/tx-builders/nexus-add-liquidity.js';
import {
  buildNexusRemoveLiquidityIx,
  discNexusRemoveLiquidity,
} from '../src/tx-builders/nexus-remove-liquidity.js';
import type {
  LiquidityNexusState,
  NexusAccountContext,
  PoolAccountContext,
  PoolStateInfo,
} from '../src/types.js';

// =============================================================================
// Fixture builders
// =============================================================================

const ZERO = new PublicKey(Buffer.alloc(32, 0));
const MANAGER = new PublicKey(Buffer.alloc(32, 1));
const USDC_MINT = new PublicKey(Buffer.alloc(32, 2));
const RWT_MINT = new PublicKey(Buffer.alloc(32, 3));
const POOL = new PublicKey(Buffer.alloc(32, 4));
const VAULT_A = new PublicKey(Buffer.alloc(32, 5));
const VAULT_B = new PublicKey(Buffer.alloc(32, 6));
const NEXUS_PDA = new PublicKey(Buffer.alloc(32, 7));
const NEXUS_USDC_ATA = new PublicKey(Buffer.alloc(32, 8));
const NEXUS_RWT_ATA = new PublicKey(Buffer.alloc(32, 9));
const DEX_PROGRAM_ID = new PublicKey(Buffer.alloc(32, 10));
const DEX_CONFIG = new PublicKey(Buffer.alloc(32, 11));
const AREAL_FEE = new PublicKey(Buffer.alloc(32, 12));
const LP_POSITION = new PublicKey(Buffer.alloc(32, 13));

function nexusState(overrides: Partial<LiquidityNexusState> = {}): LiquidityNexusState {
  return {
    manager: MANAGER,
    totalDepositedUsdc: 0n,
    totalDepositedRwt: 0n,
    isActive: true,
    bump: 254,
    ...overrides,
  };
}

function poolState(overrides: Partial<PoolStateInfo> = {}): PoolStateInfo {
  return {
    pool: POOL,
    tokenAMint: USDC_MINT,
    tokenBMint: RWT_MINT,
    vaultA: VAULT_A,
    vaultB: VAULT_B,
    reserveA: 1_000_000_000n,
    reserveB: 1_000_000_000n,
    totalLpShares: 1_000_000n,
    isActive: true,
    cumulativeFeesPerShareA: 0n,
    cumulativeFesPerShareB: 0n,
    ...overrides,
  };
}

const cfg: ManagerStrategyConfig = {
  minRebalanceUsdc: 1_000_000n,
  lpTargetRatioBps: 5_000,
  lpRebalanceTriggerBps: 500,
  maxPoolConcentrationBps: 5_000,
  usdcMint: USDC_MINT,
  rwtMint: RWT_MINT,
};

const baseCtx: NexusAccountContext = {
  dexProgramId: DEX_PROGRAM_ID,
  dexConfig: DEX_CONFIG,
  liquidityNexus: NEXUS_PDA,
  manager: MANAGER,
  arealFeeAccount: AREAL_FEE,
  nexusUsdcAta: NEXUS_USDC_ATA,
  nexusRwtAta: NEXUS_RWT_ATA,
};

const poolCtx: PoolAccountContext = {
  pool: POOL,
  vaultA: VAULT_A,
  vaultB: VAULT_B,
  lpPosition: LP_POSITION,
};

// =============================================================================
// decision-engine
// =============================================================================

describe('decideRebalance — kill-switch (D22)', () => {
  it('returns killSwitch when manager is the zero pubkey (D22 first check)', () => {
    const decision = decideRebalance({
      nexus: nexusState({ manager: ZERO }),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    expect(decision).toMatchObject({ kind: 'killSwitch', reason: 'manager_zero' });
  });

  it('returns killSwitch when is_active is false', () => {
    const decision = decideRebalance({
      nexus: nexusState({ isActive: false }),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    expect(decision).toMatchObject({ kind: 'killSwitch', reason: 'is_active_false' });
  });

  it('manager_zero takes priority over is_active_false', () => {
    const decision = decideRebalance({
      nexus: nexusState({ manager: ZERO, isActive: false }),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    // D22 ordering — kill-switch sentinel reported first.
    expect(decision).toMatchObject({ kind: 'killSwitch', reason: 'manager_zero' });
  });
});

describe('decideRebalance — idle below threshold', () => {
  it('returns noop when total idle < MIN_REBALANCE_USDC', () => {
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 100n, rwt: 100n }, // sum = 200, threshold = 1_000_000
      cfg,
    });
    expect(decision).toMatchObject({ kind: 'noop', reason: 'idle_below_min_rebalance' });
  });
});

describe('decideRebalance — drift swap', () => {
  it('emits swap when USDC fraction is far above target (>5% bps drift)', () => {
    // 95% USDC, 5% RWT → 4500bps drift > 500bps trigger
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 9_500_000n, rwt: 500_000n },
      cfg,
    });
    expect(decision.kind).toBe('swap');
    if (decision.kind === 'swap') {
      expect(decision.amountIn).toBeGreaterThan(0n);
      expect(decision.minAmountOut).toBeGreaterThan(0n);
      // USDC is on side A; over-weighted USDC means swap A → B (aToB=true).
      expect(decision.aToB).toBe(true);
    }
  });

  it('emits swap with aToB=false when RWT (side B) is over-weighted in USDC-on-A pool', () => {
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 500_000n, rwt: 9_500_000n },
      cfg,
    });
    expect(decision.kind).toBe('swap');
    if (decision.kind === 'swap') {
      // Over-weighted RWT → swap B → A (aToB=false).
      expect(decision.aToB).toBe(false);
    }
  });

  it('skips drift swap when within trigger window', () => {
    // 52% USDC / 48% RWT — 200bps drift, below 500bps trigger.
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState()],
      balances: { usdc: 5_200_000n, rwt: 4_800_000n },
      cfg,
    });
    // Expected: idle deploy path triggers instead of swap.
    expect(decision.kind).toBe('addLiquidity');
  });
});

describe('decideRebalance — idle deploy', () => {
  it('emits addLiquidity when balanced idle is above threshold', () => {
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState({ reserveA: 100_000_000n, reserveB: 100_000_000n })],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    expect(decision.kind).toBe('addLiquidity');
    if (decision.kind === 'addLiquidity') {
      // Cap = 50% × 100M = 50M; idle (5M) is well below cap.
      expect(decision.amountA).toBe(5_000_000n);
      expect(decision.amountB).toBe(5_000_000n);
      expect(decision.minShares).toBeGreaterThan(0n);
    }
  });

  it('caps amount by MAX_POOL_CONCENTRATION_BPS of reserves', () => {
    // Pool is small (1M reserve each); cap = 50% × 1M = 500K.
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState({ reserveA: 1_000_000n, reserveB: 1_000_000n })],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    expect(decision.kind).toBe('addLiquidity');
    if (decision.kind === 'addLiquidity') {
      expect(decision.amountA).toBe(500_000n);
      expect(decision.amountB).toBe(500_000n);
    }
  });

  it('returns noop when no managed pool matches the (USDC, RWT) pair', () => {
    const otherMint = new PublicKey(Buffer.alloc(32, 99));
    const decision = decideRebalance({
      nexus: nexusState(),
      positions: [null],
      pools: [poolState({ tokenAMint: otherMint })],
      balances: { usdc: 5_000_000n, rwt: 5_000_000n },
      cfg,
    });
    expect(decision).toMatchObject({ kind: 'noop', reason: 'no_managed_pool' });
  });
});

// =============================================================================
// nexus-state-reader byte parsers
// =============================================================================

describe('parseLiquidityNexus (50-byte body)', () => {
  it('decodes manager / counters / flags / bump from raw bytes', () => {
    // 8-byte discriminator + 50-byte body
    const buf = Buffer.alloc(8 + 50);
    // discriminator (irrelevant for parser)
    buf.writeUInt8(0xab, 0);
    // body starts at offset 8
    const body = buf.subarray(8);
    Buffer.alloc(32, 1).copy(body, 0); // manager = [1; 32]
    body.writeBigUInt64LE(123_456n, 32); // total_deposited_usdc
    body.writeBigUInt64LE(789_012n, 40); // total_deposited_rwt
    body.writeUInt8(1, 48); // is_active = true
    body.writeUInt8(254, 49); // bump

    const state = parseLiquidityNexus(buf);
    expect(state.manager.toBuffer().every(b => b === 1)).toBe(true);
    expect(state.totalDepositedUsdc).toBe(123_456n);
    expect(state.totalDepositedRwt).toBe(789_012n);
    expect(state.isActive).toBe(true);
    expect(state.bump).toBe(254);
  });

  it('throws on truncated buffer', () => {
    const buf = Buffer.alloc(8 + 49); // 1 byte short
    expect(() => parseLiquidityNexus(buf)).toThrow(/expected ≥58/);
  });

  it('decodes is_active=false and zero counters', () => {
    const buf = Buffer.alloc(8 + 50);
    // body all zeros — uninitialized layout.
    const state = parseLiquidityNexus(buf);
    expect(state.totalDepositedUsdc).toBe(0n);
    expect(state.totalDepositedRwt).toBe(0n);
    expect(state.isActive).toBe(false);
    expect(state.bump).toBe(0);
  });
});

describe('parseLpPosition (121-byte body, Layer 9 D28)', () => {
  it('decodes shares + Q64.64 fee snapshots', () => {
    const buf = Buffer.alloc(8 + 121);
    const body = buf.subarray(8);
    Buffer.alloc(32, 4).copy(body, 0); // pool
    Buffer.alloc(32, 7).copy(body, 32); // owner = nexus
    // shares = 1_000_000 (u128 = 2 × u64 LE)
    body.writeBigUInt64LE(1_000_000n, 64);
    body.writeBigUInt64LE(0n, 72);
    body.writeBigInt64LE(123n, 80); // last_update_ts
    body.writeUInt8(255, 88); // bump
    // fees_claimed_per_share_a = 5 (Q64.64 low half)
    body.writeBigUInt64LE(5n, 89);
    body.writeBigUInt64LE(0n, 97);
    // fees_claimed_per_share_b = 0
    body.writeBigUInt64LE(0n, 105);
    body.writeBigUInt64LE(0n, 113);

    const lp = parseLpPosition(buf);
    expect(lp.shares).toBe(1_000_000n);
    expect(lp.lastUpdateTs).toBe(123n);
    expect(lp.bump).toBe(255);
    expect(lp.feesClaimedPerShareA).toBe(5n);
    expect(lp.feesClaimedPerShareB).toBe(0n);
  });

  it('decodes large u128 fees_claimed_per_share via hi/lo splice', () => {
    const buf = Buffer.alloc(8 + 121);
    const body = buf.subarray(8);
    // fees_claimed_per_share_a = (3 << 64) + 7 — exercises the hi-word read.
    body.writeBigUInt64LE(7n, 89);
    body.writeBigUInt64LE(3n, 97);
    const lp = parseLpPosition(buf);
    expect(lp.feesClaimedPerShareA).toBe((3n << 64n) + 7n);
  });
});

// =============================================================================
// tx-builders — discriminator + account-order pinning
// =============================================================================

describe('buildNexusSwapIx — Layer 9 §4.3', () => {
  it('pins discriminator to sha256("global:nexus_swap")[..8]', () => {
    const ix = buildNexusSwapIx({
      ctx: baseCtx,
      pool: poolCtx,
      aToB: true,
      amountIn: 1_000_000n,
      minAmountOut: 950_000n,
    });
    expect(ix.data.subarray(0, 8).equals(discNexusSwap())).toBe(true);
  });

  it('encodes args as [DISC|amount_in u64|min_amount_out u64|a_to_b u8] = 25 bytes', () => {
    const ix = buildNexusSwapIx({
      ctx: baseCtx,
      pool: poolCtx,
      aToB: true,
      amountIn: 0xdead_beefn,
      minAmountOut: 0xcafe_baben,
    });
    expect(ix.data.length).toBe(25);
    expect(ix.data.readBigUInt64LE(8)).toBe(0xdead_beefn);
    expect(ix.data.readBigUInt64LE(16)).toBe(0xcafe_baben);
    expect(ix.data.readUInt8(24)).toBe(1);
  });

  it('uses 11 accounts (10 named + 1 token_program in remaining_accounts per R47)', () => {
    const ix = buildNexusSwapIx({
      ctx: baseCtx,
      pool: poolCtx,
      aToB: true,
      amountIn: 1_000_000n,
      minAmountOut: 1n,
    });
    expect(ix.keys).toHaveLength(11);
    // Last key is the R47 token_program duplicate in remaining_accounts.
    expect(ix.keys[10]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('orders accounts per architecture §4.3 with manager as signer', () => {
    const ix = buildNexusSwapIx({
      ctx: baseCtx,
      pool: poolCtx,
      aToB: true,
      amountIn: 1_000_000n,
      minAmountOut: 1n,
    });
    expect(ix.keys[0]?.pubkey.equals(MANAGER)).toBe(true);
    expect(ix.keys[0]?.isSigner).toBe(true);
    expect(ix.keys[1]?.pubkey.equals(DEX_CONFIG)).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(NEXUS_PDA)).toBe(true);
    expect(ix.keys[3]?.pubkey.equals(POOL)).toBe(true);
    // a_to_b=true → vault_in == vault_a
    expect(ix.keys[6]?.pubkey.equals(VAULT_A)).toBe(true);
    expect(ix.keys[7]?.pubkey.equals(VAULT_B)).toBe(true);
    expect(ix.keys[8]?.pubkey.equals(AREAL_FEE)).toBe(true);
  });

  it('rejects amount_in <= 0', () => {
    expect(() =>
      buildNexusSwapIx({
        ctx: baseCtx,
        pool: poolCtx,
        aToB: true,
        amountIn: 0n,
        minAmountOut: 1n,
      }),
    ).toThrow(/amount_in must be > 0/);
  });
});

describe('buildNexusAddLiquidityIx — Layer 9 §4.4', () => {
  it('pins discriminator to sha256("global:nexus_add_liquidity")[..8]', () => {
    const ix = buildNexusAddLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      amountA: 1_000_000n,
      amountB: 1_000_000n,
      minShares: 1n,
    });
    expect(ix.data.subarray(0, 8).equals(discNexusAddLiquidity())).toBe(true);
  });

  it('uses 12 accounts: 11 named + 1 token_program (R47 remaining_accounts)', () => {
    const ix = buildNexusAddLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      amountA: 1_000_000n,
      amountB: 1_000_000n,
      minShares: 1n,
    });
    expect(ix.keys).toHaveLength(12);
    expect(ix.keys[11]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('encodes min_shares as u128 LE (16 bytes)', () => {
    const ix = buildNexusAddLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      amountA: 1n,
      amountB: 1n,
      minShares: (5n << 64n) + 7n, // exercise hi-half
    });
    // Total: 8 disc + 8 amountA + 8 amountB + 16 minShares = 40 bytes
    expect(ix.data.length).toBe(40);
    expect(ix.data.readBigUInt64LE(24)).toBe(7n);
    expect(ix.data.readBigUInt64LE(32)).toBe(5n);
  });

  it('rejects when both amounts are zero', () => {
    expect(() =>
      buildNexusAddLiquidityIx({
        ctx: baseCtx,
        pool: poolCtx,
        amountA: 0n,
        amountB: 0n,
        minShares: 1n,
      }),
    ).toThrow(/amount_a \+ amount_b must be > 0/);
  });
});

describe('buildNexusRemoveLiquidityIx — Layer 9 §4.5', () => {
  it('pins discriminator to sha256("global:nexus_remove_liquidity")[..8]', () => {
    const ix = buildNexusRemoveLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      sharesToBurn: 1_000n,
    });
    expect(ix.data.subarray(0, 8).equals(discNexusRemoveLiquidity())).toBe(true);
  });

  it('uses 10 accounts: 9 named + 1 token_program (R47 remaining_accounts)', () => {
    const ix = buildNexusRemoveLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      sharesToBurn: 1_000n,
    });
    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[9]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('args are [DISC|shares_to_burn u128 LE] = 24 bytes', () => {
    const ix = buildNexusRemoveLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      sharesToBurn: (1n << 64n) + 42n,
    });
    expect(ix.data.length).toBe(24);
    expect(ix.data.readBigUInt64LE(8)).toBe(42n);
    expect(ix.data.readBigUInt64LE(16)).toBe(1n);
  });

  it('rejects shares_to_burn <= 0', () => {
    expect(() =>
      buildNexusRemoveLiquidityIx({
        ctx: baseCtx,
        pool: poolCtx,
        sharesToBurn: 0n,
      }),
    ).toThrow(/shares_to_burn must be > 0/);
  });

  it('places token_program in named slot AND remaining_accounts (R47)', () => {
    const ix = buildNexusRemoveLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      sharesToBurn: 1_000n,
    });
    // Slot 8 — named token_program; slot 9 — R47 remaining-accounts duplicate.
    expect(ix.keys[8]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[9]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });
});

// =============================================================================
// R47 enforcement — every Nexus ix must include token_program in remaining_accounts
// =============================================================================

describe('R47 — token_program in remaining_accounts (all 3 ix)', () => {
  it('nexus_swap ends with SPL_TOKEN_PROGRAM_ID', () => {
    const ix = buildNexusSwapIx({
      ctx: baseCtx,
      pool: poolCtx,
      aToB: false,
      amountIn: 1n,
      minAmountOut: 1n,
    });
    expect(ix.keys[ix.keys.length - 1]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('nexus_add_liquidity ends with SPL_TOKEN_PROGRAM_ID', () => {
    const ix = buildNexusAddLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      amountA: 1n,
      amountB: 1n,
      minShares: 1n,
    });
    expect(ix.keys[ix.keys.length - 1]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('nexus_remove_liquidity ends with SPL_TOKEN_PROGRAM_ID', () => {
    const ix = buildNexusRemoveLiquidityIx({
      ctx: baseCtx,
      pool: poolCtx,
      sharesToBurn: 1n,
    });
    expect(ix.keys[ix.keys.length - 1]?.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });
});
