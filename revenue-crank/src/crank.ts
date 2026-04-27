import { Connection, PublicKey } from '@solana/web3.js';

import {
  MultiRpcClient,
  logger,
  reconcileEvents,
} from '@areal/bots-shared';

import type { BotConfig } from './config.js';
import type { CheckpointStore } from './checkpoint.js';
import type { DistributionDecision } from './types.js';
import {
  deriveRevenuePdas,
  fetchRevenueAccount,
  fetchRevenueConfig,
  fetchTokenAmount,
} from './revenue-source.js';
import { buildDistributeRevenueIx, sendDistributeRevenueTx } from './distributor.js';

/**
 * 7 days in seconds — must match contracts/ownership-token/src/constants.rs:6.
 */
export const DISTRIBUTION_COOLDOWN_SECS = 604_800;

/**
 * Pure decision function: given current chain state + a wall-clock, decide
 * whether to invoke `distribute_revenue` for this OT.
 *
 * Exposed for unit tests so we never need to mock RPC just to verify the
 * "should I send" logic.
 */
export function decideDistribution(args: {
  balance: bigint;
  minDistributionAmount: bigint;
  lastDistributionTs: number;
  isDistributing: boolean;
  activeDestinations: number;
  nowSecs: number;
  cooldownSecs?: number;
}): DistributionDecision {
  const cooldown = args.cooldownSecs ?? DISTRIBUTION_COOLDOWN_SECS;

  if (args.activeDestinations === 0) {
    return { kind: 'skip', reason: 'no_destinations' };
  }
  if (args.isDistributing) {
    return { kind: 'skip', reason: 'concurrent_distribution' };
  }
  if (args.balance < args.minDistributionAmount) {
    return {
      kind: 'skip',
      reason: 'below_min',
      details: {
        balance: args.balance.toString(),
        min: args.minDistributionAmount.toString(),
      },
    };
  }
  if (
    args.lastDistributionTs > 0 &&
    args.nowSecs - args.lastDistributionTs < cooldown
  ) {
    return {
      kind: 'skip',
      reason: 'cooldown',
      details: {
        elapsed: args.nowSecs - args.lastDistributionTs,
        cooldown,
      },
    };
  }
  return { kind: 'send', balance: args.balance };
}

/**
 * Single-flight lock keyed by string. WS callback and poll tick both target
 * the same OT; the lock guarantees only one path actually invokes
 * `processOt()` at a time (D10).
 */
export class SingleFlightLock {
  private inflight = new Set<string>();

  acquire(key: string): boolean {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  release(key: string): void {
    this.inflight.delete(key);
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }
}

/**
 * Process a single OT: read on-chain state, decide, send TX, update checkpoint.
 *
 * Idempotency (D9):
 *   1. ALWAYS re-reads chain state — local checkpoint is hint-cache only.
 *   2. On-chain `distribute_revenue` enforces cooldown via the program; even
 *      if our `decideDistribution` is wrong, the program reverts with
 *      `DistributionCooldown`.
 */
export async function processOt(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  otMint: PublicKey;
  nowSecs?: number;
}): Promise<DistributionDecision> {
  const { conn, cfg, checkpoint, otMint } = args;
  const nowSecs = args.nowSecs ?? Math.floor(Date.now() / 1000);

  const { revenueAccount, revenueConfig } = deriveRevenuePdas(otMint, cfg.otProgramId);

  let account, config, balance: bigint;
  try {
    [account, config] = await Promise.all([
      fetchRevenueAccount(conn, revenueAccount),
      fetchRevenueConfig(conn, revenueConfig),
    ]);
  } catch (err) {
    logger.error('rpc fetch failed for OT', err, { ot: otMint.toBase58() });
    return { kind: 'skip', reason: 'rpc_error' };
  }

  if (!account || !config) {
    logger.warn('revenue PDA not initialised — skipping OT', {
      ot: otMint.toBase58(),
      hasAccount: !!account,
      hasConfig: !!config,
    });
    return { kind: 'skip', reason: 'rpc_error' };
  }

  try {
    balance = await fetchTokenAmount(conn, account.revenueTokenAccount);
  } catch (err) {
    logger.error('rpc fetch token balance failed', err, {
      ot: otMint.toBase58(),
      ata: account.revenueTokenAccount.toBase58(),
    });
    return { kind: 'skip', reason: 'rpc_error' };
  }

  const decision = decideDistribution({
    balance,
    minDistributionAmount: account.minDistributionAmount,
    lastDistributionTs: account.lastDistributionTs,
    isDistributing: account.isDistributing,
    activeDestinations: config.activeCount,
    nowSecs,
  });

  if (decision.kind === 'skip') {
    logger.debug('skip distribute_revenue', {
      ot: otMint.toBase58(),
      reason: decision.reason,
      details: decision.details,
    });
    // Refresh local checkpoint hint regardless — keeps WS/poll dedup tight.
    checkpoint.upsert(otMint.toBase58(), account.lastDistributionTs, null);
    return decision;
  }

  // SEND
  const ix = buildDistributeRevenueIx({
    otProgramId: cfg.otProgramId,
    crank: cfg.crankKeypair.publicKey,
    otMint,
    revenueAccount,
    revenueConfig,
    account,
    config,
  });

  try {
    const sig = await sendDistributeRevenueTx(conn, cfg.crankKeypair, ix);
    logger.info('distribute_revenue OK', {
      ot: otMint.toBase58(),
      sig,
      balance: balance.toString(),
      destinations: config.activeCount,
    });
    checkpoint.upsert(otMint.toBase58(), nowSecs, sig);
    return decision;
  } catch (err) {
    logger.error('distribute_revenue failed', err, { ot: otMint.toBase58() });
    return { kind: 'skip', reason: 'rpc_error' };
  }
}

/**
 * Main loop: on a fixed interval, walks every configured OT and invokes
 * `processOt`. The single-flight lock guards against the WS subscription
 * (when wired up — see `subscribeRevenueEvents`) firing concurrently for the
 * same OT.
 */
export async function runLoop(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  signal: AbortSignal;
}): Promise<void> {
  const { conn, cfg, checkpoint, lock, signal } = args;

  while (!signal.aborted) {
    for (const ot of cfg.otProjects) {
      if (signal.aborted) break;
      const key = ot.toBase58();
      if (!lock.acquire(key)) {
        logger.debug('lock held — WS handler in flight, skipping poll', { ot: key });
        continue;
      }
      try {
        await processOt({ conn, cfg, checkpoint, otMint: ot });
      } finally {
        lock.release(key);
      }
    }

    if (signal.aborted) break;

    await sleep(cfg.checkIntervalSecs * 1000, signal);
  }
}

/**
 * Subscribe to OT program logs and react to `RevenueDistributed` events on
 * other OTs (defensive: another instance of the crank may have just
 * distributed, and we want to refresh our local checkpoint without waiting
 * for the next poll tick).
 *
 * In practice the WS path here reduces ~5 minutes of staleness to a few
 * hundred ms after each successful distribute_revenue elsewhere — the bot
 * still mostly works on poll cadence because cooldown is 7 days.
 */
export function subscribeRevenueEvents(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
}): { unsubscribe: () => Promise<void> } {
  const { conn, cfg, checkpoint, lock } = args;
  const subId = conn.onLogs(
    cfg.otProgramId,
    async (logs, ctx) => {
      if (logs.err) return;
      // Track the highest seen slot so reconcile after a reconnect can pick
      // up where the live subscription left off.
      checkpoint.setLastSeenSlot(cfg.otProgramId.toBase58(), ctx?.slot ?? 0);
      // We do not parse the event payload here — the cheaper path is just to
      // re-read each configured OT's RevenueAccount on any program log,
      // gated by the single-flight lock.
      for (const ot of cfg.otProjects) {
        const key = ot.toBase58();
        if (!lock.acquire(key)) continue;
        try {
          await processOt({ conn, cfg, checkpoint, otMint: ot });
        } catch (e) {
          logger.error('WS-triggered processOt failed', e, { ot: key });
        } finally {
          lock.release(key);
        }
      }
    },
    'confirmed',
  );

  logger.info('revenue-crank WS subscribed', { programId: cfg.otProgramId.toBase58() });

  return {
    unsubscribe: async (): Promise<void> => {
      await conn.removeOnLogsListener(subId);
    },
  };
}

/**
 * R31: walk program signatures since the last-seen slot and re-dispatch any
 * missed events through `processOt`. Called once at startup and on every WS
 * reconnect path. Idempotent — `processOt` always re-reads chain state and
 * the on-chain `distribute_revenue` ix has its own cooldown.
 */
export async function reconcileSinceLastSeen(args: {
  client: MultiRpcClient;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  signal?: AbortSignal;
}): Promise<number> {
  const { client, cfg, checkpoint, lock, signal } = args;
  const programKey = cfg.otProgramId.toBase58();
  const fromSlot = checkpoint.getLastSeenSlot(programKey);
  if (fromSlot === null) {
    logger.info('reconcile skipped — no prior checkpoint slot', { programId: programKey });
    return 0;
  }
  return await client.withFallback(conn =>
    reconcileEvents(
      conn,
      { programId: cfg.otProgramId, fromSlot, signal },
      async ({ slot }) => {
        // Re-walk every configured OT (matches the WS handler — we don't
        // parse event payloads, just trigger a fresh chain read per OT).
        for (const ot of cfg.otProjects) {
          if (signal?.aborted) return;
          const key = ot.toBase58();
          if (!lock.acquire(key)) continue;
          try {
            await processOt({ conn, cfg, checkpoint, otMint: ot });
          } catch (e) {
            logger.error('reconcile-triggered processOt failed', e, { ot: key });
          } finally {
            lock.release(key);
          }
        }
        checkpoint.setLastSeenSlot(programKey, slot);
      },
    ),
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
