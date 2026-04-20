import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import type { FundEvent } from './types.js';
import type { SnapshotStore } from './snapshot-store.js';
import { logger } from './logger.js';

/**
 * Subscribes to yield_distribution program logs, extracts DistributorFunded /
 * StreamConverted events, and dispatches them to the onFund callback.
 *
 * Event discriminator format (arlex `#[event]` macro is Anchor-compatible):
 *   disc = sha256("event:EventName")[..8]
 *
 * Program data log format:
 *   "Program data: <base64-payload>"
 *
 * Payload = disc (8 bytes) || borsh-encoded struct body.
 *
 * The event body layout matches architecture §4.4:
 *   DistributorFunded { ot_mint: [u8;32], amount: u64, fee: u64, total_funded: u64,
 *                       locked_vested: u64, timestamp: i64 }
 *   StreamConverted (Layer 8) shares the same first 3 fields (ot_mint + amount + ...).
 *
 * On reconnect, `reconcile()` scans tx signatures since the last processed slot
 * via `getSignaturesForAddress` and re-plays any missed fund events.
 */

const DISCRIMINATOR_PREFIX = 'event:';

function eventDiscriminator(name: string): Buffer {
  const h = createHash('sha256');
  h.update(DISCRIMINATOR_PREFIX + name);
  return h.digest().subarray(0, 8);
}

// Computed once at module init.
const DISC_DISTRIBUTOR_FUNDED = eventDiscriminator('DistributorFunded');
const DISC_STREAM_CONVERTED = eventDiscriminator('StreamConverted');

export type FundEventHandler = (e: FundEvent) => Promise<void>;

export class EventWatcher {
  private subId: number | null = null;
  /** Tracks tx signatures we've already dispatched in this process — cheap dedupe. */
  private processed = new Set<string>();

  constructor(
    private readonly conn: Connection,
    private readonly programId: PublicKey,
    private readonly onFund: FundEventHandler,
    private readonly store?: SnapshotStore,
  ) {}

  /**
   * Seed the in-process `processed` Set from recent tx signatures persisted in
   * the snapshot store. Closes the race window where reconcile + live
   * subscription could redundantly call `onFund` for the same signature after
   * a restart.
   */
  seedProcessedFromStore(limit = 10_000): void {
    if (!this.store) return;
    const sigs = this.store.getAllRecentTxSignatures(limit);
    for (const s of sigs) this.processed.add(s);
    logger.info('event-watcher processed-set seeded', { count: sigs.length });
  }

  start(): void {
    this.subId = this.conn.onLogs(
      this.programId,
      async (logs, ctx) => {
        if (logs.err) return;
        if (this.processed.has(logs.signature)) return;
        this.processed.add(logs.signature);

        try {
          for (const line of logs.logs) {
            if (!line.startsWith('Program data: ')) continue;
            const b64 = line.slice('Program data: '.length);
            const bytes = Buffer.from(b64, 'base64');
            if (bytes.length < 8) continue;

            const disc = bytes.subarray(0, 8);
            const body = bytes.subarray(8);

            let kind: 'DistributorFunded' | 'StreamConverted' | null = null;
            if (disc.equals(DISC_DISTRIBUTOR_FUNDED)) kind = 'DistributorFunded';
            else if (disc.equals(DISC_STREAM_CONVERTED)) kind = 'StreamConverted';
            if (!kind) continue;

            const parsed = parseFundEventBody(body);
            if (!parsed) continue;

            // Re-derive distributor PDA from ot_mint. Match the on-chain seed
            // (see architecture §2.2: [b"merkle_dist", ot_mint.as_ref()]).
            const [distributor] = PublicKey.findProgramAddressSync(
              [Buffer.from('merkle_dist'), parsed.otMint.toBuffer()],
              this.programId,
            );

            const event: FundEvent = {
              distributor,
              otMint: parsed.otMint,
              grossAmount: parsed.grossAmount,
              protocolFee: parsed.protocolFee,
              netAmount: parsed.netAmount,
              totalFunded: parsed.totalFunded,
              lockedVested: parsed.lockedVested,
              slot: ctx.slot,
              signature: logs.signature,
              fundTs: parsed.timestamp,
            };

            await this.onFund(event);
          }
        } catch (err) {
          logger.error('event-watcher handler error', err, { signature: logs.signature });
        }
      },
      'confirmed',
    );
    logger.info('EventWatcher subscribed', { programId: this.programId.toBase58() });
  }

  /**
   * Reconcile missed events since a given slot — run once at startup after
   * websocket subscription to close the race window between restarts and
   * any events persisted on-chain that we never saw live.
   *
   * Off-by-one note (LOW-R2-2): the stop condition is `slot < sinceSlot`
   * (strict less-than), NOT `<= sinceSlot`. Using `<=` would drop any sibling
   * fund events that land on the exact same slot as the last persisted
   * snapshot. `hasSnapshotForTx` (and UNIQUE(tx_signature)) handle dedupe
   * of the already-processed sibling idempotently.
   *
   * Pass `sinceSlot = null` to reconcile from the beginning (iterates until
   * the program has no more signatures).
   */
  async reconcile(sinceSlot: number | null): Promise<FundEvent[]> {
    return this.reconcileRange(sinceSlot, null);
  }

  /**
   * NEW-M-2: cold-start reconcile. When the snapshot store is empty, we must
   * still scan recent program history so a bot deployed AFTER the first
   * fund_distributor event picks up the missed events. Without this, the very
   * first publish would submit `max_total_claim < total_funded` and revert
   * with `InvalidMaxClaim`, leaving the bot stuck in a retry loop.
   *
   * Strategy: fetch the current slot, compute `startSlot = max(0, current - lookback)`,
   * and delegate to `reconcileRange(startSlot, currentSlot)`.
   */
  async reconcileCold(lookbackSlots: bigint): Promise<FundEvent[]> {
    const currentSlot = await this.conn.getSlot('confirmed');
    const startSlot = Math.max(0, currentSlot - Number(lookbackSlots));
    logger.info('reconcile cold-start', {
      currentSlot,
      startSlot,
      lookbackSlots: lookbackSlots.toString(),
    });
    return this.reconcileRange(startSlot, currentSlot);
  }

  /**
   * Internal: paginate `getSignaturesForAddress` and replay matching events.
   *
   * @param sinceSlot inclusive lower bound (null = no lower bound — from inception).
   * @param _untilSlot optional upper bound for logging; pagination starts at
   *        "most recent" regardless because `getSignaturesForAddress` is
   *        descending. We stop once `slot < sinceSlot`.
   */
  private async reconcileRange(
    sinceSlot: number | null,
    _untilSlot: number | null,
  ): Promise<FundEvent[]> {
    const events: FundEvent[] = [];
    let before: string | undefined;
    const collected: { signature: string; slot: number }[] = [];

    while (true) {
      const batch = await this.conn.getSignaturesForAddress(this.programId, {
        before,
        limit: 1000,
      });
      if (batch.length === 0) break;
      let crossedLowerBound = false;
      for (const b of batch) {
        // LOW-R2-2: strict < (not <=) so same-slot siblings are not skipped.
        if (sinceSlot !== null && b.slot < sinceSlot) {
          crossedLowerBound = true;
          break;
        }
        if (b.err) continue;
        collected.push({ signature: b.signature, slot: b.slot });
      }
      if (crossedLowerBound) break;
      if (batch.length < 1000) break;
      before = batch[batch.length - 1]!.signature;
    }

    // Replay oldest-first.
    collected.reverse();
    for (const { signature, slot } of collected) {
      // Fast-path: dedupe via the in-process set first (cheap) — we may have
      // already dispatched this signature via the live onLogs subscription.
      if (this.processed.has(signature)) continue;

      const tx = await this.conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages) continue;

      for (const line of tx.meta.logMessages) {
        if (!line.startsWith('Program data: ')) continue;
        const b64 = line.slice('Program data: '.length);
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length < 8) continue;

        const disc = bytes.subarray(0, 8);
        const body = bytes.subarray(8);

        let kind: 'DistributorFunded' | 'StreamConverted' | null = null;
        if (disc.equals(DISC_DISTRIBUTOR_FUNDED)) kind = 'DistributorFunded';
        else if (disc.equals(DISC_STREAM_CONVERTED)) kind = 'StreamConverted';
        if (!kind) continue;

        const parsed = parseFundEventBody(body);
        if (!parsed) continue;

        const [distributor] = PublicKey.findProgramAddressSync(
          [Buffer.from('merkle_dist'), parsed.otMint.toBuffer()],
          this.programId,
        );
        events.push({
          distributor,
          otMint: parsed.otMint,
          grossAmount: parsed.grossAmount,
          protocolFee: parsed.protocolFee,
          netAmount: parsed.netAmount,
          totalFunded: parsed.totalFunded,
          lockedVested: parsed.lockedVested,
          slot,
          signature,
          fundTs: parsed.timestamp,
        });
        this.processed.add(signature);
      }
    }
    logger.info('reconcile complete', { count: events.length });
    return events;
  }

  async stop(): Promise<void> {
    if (this.subId !== null) {
      await this.conn.removeOnLogsListener(this.subId);
      this.subId = null;
    }
  }
}

/**
 * Parse the DistributorFunded event body. Field layout (borsh):
 *
 *   offset 0..32   ot_mint       [u8; 32]
 *   offset 32..40  amount        u64 (LE) — GROSS deposit submitted by funder
 *   offset 40..48  protocol_fee  u64 (LE) — fee skimmed to areal_fee_destination
 *   offset 48..56  total_funded  u64 (LE) — cumulative NET on the distributor AFTER this event
 *   offset 56..64  locked_vested u64 (LE) — after-event locked_vested
 *   offset 64..72  timestamp     i64 (LE)
 *
 * NOTE: the Areal spec calls the fee field `protocol_fee`; the current contract
 * emits a field named `fee` (byte layout identical). We preserve the semantic
 * name `protocolFee` here — see `plan/layer-07-review-architect.md` MED-1.
 *
 * `StreamConverted` (Layer 8) does NOT share this layout — its second field is
 * `usdc_swapped`, not `amount`, and the conflation of units would cause silent
 * mis-accounting (see `layer-07-review-architect.md` MED-3). The caller must
 * NOT route StreamConverted discriminator bodies through this parser without
 * a Layer 8 dedicated parser.
 */
interface ParsedFundBody {
  otMint: PublicKey;
  grossAmount: bigint;
  protocolFee: bigint;
  netAmount: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  timestamp: number;
}

function parseFundEventBody(body: Buffer): ParsedFundBody | null {
  // Required: 32 (otMint) + 8 (amount) + 8 (protocol_fee) + 8 (total_funded) + 8 (locked_vested) + 8 (ts) = 72
  if (body.length < 72) return null;

  const otMint = new PublicKey(body.subarray(0, 32));
  const grossAmount = body.readBigUInt64LE(32);
  const protocolFee = body.readBigUInt64LE(40);
  const totalFunded = body.readBigUInt64LE(48);
  const lockedVested = body.readBigUInt64LE(56);
  const timestamp = Number(body.readBigInt64LE(64));

  if (protocolFee > grossAmount) {
    // Defensive: contract invariant — fee cannot exceed deposit.
    return null;
  }
  const netAmount = grossAmount - protocolFee;

  return { otMint, grossAmount, protocolFee, netAmount, totalFunded, lockedVested, timestamp };
}
