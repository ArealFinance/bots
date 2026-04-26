/**
 * Pure-function rebalance decision logic for the nexus-manager bot.
 *
 * Inputs are read once per cycle by the crank loop; this module decides
 * whether to emit a single `swap` / `addLiquidity` / `removeLiquidity`
 * action or skip the cycle entirely.
 *
 * Trust-level guardrails (Layer 9 §5.1.5):
 *   - Manager **CAN** emit bad swaps / lossy add/remove cycles.
 *   - Manager **CANNOT** extract principal — `nexus_withdraw_profits` is
 *     Authority-gated. This module never proposes a profit withdrawal.
 *
 * Kill-switch behaviour (D22):
 *   - `nexus.is_active == false` → noop with `is_active_false` reason.
 *   - `nexus.manager == [0u8; 32]` → noop with `manager_zero` reason. The
 *     bot's main loop logs this and exits cleanly because every Manager
 *     ix would revert `NexusManagerDisabled`.
 *
 * One decision per cycle (architecture §5.1.2 step 4) — no parallel TXs.
 * The order of preference inside a single cycle is:
 *   1. Kill-switch detection (overrides everything).
 *   2. Drift-rebalancing swap (if USDC/RWT mix is far from the target).
 *   3. Idle-capital deployment (add_liquidity to a managed pool).
 *   4. Otherwise noop.
 *
 * `removeLiquidity` is reserved for an explicit operator-driven recall
 * path (LP underperformance, pool TVL collapse). V1 returns `noop` —
 * recall heuristics are deferred to a future iteration; the builder is
 * exposed so operators can hand-craft a decision via tests / scripts.
 */

import { PublicKey } from '@solana/web3.js';

import type {
  Decision,
  LiquidityNexusState,
  LpPositionState,
  NexusBalances,
  PoolStateInfo,
} from './types.js';

export interface ManagerStrategyConfig {
  /** Min idle USDC (in base units) before any deployment / swap is considered. */
  minRebalanceUsdc: bigint;
  /** Target USDC fraction of the idle balance, in basis points (5000 = 50%). */
  lpTargetRatioBps: number;
  /** Minimum drift from target (bps) before a rebalance swap is proposed. */
  lpRebalanceTriggerBps: number;
  /** Max single-pool concentration of idle capital (bps). */
  maxPoolConcentrationBps: number;
  /** Per-pool USDC equivalent of pool TVL (used for concentration check). */
  usdcMint: PublicKey;
  rwtMint: PublicKey;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Decide the next action.
 *
 * `selectedPoolHint` lets the caller bias deployment to a specific pool
 * (e.g. round-robin across managed pools). When `null`, the engine picks
 * the first pool whose token-pair is `(USDC, RWT)` — V1 heuristic.
 *
 * Inputs:
 *   - `nexus`        — decoded LiquidityNexus state.
 *   - `positions`    — Nexus's existing LpPositions (read by the crank
 *                       loop for each managed pool; `null` entries skip).
 *   - `pools`        — Pool states for every managed pool.
 *   - `balances`     — current USDC + RWT idle in the Nexus ATAs.
 *   - `cfg`          — thresholds.
 *   - `selectedPoolHint` — round-robin hint, or `null`.
 */
export function decideRebalance(args: {
  nexus: LiquidityNexusState;
  positions: (LpPositionState | null)[];
  pools: (PoolStateInfo | null)[];
  balances: NexusBalances;
  cfg: ManagerStrategyConfig;
  selectedPoolHint?: PublicKey | null;
}): Decision {
  const { nexus, positions, pools, balances, cfg, selectedPoolHint } = args;

  // 1. Kill-switch checks — D22 ordering: zero-manager BEFORE is_active so the
  //    operator-visible reason matches the on-chain ix revert priority.
  if (isZeroPubkey(nexus.manager)) {
    return { kind: 'killSwitch', reason: 'manager_zero' };
  }
  if (!nexus.isActive) {
    return { kind: 'killSwitch', reason: 'is_active_false' };
  }

  // 2. Total idle capital threshold. RWT side is denominated in its own
  //    base units; for V1 we sum without an oracle (RWT~USDC convention
  //    inside the simulation harness). Production hardening replaces this
  //    with an on-chain price read.
  const idleSum = balances.usdc + balances.rwt;
  if (idleSum < cfg.minRebalanceUsdc) {
    return { kind: 'noop', reason: 'idle_below_min_rebalance' };
  }

  // 3. Drift check vs target ratio. `currentBps` = USDC fraction of idle.
  const currentBps =
    idleSum === 0n
      ? BigInt(cfg.lpTargetRatioBps) // degenerate — treat as on-target
      : (balances.usdc * BPS_DENOMINATOR) / idleSum;
  const targetBps = BigInt(cfg.lpTargetRatioBps);
  const triggerBps = BigInt(cfg.lpRebalanceTriggerBps);
  const drift = currentBps > targetBps ? currentBps - targetBps : targetBps - currentBps;

  // 4. Pick the deployment pool. Hint > first managed (USDC, RWT) pair.
  const pool = pickPool({ pools, selectedPoolHint, cfg });
  if (!pool) {
    return { kind: 'noop', reason: 'no_managed_pool' };
  }

  // 5. If drift exceeds trigger, propose a rebalance swap. We always swap
  //    from the over-weighted side into the under-weighted side; the
  //    target half of the gap is the swap amount. `min_amount_out` is
  //    computed conservatively as 95% of the input — actual slippage
  //    bounds tighten with on-chain constant-product math, but V1 keeps
  //    this conservative because the Nexus ATA is the destination either
  //    way.
  if (drift > triggerBps) {
    const halfDrift = (drift * idleSum) / (2n * BPS_DENOMINATOR);
    if (halfDrift === 0n) {
      return { kind: 'noop', reason: 'drift_below_min_swap' };
    }
    const aToB = poolMintIsUsdcOnA(pool, cfg.usdcMint)
      ? currentBps > targetBps // too much USDC: swap A (USDC) → B (RWT)
      : currentBps < targetBps; // too much RWT: swap A (RWT) ← B (USDC) inverted
    const minAmountOut = (halfDrift * 95n) / 100n;
    return {
      kind: 'swap',
      pool: pool.pool,
      amountIn: halfDrift,
      minAmountOut: minAmountOut === 0n ? 1n : minAmountOut,
      aToB,
      reason: `drift_${drift}_bps`,
    };
  }

  // 6. Idle capital → add_liquidity. Cap by MAX_POOL_CONCENTRATION_BPS
  //    of pool reserves so a single deposit cannot dominate a thinly-traded
  //    pool. The cap is applied to whichever side currently has less idle
  //    headroom relative to the pool reserves.
  const concentrationCapA =
    (pool.reserveA * BigInt(cfg.maxPoolConcentrationBps)) / BPS_DENOMINATOR;
  const concentrationCapB =
    (pool.reserveB * BigInt(cfg.maxPoolConcentrationBps)) / BPS_DENOMINATOR;
  const usdcOnA = poolMintIsUsdcOnA(pool, cfg.usdcMint);
  const idleA = usdcOnA ? balances.usdc : balances.rwt;
  const idleB = usdcOnA ? balances.rwt : balances.usdc;

  // Take the min of (idle on side, concentration cap on side).
  const amountA = clampBig(idleA, concentrationCapA);
  const amountB = clampBig(idleB, concentrationCapB);

  if (amountA === 0n && amountB === 0n) {
    return { kind: 'noop', reason: 'concentration_cap_zero' };
  }

  // V1 LP-share lower bound: 1 — accept any non-zero share allocation.
  // Production tightens this against pool's `total_lp_shares` ratio.
  return {
    kind: 'addLiquidity',
    pool: pool.pool,
    amountA,
    amountB,
    minShares: 1n,
    reason: 'idle_deploy',
  };
}

function pickPool(args: {
  pools: (PoolStateInfo | null)[];
  selectedPoolHint?: PublicKey | null;
  cfg: ManagerStrategyConfig;
}): PoolStateInfo | null {
  const { pools, selectedPoolHint, cfg } = args;
  // Filter alive + USDC/RWT pools.
  const candidates = pools.filter((p): p is PoolStateInfo => {
    if (!p) return false;
    if (!p.isActive) return false;
    return poolHasUsdcRwtPair(p, cfg.usdcMint, cfg.rwtMint);
  });
  if (candidates.length === 0) return null;
  if (selectedPoolHint) {
    const hinted = candidates.find(p => p.pool.equals(selectedPoolHint));
    if (hinted) return hinted;
  }
  return candidates[0] ?? null;
}

function poolHasUsdcRwtPair(
  pool: PoolStateInfo,
  usdcMint: PublicKey,
  rwtMint: PublicKey,
): boolean {
  const a = pool.tokenAMint;
  const b = pool.tokenBMint;
  return (
    (a.equals(usdcMint) && b.equals(rwtMint)) ||
    (a.equals(rwtMint) && b.equals(usdcMint))
  );
}

function poolMintIsUsdcOnA(pool: PoolStateInfo, usdcMint: PublicKey): boolean {
  return pool.tokenAMint.equals(usdcMint);
}

function clampBig(value: bigint, cap: bigint): bigint {
  return value < cap ? value : cap;
}

function isZeroPubkey(pk: PublicKey): boolean {
  const buf = pk.toBuffer();
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}
