import 'dotenv/config';

/**
 * Pool Rebalancer config — CP-9 Monotonic Ladder rewrite.
 *
 * The old `shift_liquidity` path is gone (and so is `MAX_SHIFT_DISTANCE` /
 * `TARGET_BIN_COUNT`). The new contract surface splits into two paths:
 *   - `grow_liquidity` when NAV rises (newNavBin > lastRebalanceNavBin)
 *   - `compress_liquidity` when NAV falls (newNavBin < lastRebalanceNavBin)
 *
 * Both take `(new_nav_bin, active_zone_width)` as args. `active_zone_width`
 * is currently pinned by the contract to `ACTIVE_ZONE_WIDTH` (= 40) but is
 * surfaced here so a future contract bump that lifts the pin can be picked
 * up without redeploying the bot.
 */
export const CONFIG = {
  /** Polling cadence for the main decision loop. */
  CHECK_INTERVAL_MS: 60_000, // 60 seconds

  /**
   * Minimum |deviation| = |(nav - refPrice) / refPrice| that triggers a
   * grow/compress submission. Mirrors architect CP-9 decision tree.
   */
  REBALANCE_THRESHOLD: 0.01, // 1%

  /**
   * Width of the new active zone in bins. Mirrors the on-chain
   * `ACTIVE_ZONE_WIDTH` constant (40). Forwarded verbatim to the
   * `grow_liquidity` / `compress_liquidity` args.
   */
  ACTIVE_ZONE_WIDTH: 40,

  /**
   * Min wall-clock gap between submissions for a given pool. Prevents
   * thrashing when NAV is oscillating around the threshold and gives any
   * pending grow/compress tx time to confirm before we re-read state.
   */
  DEBOUNCE_MS: 60_000, // 60 seconds

  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8899',
  REBALANCER_KEYPAIR: process.env.REBALANCER_KEYPAIR || '',
  DEX_PROGRAM_ID:
    process.env.DEX_PROGRAM_ID || '5FAB2HRFT78AqmQ7c3auV3ttcqnoNx3VjDBYkSQbSZXL',
  RWT_ENGINE_PROGRAM_ID: process.env.RWT_ENGINE_PROGRAM_ID || '',

  /** Max attempts for a single submission (exponential backoff between). */
  MAX_RETRIES: 5,
  /** Base backoff in ms; delay = RETRY_BASE_DELAY_MS * 2^(attempt-1). */
  RETRY_BASE_DELAY_MS: 5_000,
};
