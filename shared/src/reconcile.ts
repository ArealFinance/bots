/**
 * R31: WS reconnect catch-up.
 *
 * After a websocket disconnect, cranks risk missing on-chain events that
 * occurred during the gap. Without reconcile, the only fallback is the poll
 * loop — which can lag by 30+ minutes depending on `checkIntervalSecs`.
 *
 * This module ports the proven `EventWatcher.reconcile` pattern from
 * `bots/merkle-publisher/src/event-watcher.ts:115` into a shared, reusable
 * helper. Cranks call `reconcileEvents()` once on startup AND after every
 * `onLogs` reconnect to replay missed program logs.
 *
 * Pattern:
 *   1. Page through `getSignaturesForAddress(programId, { before, limit })`,
 *      walking back in time until we cross `fromSlot`.
 *   2. For each signature in the resulting set, fetch the full transaction
 *      and pass `(signature, logs)` to the user-supplied handler.
 *   3. Replay oldest-first so handlers see events in chronological order.
 *
 * Idempotency:
 *   The handler MUST be idempotent. Cranks already enforce this on-chain
 *   (cooldowns, MerkleDistributor.cumulative checks, RevenueAccount checks)
 *   so re-dispatching a signature is safe — but the handler should also
 *   dedupe in-process via a `Set<signature>` to skip work cheaply.
 *
 * Off-by-one:
 *   The stop condition is strict `slot < fromSlot`, NOT `<=`. Sibling events
 *   on the same slot must NOT be skipped. (LOW-R2-2 from merkle-publisher.)
 *
 * Abort:
 *   Pass an `AbortSignal` to interrupt mid-reconcile. The walker checks the
 *   signal between RPC pages and between transaction fetches.
 */

import { Connection, PublicKey } from '@solana/web3.js';

import { logger } from './logger.js';

const SIGNATURE_PAGE_LIMIT = 1000;

/**
 * If `fromSlot` is older than this many slots, we log a warning before
 * walking. Solana produces ~1 slot/400ms → 432_000 slots ≈ 2 days. A bot
 * that has been offline longer than that will burn substantial RPC credit
 * paging through history; the operator likely wants to truncate the
 * checkpoint instead.
 */
const STALE_FROM_SLOT_WARN_THRESHOLD = 432_000;

export interface ReconcileOptions {
  /** Program whose logs we're scanning. */
  programId: PublicKey;
  /**
   * Inclusive lower bound (exclusive: `slot < fromSlot` stops the walk).
   * Pass `null` to scan from inception (rarely useful — usually you have a
   * persisted last-seen slot in a checkpoint).
   */
  fromSlot: number | null;
  /**
   * Optional upper bound used purely for logging context. The walker always
   * starts from the most recent signature because `getSignaturesForAddress`
   * returns descending order, then stops once `slot < fromSlot`.
   */
  toSlot?: number | null;
  /**
   * Optional abort signal. Checked between RPC pages and between
   * `getTransaction` calls. Aborts surface as `AbortError`.
   */
  signal?: AbortSignal;
  /**
   * Hard cap on signatures pulled — defensive limit so a misconfigured
   * `fromSlot` (e.g. 0) does not stall the bot indefinitely on a chatty
   * program. Defaults to 50,000.
   */
  maxSignatures?: number;
}

/** Per-event payload passed to the handler. */
export interface ReconciledEvent {
  signature: string;
  slot: number;
  logs: string[];
  /** Block timestamp (Unix seconds) — null if RPC withheld it. */
  blockTime: number | null;
}

export type ReconcileHandler = (event: ReconciledEvent) => Promise<void> | void;

/**
 * Re-play program logs since `fromSlot`. Errors from the handler propagate
 * back to the caller; partial progress is NOT rolled back (the handler is
 * responsible for its own checkpointing).
 *
 * Returns the number of events dispatched.
 */
export async function reconcileEvents(
  conn: Connection,
  options: ReconcileOptions,
  handler: ReconcileHandler,
): Promise<number> {
  const { programId, fromSlot, signal, maxSignatures = 50_000 } = options;
  if (signal?.aborted) throw makeAbortError();

  // Warn if the lower bound is suspiciously old — guards against a corrupted
  // checkpoint (e.g. fromSlot=0 or a value from a long-stopped instance).
  if (fromSlot !== null && fromSlot > 0) {
    try {
      const currentSlot = await conn.getSlot('confirmed');
      const lag = currentSlot - fromSlot;
      if (lag > STALE_FROM_SLOT_WARN_THRESHOLD) {
        logger.warn('reconcile fromSlot is suspiciously old', {
          programId: programId.toBase58(),
          fromSlot,
          currentSlot,
          lagSlots: lag,
          lagApproxDays: Math.round((lag * 0.4) / 86_400),
          maxSignatures,
        });
      }
    } catch (err) {
      // getSlot failure is non-fatal — proceed without the floor check.
      logger.warn('reconcile fromSlot sanity check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const collected: { signature: string; slot: number; blockTime: number | null }[] = [];
  let before: string | undefined;

  // Walk pages newest-to-oldest until we cross fromSlot or run out.
  while (true) {
    if (signal?.aborted) throw makeAbortError();
    const batch = await conn.getSignaturesForAddress(programId, {
      before,
      limit: SIGNATURE_PAGE_LIMIT,
    });
    if (batch.length === 0) break;

    let crossedLowerBound = false;
    for (const b of batch) {
      // Strict < so siblings on `fromSlot` are still included.
      if (fromSlot !== null && b.slot < fromSlot) {
        crossedLowerBound = true;
        break;
      }
      if (b.err) continue;
      collected.push({
        signature: b.signature,
        slot: b.slot,
        blockTime: b.blockTime ?? null,
      });
      if (collected.length >= maxSignatures) {
        crossedLowerBound = true;
        break;
      }
    }
    if (crossedLowerBound) break;
    if (batch.length < SIGNATURE_PAGE_LIMIT) break;
    const last = batch[batch.length - 1];
    if (!last) break;
    before = last.signature;
  }

  if (collected.length === 0) {
    logger.info('reconcile no events', {
      programId: programId.toBase58(),
      fromSlot,
    });
    return 0;
  }

  // Replay oldest-first to match chronological event order.
  collected.reverse();

  let dispatched = 0;
  for (const entry of collected) {
    if (signal?.aborted) throw makeAbortError();
    const tx = await conn.getTransaction(entry.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;
    await handler({
      signature: entry.signature,
      slot: entry.slot,
      logs: tx.meta.logMessages,
      blockTime: entry.blockTime ?? tx.blockTime ?? null,
    });
    dispatched += 1;
  }

  logger.info('reconcile complete', {
    programId: programId.toBase58(),
    fromSlot,
    collected: collected.length,
    dispatched,
  });
  return dispatched;
}

function makeAbortError(): Error {
  const err = new Error('reconcileEvents aborted');
  err.name = 'AbortError';
  return err;
}
