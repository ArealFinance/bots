/**
 * Event-watcher parse robustness.
 *
 * The watcher subscribes to program logs and extracts DistributorFunded /
 * StreamConverted events from "Program data: <base64>" lines. Malformed or
 * adversarial logs must be gracefully skipped rather than crashing or
 * dispatching phantom events (which would corrupt snapshot history).
 *
 * We do NOT test the live Connection.onLogs path — that requires a real
 * validator. Instead we verify the discriminator assembly, base64 decoding,
 * and body parsing by constructing synthetic log payloads and driving them
 * through an in-process handler that mirrors the watcher's dispatch logic.
 *
 * @see plan/layer-07-review-tester.md §"Missing Tests" H3
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';

// Reimplement the discriminator here to avoid re-exporting internals.
// Matches event-watcher.ts exactly: sha256("event:" + name)[..8].
function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update('event:' + name).digest().subarray(0, 8);
}

const DISC_DISTRIBUTOR_FUNDED = eventDiscriminator('DistributorFunded');
const DISC_STREAM_CONVERTED = eventDiscriminator('StreamConverted');

function buildFundBody(otMint: PublicKey, amount: bigint, timestamp: bigint): Buffer {
  // 32 otMint + 8 amount + 8 fee + 8 totalFunded + 8 lockedVested + 8 timestamp = 72
  const buf = Buffer.alloc(72);
  otMint.toBuffer().copy(buf, 0);
  buf.writeBigUInt64LE(amount, 32);
  buf.writeBigUInt64LE(0n, 40); // fee
  buf.writeBigUInt64LE(amount, 48); // totalFunded
  buf.writeBigUInt64LE(0n, 56); // lockedVested
  buf.writeBigInt64LE(timestamp, 64);
  return buf;
}

function toProgramDataLine(disc: Buffer, body: Buffer): string {
  return 'Program data: ' + Buffer.concat([disc, body]).toString('base64');
}

/**
 * Mirror of the watcher's per-line dispatch loop. Returns the list of
 * successfully-parsed events from a log array.
 */
function parseLogLines(lines: string[]): Array<{ kind: string; otMint: string; amount: bigint }> {
  const out: Array<{ kind: string; otMint: string; amount: bigint }> = [];
  for (const line of lines) {
    if (!line.startsWith('Program data: ')) continue;
    const b64 = line.slice('Program data: '.length);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (bytes.length < 8) continue;

    const disc = bytes.subarray(0, 8);
    const body = bytes.subarray(8);

    let kind: string | null = null;
    if (disc.equals(DISC_DISTRIBUTOR_FUNDED)) kind = 'DistributorFunded';
    else if (disc.equals(DISC_STREAM_CONVERTED)) kind = 'StreamConverted';
    if (!kind) continue;

    // Body must be >= 72 bytes (minimum prefix).
    if (body.length < 72) continue;

    const otMint = new PublicKey(body.subarray(0, 32));
    const amount = body.readBigUInt64LE(32);
    out.push({ kind, otMint: otMint.toBase58(), amount });
  }
  return out;
}

describe('event-watcher parse robustness', () => {
  const ot = Keypair.generate().publicKey;

  it('dispatches exactly one event for a valid DistributorFunded line', () => {
    const body = buildFundBody(ot, 1_000_000_000n, 1_700_000_000n);
    const line = toProgramDataLine(DISC_DISTRIBUTOR_FUNDED, body);
    const parsed = parseLogLines([line]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('DistributorFunded');
    expect(parsed[0]!.otMint).toBe(ot.toBase58());
    expect(parsed[0]!.amount).toBe(1_000_000_000n);
  });

  it('dispatches for StreamConverted (shared layout prefix)', () => {
    const body = buildFundBody(ot, 500_000_000n, 1_700_000_100n);
    const line = toProgramDataLine(DISC_STREAM_CONVERTED, body);
    const parsed = parseLogLines([line]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('StreamConverted');
  });

  it('skips a line whose body is truncated (< 72 bytes)', () => {
    const partial = Buffer.alloc(40); // under minimum
    ot.toBuffer().copy(partial, 0);
    partial.writeBigUInt64LE(123n, 32);
    const line = 'Program data: ' + Buffer.concat([DISC_DISTRIBUTOR_FUNDED, partial]).toString('base64');
    expect(parseLogLines([line])).toHaveLength(0);
  });

  it('skips a line with a wrong / unknown discriminator', () => {
    const fakeDisc = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const line = toProgramDataLine(fakeDisc, buildFundBody(ot, 1n, 1n));
    expect(parseLogLines([line])).toHaveLength(0);
  });

  it('skips non-"Program data:" lines (plain program log)', () => {
    expect(parseLogLines(['Program log: Instruction: FundDistributor'])).toHaveLength(0);
    expect(parseLogLines(['Program SomeProgram consumed 1234 of 1400000 compute units'])).toHaveLength(0);
  });

  it('skips a line shorter than discriminator length', () => {
    // 4 bytes of base64-encoded data — under 8-byte discriminator.
    const line = 'Program data: ' + Buffer.from([1, 2, 3, 4]).toString('base64');
    expect(parseLogLines([line])).toHaveLength(0);
  });

  it('processes multiple events in one log array (one tx can emit many)', () => {
    const l1 = toProgramDataLine(DISC_DISTRIBUTOR_FUNDED, buildFundBody(ot, 1n, 100n));
    const l2 = 'Program log: something between';
    const l3 = toProgramDataLine(DISC_STREAM_CONVERTED, buildFundBody(ot, 2n, 200n));
    const parsed = parseLogLines([l1, l2, l3]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.kind).toBe('DistributorFunded');
    expect(parsed[1]!.kind).toBe('StreamConverted');
  });

  it('gracefully handles garbage base64 payload', () => {
    // Buffer.from(...).toString('base64') round-trip survives, but invalid base64
    // characters are silently dropped by Node's buffer decoder — resulting in
    // shorter-than-expected body which the length check catches.
    const line = 'Program data: !!!not-base64!!!';
    expect(() => parseLogLines([line])).not.toThrow();
    expect(parseLogLines([line])).toHaveLength(0);
  });
});
