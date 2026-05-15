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
 * Mirrors `OT_TREASURY_FEE_BPS` in `contracts/native-dex/src/constants.rs:6`.
 * Added on top of `pool.fee_bps` for governance pools (`has_ot_treasury == true`)
 * when sizing fee headroom on sell-RWT swaps.
 */
const OT_TREASURY_FEE_BPS = 50n;

/**
 * Fee-on-top sizing (docs/contracts/native-dex.mdx:522-568,
 * native-dex/src/instructions/swap.rs:205-301).
 *
 * On the sell-RWT branch (`input_is_rwt == true`), the inbound transfer
 * initiated by `swap_internal` debits the user's input ATA by
 *   `amount_in + fee_total + ot_treasury_fee`
 * (a.k.a. `user_total_debit`). The bot owns the Nexus-side ATA, so it
 * MUST reserve fee headroom when sizing `amount_in` — otherwise the
 * inbound SPL Transfer reverts with `InsufficientFunds` and the cycle is
 * wasted.
 *
 * Given a raw "naive" amount (e.g. `halfDrift`) and the pool's effective
 * fee bps (`pool.fee_bps` + 50 bps OT surcharge when applicable), this
 * computes the largest `amount_in` that fits the available balance:
 *
 *   amount_in_max = floor(balance * 10_000 / (10_000 + fee_bps + ot_bps))
 *
 * The result is bounded above by `naive` (we never increase the bot's
 * proposed swap size — fee headroom only shrinks it). Returns 0n if the
 * balance is too small to cover any swap with fees.
 *
 * On the buy-RWT branch (`input_is_rwt == false`), fees come out of the
 * gross output (not from `amount_in`), so headroom is NOT required and
 * the caller passes the naive amount unchanged.
 */
function sizeAmountInForFeeOnTop(args: {
  naive: bigint;
  balance: bigint;
  feeBps: number;
  hasOtTreasury: boolean;
}): bigint {
  const { naive, balance, feeBps, hasOtTreasury } = args;
  const effectiveFeeBps = BigInt(feeBps) + (hasOtTreasury ? OT_TREASURY_FEE_BPS : 0n);
  // amount_in_max = floor(balance * 10000 / (10000 + effectiveFeeBps))
  const denom = BPS_DENOMINATOR + effectiveFeeBps;
  if (denom === 0n) return 0n;
  const cap = (balance * BPS_DENOMINATOR) / denom;
  // Pick the smaller of (naive proposal, fee-headroom cap). Fee headroom
  // only ever shrinks the bot's proposed amount.
  return naive < cap ? naive : cap;
}

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
    const usdcOnA = poolMintIsUsdcOnA(pool, cfg.usdcMint);
    const aToB = usdcOnA
      ? currentBps > targetBps // too much USDC: swap A (USDC) → B (RWT)
      : currentBps < targetBps; // too much RWT: swap A (RWT) ← B (USDC) inverted
    // Fee-on-top headroom (docs/contracts/native-dex.mdx:522-568,
    // contracts/native-dex/src/instructions/swap.rs:205-301): on sell-RWT
    // swaps the Nexus ATA must cover `amount_in + fee_total +
    // ot_treasury_fee`. Compute the effective max `amount_in` so the
    // inbound transfer cannot revert with `InsufficientFunds`.
    //
    // inputIsRwt mapping:
    //   usdcOnA=true,  aToB=true  → in=USDC (no headroom).
    //   usdcOnA=true,  aToB=false → in=RWT  (headroom needed).
    //   usdcOnA=false, aToB=true  → in=RWT  (headroom needed).
    //   usdcOnA=false, aToB=false → in=USDC (no headroom).
    // ≡ inputIsRwt = (usdcOnA !== aToB).
    const inputIsRwt = usdcOnA !== aToB;
    let amountIn = halfDrift;
    if (inputIsRwt) {
      // Sell-RWT path — clamp `amount_in` to fee headroom against the
      // current RWT balance. Use the bot's RWT idle balance (not idleSum)
      // since the inbound transfer only touches the RWT ATA.
      amountIn = sizeAmountInForFeeOnTop({
        naive: halfDrift,
        balance: balances.rwt,
        feeBps: pool.feeBps,
        hasOtTreasury: pool.hasOtTreasury,
      });
      if (amountIn === 0n) {
        return { kind: 'noop', reason: 'fee_headroom_below_min_swap' };
      }
    }
    const minAmountOut = (amountIn * 95n) / 100n;
    return {
      kind: 'swap',
      pool: pool.pool,
      amountIn,
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
