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
 * Layer 8 (D12) adds a distinct `StreamConverted` body layout (128 bytes,
 * `distributor` PDA prefix, convert-only suffix). Tests below verify both
 * parsers and the routing in `decodeProgramDataLine` cover the new event
 * source without regressing the existing `DistributorFunded` path.
 *
 * @see Layer 7 tester review §"Missing Tests" H3
 * @see Layer 8 architecture §9.2
 * @see Layer 8 decisions D2 + D12
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  parseFundEventBody,
  parseStreamConvertedBody,
} from '../src/event-watcher.js';

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

// ──────────────────────────────────────────────────────────────────────────
// Layer 8: StreamConverted (D12) — distinct 128-byte body layout
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hand-craft a `StreamConverted` body matching the on-chain emit layout
 * documented in §6.1 of layer-08-architecture.md. All multibyte integers
 * are little-endian; the body is exactly 128 bytes.
 */
function buildStreamConvertedBody(
  distributor: PublicKey,
  otMint: PublicKey,
  fields: {
    netAmount: bigint;
    protocolFee: bigint;
    totalFunded: bigint;
    lockedVested: bigint;
    timestamp: bigint;
    usdcIn: bigint;
    swapOutRwt: bigint;
    mintOutRwt: bigint;
  },
): Buffer {
  const buf = Buffer.alloc(128);
  distributor.toBuffer().copy(buf, 0);
  otMint.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(fields.netAmount, 64);
  buf.writeBigUInt64LE(fields.protocolFee, 72);
  buf.writeBigUInt64LE(fields.totalFunded, 80);
  buf.writeBigUInt64LE(fields.lockedVested, 88);
  buf.writeBigInt64LE(fields.timestamp, 96);
  buf.writeBigUInt64LE(fields.usdcIn, 104);
  buf.writeBigUInt64LE(fields.swapOutRwt, 112);
  buf.writeBigUInt64LE(fields.mintOutRwt, 120);
  return buf;
}

describe('parseStreamConvertedBody', () => {
  const distributor = Keypair.generate().publicKey;
  const otMint = Keypair.generate().publicKey;

  it('parses a typical StreamConverted body with all fields populated', () => {
    const body = buildStreamConvertedBody(distributor, otMint, {
      netAmount: 950_000_000n,
      protocolFee: 50_000_000n,
      totalFunded: 950_000_000n,
      lockedVested: 100_000_000n,
      timestamp: 1_700_000_000n,
      usdcIn: 1_000_000_000n,
      swapOutRwt: 600_000_000n,
      mintOutRwt: 400_000_000n,
    });
    const parsed = parseStreamConvertedBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.distributor.equals(distributor)).toBe(true);
    expect(parsed!.otMint.equals(otMint)).toBe(true);
    expect(parsed!.netAmount).toBe(950_000_000n);
    expect(parsed!.protocolFee).toBe(50_000_000n);
    expect(parsed!.totalFunded).toBe(950_000_000n);
    expect(parsed!.lockedVested).toBe(100_000_000n);
    expect(parsed!.timestamp).toBe(1_700_000_000);
    expect(parsed!.usdcIn).toBe(1_000_000_000n);
    expect(parsed!.swapOutRwt).toBe(600_000_000n);
    expect(parsed!.mintOutRwt).toBe(400_000_000n);
  });

  it('preserves u64 precision past Number.MAX_SAFE_INTEGER', () => {
    const big = (1n << 62n);
    const body = buildStreamConvertedBody(distributor, otMint, {
      netAmount: big,
      protocolFee: big,
      totalFunded: big,
      lockedVested: big,
      timestamp: 1n,
      usdcIn: big,
      swapOutRwt: big,
      mintOutRwt: big,
    });
    const parsed = parseStreamConvertedBody(body)!;
    expect(parsed.netAmount).toBe(big);
    expect(parsed.usdcIn).toBe(big);
    expect(parsed.swapOutRwt).toBe(big);
    expect(parsed.mintOutRwt).toBe(big);
  });

  it('parses zero-value fields without truncation', () => {
    const body = buildStreamConvertedBody(distributor, otMint, {
      netAmount: 0n,
      protocolFee: 0n,
      totalFunded: 0n,
      lockedVested: 0n,
      timestamp: 0n,
      usdcIn: 0n,
      swapOutRwt: 0n,
      mintOutRwt: 0n,
    });
    const parsed = parseStreamConvertedBody(body)!;
    expect(parsed.netAmount).toBe(0n);
    expect(parsed.usdcIn).toBe(0n);
    expect(parsed.swapOutRwt).toBe(0n);
    expect(parsed.mintOutRwt).toBe(0n);
  });

  it('returns null for bodies shorter than 128 bytes', () => {
    expect(parseStreamConvertedBody(Buffer.alloc(127))).toBeNull();
    expect(parseStreamConvertedBody(Buffer.alloc(64))).toBeNull();
    expect(parseStreamConvertedBody(Buffer.alloc(0))).toBeNull();
  });

  it('reads bytes in little-endian — high byte at high offset', () => {
    // Construct a body where amount = 0x0102030405060708 LE. The bytes at
    // offset 64..72 should be [08 07 06 05 04 03 02 01].
    const body = buildStreamConvertedBody(distributor, otMint, {
      netAmount: 0x0102030405060708n,
      protocolFee: 0n,
      totalFunded: 0n,
      lockedVested: 0n,
      timestamp: 0n,
      usdcIn: 0n,
      swapOutRwt: 0n,
      mintOutRwt: 0n,
    });
    expect([...body.subarray(64, 72)]).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    const parsed = parseStreamConvertedBody(body)!;
    expect(parsed.netAmount).toBe(0x0102030405060708n);
  });
});

describe('layout disjointness — DistributorFunded vs StreamConverted (D12)', () => {
  // Deterministic pubkeys so the test does not depend on random byte content
  // of `Keypair.generate()` (which may or may not pass the
  // `protocolFee > grossAmount` defensive guard in parseFundEventBody).
  const distributorBytes = Buffer.alloc(32);
  distributorBytes.fill(0xAA); // distinguishable, all bytes equal
  const otMintBytes = Buffer.alloc(32);
  otMintBytes.fill(0xBB);
  const distributor = new PublicKey(distributorBytes);
  const otMint = new PublicKey(otMintBytes);

  it('regression sentinel: parseFundEventBody read of a StreamConverted body never returns the real ot_mint', () => {
    // MED-3 sentinel — D12 mandates separate parsers because the two layouts
    // are NOT compatible. If a refactor accidentally routed StreamConverted
    // through `parseFundEventBody`, it would either:
    //   (a) succeed but read the 32-byte `distributor` prefix as ot_mint, OR
    //   (b) be rejected by the defensive `protocolFee > grossAmount` guard.
    // Either way the result is unusable. The invariant we capture here is the
    // strongest deterministic one: the OT mint surfaced through the wrong
    // parser MUST NOT equal the real OT mint — guaranteeing snapshot-taker
    // would then point at the wrong distributor PDA on derive.
    const body = buildStreamConvertedBody(distributor, otMint, {
      netAmount: 1n,
      protocolFee: 0n,
      totalFunded: 0n,
      lockedVested: 0n,
      timestamp: 0n,
      usdcIn: 0n,
      swapOutRwt: 0n,
      mintOutRwt: 0n,
    });
    const wrong = parseFundEventBody(body);
    // Either rejected by the defensive guard, or accepted with the wrong
    // ot_mint (equal to the distributor bytes, NOT the real ot_mint).
    if (wrong !== null) {
      expect(wrong.otMint.equals(otMint)).toBe(false);
      expect(wrong.otMint.equals(distributor)).toBe(true);
    }
    // The dedicated parser must succeed and return the correct ot_mint.
    const right = parseStreamConvertedBody(body)!;
    expect(right.otMint.equals(otMint)).toBe(true);
    expect(right.distributor.equals(distributor)).toBe(true);
  });

  it('parseStreamConvertedBody rejects 72-byte DistributorFunded bodies (length guard)', () => {
    // Inverse direction: feeding a DistributorFunded body to the 128-byte
    // parser must return null cleanly rather than reading past the buffer.
    const fundBody = buildFundBody(otMint, 1_000n, 1n);
    expect(parseStreamConvertedBody(fundBody)).toBeNull();
  });
});

describe('decodeProgramDataLine routing (live + reconcile parity)', () => {
  // We don't import decodeProgramDataLine directly (it's private); instead
  // we replicate the routing rules to assert the dispatch decision tree.
  // The body parsers used here ARE the production exports.
  const programId = Keypair.generate().publicKey;
  const otMint = Keypair.generate().publicKey;
  const fakeDistributor = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_dist'), otMint.toBuffer()],
    programId,
  )[0];

  function decode(disc: Buffer, body: Buffer):
    | { kind: 'DistributorFunded'; otMint: string }
    | { kind: 'StreamConverted'; distributor: string; otMint: string; usdcIn: bigint }
    | null {
    if (disc.equals(DISC_DISTRIBUTOR_FUNDED)) {
      const p = parseFundEventBody(body);
      return p ? { kind: 'DistributorFunded', otMint: p.otMint.toBase58() } : null;
    }
    if (disc.equals(DISC_STREAM_CONVERTED)) {
      const p = parseStreamConvertedBody(body);
      return p
        ? {
            kind: 'StreamConverted',
            distributor: p.distributor.toBase58(),
            otMint: p.otMint.toBase58(),
            usdcIn: p.usdcIn,
          }
        : null;
    }
    return null;
  }

  it('routes DistributorFunded discriminator through the 72-byte parser', () => {
    const body = buildFundBody(otMint, 1_000n, 1n);
    const out = decode(DISC_DISTRIBUTOR_FUNDED, body);
    expect(out).toEqual({ kind: 'DistributorFunded', otMint: otMint.toBase58() });
  });

  it('routes StreamConverted discriminator through the 128-byte parser', () => {
    const body = buildStreamConvertedBody(fakeDistributor, otMint, {
      netAmount: 200n,
      protocolFee: 10n,
      totalFunded: 200n,
      lockedVested: 0n,
      timestamp: 1n,
      usdcIn: 333n,
      swapOutRwt: 0n,
      mintOutRwt: 200n,
    });
    const out = decode(DISC_STREAM_CONVERTED, body);
    expect(out).toEqual({
      kind: 'StreamConverted',
      distributor: fakeDistributor.toBase58(),
      otMint: otMint.toBase58(),
      usdcIn: 333n,
    });
  });

  it('returns null for unknown discriminators (other program events)', () => {
    const fakeDisc = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]);
    const body = buildFundBody(otMint, 1n, 1n);
    expect(decode(fakeDisc, body)).toBeNull();
  });
});
