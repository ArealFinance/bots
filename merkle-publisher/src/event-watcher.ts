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
 * Two distinct event sources are handled (per Layer 8 D12):
 *   - `DistributorFunded` (Layer 7): emitted by `fund_distributor`. Body
 *     layout in `parseFundEventBody` below (72 bytes, `ot_mint` at offset 0).
 *   - `StreamConverted` (Layer 8): emitted by `convert_to_rwt`. Body layout
 *     in `parseStreamConvertedBody` (128 bytes, prepends a 32-byte
 *     `distributor` PDA + appends 3 convert-only fields). Uses a dedicated
 *     parser — feeding its body through `parseFundEventBody` would silently
 *     mis-account because offsets are shifted by +32.
 *
 * On reconnect, `reconcile()` scans tx signatures since the last processed slot
 * via `getSignaturesForAddress` and re-plays any missed fund events. Both live
 * and reconcile paths share `decodeProgramDataLine` so the dispatch logic is
 * identical between them.
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
            const event = decodeProgramDataLine(
              line,
              ctx.slot,
              logs.signature,
              this.programId,
            );
            if (!event) continue;
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
        const event = decodeProgramDataLine(line, slot, signature, this.programId);
        if (!event) continue;
        events.push(event);
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
 * name `protocolFee` here — see `Layer 7 architect review` MED-1.
 *
 * `StreamConverted` (Layer 8) does NOT share this layout — its first field is a
 * 32-byte `distributor` prefix, shifting every offset by +32 (D12). It is parsed
 * by the dedicated `parseStreamConvertedBody` below. Routing a `StreamConverted`
 * body through this parser would mis-read `distributor` bytes as the OT mint and
 * the OT mint bytes as `amount`, silently corrupting snapshot accounting. See
 * `Layer 7 architect review` MED-3 / `Layer 8 decisions` D12.
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

export function parseFundEventBody(body: Buffer): ParsedFundBody | null {
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

/**
 * Parse the `StreamConverted` event body emitted by Layer 8 `convert_to_rwt`.
 *
 * Layout (128-byte body — see Layer 8 architecture §6.1 / decisions D12):
 *
 *   offset 0..32    distributor    [u8; 32]   — Distributor PDA (NEW vs DistributorFunded)
 *   offset 32..64   ot_mint        [u8; 32]
 *   offset 64..72   amount         u64 (LE)   — NET RWT funded this TX (D2: NOT cumulative)
 *   offset 72..80   protocol_fee   u64 (LE)   — RWT fee taken at outer level
 *   offset 80..88   total_funded   u64 (LE)   — distributor.total_funded AFTER update
 *   offset 88..96   locked_vested  u64 (LE)   — distributor.locked_vested AFTER update
 *   offset 96..104  timestamp      i64 (LE)
 *   offset 104..112 usdc_in        u64 (LE)   — USDC consumed across both legs
 *   offset 112..120 swap_out_rwt   u64 (LE)   — RWT acquired via DEX swap
 *   offset 120..128 mint_out_rwt   u64 (LE)   — RWT acquired via RWT Engine mint
 *
 * D2: `amount` is the **net** result of the conversion (= rwt_acquired −
 * protocol_fee, computed on-chain). Unlike `DistributorFunded.amount` which is
 * gross, `StreamConverted.amount` is already net — so for snapshot aggregation
 * we treat it as the per-deposit `netAmount` directly. A `grossAmount` value is
 * synthesised as `netAmount + protocolFee` purely so the
 * `BaseFundEvent` shape stays uniform across kinds (downstream consumers must
 * not rely on `grossAmount` for `StreamConverted` accounting).
 */
interface ParsedStreamConvertedBody {
  distributor: PublicKey;
  otMint: PublicKey;
  netAmount: bigint;
  protocolFee: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  timestamp: number;
  usdcIn: bigint;
  swapOutRwt: bigint;
  mintOutRwt: bigint;
}

export function parseStreamConvertedBody(body: Buffer): ParsedStreamConvertedBody | null {
  // Required: 32+32 (PDAs) + 4×u64 + i64 + 3×u64 = 64 + 32 + 8 + 24 = 128
  if (body.length < 128) return null;

  const distributor = new PublicKey(body.subarray(0, 32));
  const otMint = new PublicKey(body.subarray(32, 64));
  const netAmount = body.readBigUInt64LE(64);
  const protocolFee = body.readBigUInt64LE(72);
  const totalFunded = body.readBigUInt64LE(80);
  const lockedVested = body.readBigUInt64LE(88);
  const timestamp = Number(body.readBigInt64LE(96));
  const usdcIn = body.readBigUInt64LE(104);
  const swapOutRwt = body.readBigUInt64LE(112);
  const mintOutRwt = body.readBigUInt64LE(120);

  return {
    distributor,
    otMint,
    netAmount,
    protocolFee,
    totalFunded,
    lockedVested,
    timestamp,
    usdcIn,
    swapOutRwt,
    mintOutRwt,
  };
}

/**
 * Decode a single Solana log line into a `FundEvent`, or return `null` if the
 * line is not a fund-event payload. Centralises the dispatch logic shared
 * between the live `onLogs` subscription and the historical `reconcileRange`
 * replay so both paths stay byte-for-byte identical.
 *
 * Returns `null` for: non-`Program data:` lines, payloads shorter than the
 * 8-byte discriminator, unknown discriminators, and malformed bodies.
 */
function decodeProgramDataLine(
  line: string,
  slot: number,
  signature: string,
  programId: PublicKey,
): FundEvent | null {
  if (!line.startsWith('Program data: ')) return null;
  const b64 = line.slice('Program data: '.length);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 8) return null;

  const disc = bytes.subarray(0, 8);
  const body = bytes.subarray(8);

  if (disc.equals(DISC_DISTRIBUTOR_FUNDED)) {
    const parsed = parseFundEventBody(body);
    if (!parsed) return null;
    // Re-derive distributor PDA from ot_mint. Match the on-chain seed
    // (architecture §2.2: [b"merkle_dist", ot_mint.as_ref()]).
    const [distributor] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_dist'), parsed.otMint.toBuffer()],
      programId,
    );
    return {
      kind: 'DistributorFunded',
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
    };
  }

  if (disc.equals(DISC_STREAM_CONVERTED)) {
    const parsed = parseStreamConvertedBody(body);
    if (!parsed) return null;
    // The on-chain event already carries the distributor PDA — no re-derivation
    // needed (and notably, fragile: the on-chain PDA was created against this
    // program's seeds and authority, so we trust it directly per D12).
    return {
      kind: 'StreamConverted',
      distributor: parsed.distributor,
      otMint: parsed.otMint,
      // For convert events, on-chain `amount` is already net (D2). We
      // synthesise grossAmount = net + fee purely to satisfy BaseFundEvent;
      // downstream aggregation uses netAmount directly.
      grossAmount: parsed.netAmount + parsed.protocolFee,
      protocolFee: parsed.protocolFee,
      netAmount: parsed.netAmount,
      totalFunded: parsed.totalFunded,
      lockedVested: parsed.lockedVested,
      slot,
      signature,
      fundTs: parsed.timestamp,
      usdcIn: parsed.usdcIn,
      swapOutRwt: parsed.swapOutRwt,
      mintOutRwt: parsed.mintOutRwt,
    };
  }

  // Unknown discriminator — skip silently (other program events).
  return null;
}
