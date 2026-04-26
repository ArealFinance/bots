import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

import { CheckpointStore } from '../src/checkpoint.js';
import {
  decideDistribution,
  DISTRIBUTION_COOLDOWN_SECS,
  SingleFlightLock,
} from '../src/crank.js';
import { discDistributeRevenue, buildDistributeRevenueIx } from '../src/distributor.js';
import {
  deriveRevenuePdas,
  parseRevenueAccount,
  parseRevenueConfig,
} from '../src/revenue-source.js';
import type { RevenueAccount, RevenueConfig } from '../src/types.js';

const OT_PROGRAM = new PublicKey('oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL');
const OT_MINT = new PublicKey('11111111111111111111111111111112');

function makeAccount(overrides: Partial<RevenueAccount> = {}): RevenueAccount {
  return {
    otMint: OT_MINT,
    revenueTokenAccount: new PublicKey('11111111111111111111111111111113'),
    totalDistributed: 0n,
    distributionCount: 0n,
    lastDistributionTs: 0,
    minDistributionAmount: 100_000_000n,
    isDistributing: false,
    bump: 255,
    ...overrides,
  };
}

function makeConfig(activeCount = 2): RevenueConfig {
  return {
    otMint: OT_MINT,
    activeCount,
    configVersion: 0n,
    arealFeeDestination: new PublicKey('11111111111111111111111111111114'),
    bump: 255,
    destinations: Array.from({ length: activeCount }, (_, i) => ({
      address: new PublicKey(Buffer.alloc(32, i + 5)),
      allocationBps: Math.floor(10_000 / activeCount),
      label: `dest-${i}`,
    })),
  };
}

describe('decideDistribution (D9 logic)', () => {
  it('sends when balance ≥ min, cooldown elapsed, destinations active', () => {
    const decision = decideDistribution({
      balance: 200_000_000n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 1_000,
      isDistributing: false,
      activeDestinations: 3,
      nowSecs: 1_000 + DISTRIBUTION_COOLDOWN_SECS + 1,
    });
    expect(decision.kind).toBe('send');
    if (decision.kind === 'send') {
      expect(decision.balance).toBe(200_000_000n);
    }
  });

  it('skips with below_min when balance < min', () => {
    const decision = decideDistribution({
      balance: 50_000_000n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 0,
      isDistributing: false,
      activeDestinations: 2,
      nowSecs: 9_999_999,
    });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'below_min' });
  });

  it('skips with cooldown when not enough time elapsed', () => {
    const decision = decideDistribution({
      balance: 1_000_000_000n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 1_000_000,
      isDistributing: false,
      activeDestinations: 2,
      nowSecs: 1_000_000 + 60, // 60 s ago
    });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'cooldown' });
  });

  it('first-ever distribution (lastDistributionTs == 0) ignores cooldown', () => {
    const decision = decideDistribution({
      balance: 100_000_001n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 0,
      isDistributing: false,
      activeDestinations: 1,
      nowSecs: 12_345,
    });
    expect(decision.kind).toBe('send');
  });

  it('skips with concurrent_distribution when is_distributing flag is set', () => {
    const decision = decideDistribution({
      balance: 1_000_000_000n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 0,
      isDistributing: true,
      activeDestinations: 2,
      nowSecs: 0,
    });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'concurrent_distribution' });
  });

  it('skips with no_destinations when activeCount == 0', () => {
    const decision = decideDistribution({
      balance: 1_000_000_000n,
      minDistributionAmount: 100_000_000n,
      lastDistributionTs: 0,
      isDistributing: false,
      activeDestinations: 0,
      nowSecs: 0,
    });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_destinations' });
  });
});

describe('SingleFlightLock (D10 dedupe)', () => {
  it('grants the first acquire and refuses subsequent acquires', () => {
    const lock = new SingleFlightLock();
    expect(lock.acquire('ot-A')).toBe(true);
    expect(lock.acquire('ot-A')).toBe(false);
    expect(lock.has('ot-A')).toBe(true);
  });

  it('different keys do not block each other', () => {
    const lock = new SingleFlightLock();
    expect(lock.acquire('ot-A')).toBe(true);
    expect(lock.acquire('ot-B')).toBe(true);
  });

  it('release lets the next acquire succeed', () => {
    const lock = new SingleFlightLock();
    lock.acquire('ot-A');
    lock.release('ot-A');
    expect(lock.acquire('ot-A')).toBe(true);
  });
});

describe('CheckpointStore (D9 hint cache)', () => {
  let dbPath: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `revenue-crank-test-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* noop */
    }
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* noop */
    }
  });

  it('returns null for unknown OTs', () => {
    expect(store.get(OT_MINT.toBase58())).toBeNull();
  });

  it('upsert + get round-trips lastDistributionTs and signature', () => {
    store.upsert(OT_MINT.toBase58(), 1_700_000_000, 'sig-aaa');
    const row = store.get(OT_MINT.toBase58());
    expect(row).not.toBeNull();
    expect(row!.lastDistributionTs).toBe(1_700_000_000);
    expect(row!.lastSignature).toBe('sig-aaa');
  });

  it('upsert overwrites existing rows', () => {
    store.upsert(OT_MINT.toBase58(), 100, 'sig-old');
    store.upsert(OT_MINT.toBase58(), 200, 'sig-new');
    const row = store.get(OT_MINT.toBase58());
    expect(row!.lastDistributionTs).toBe(200);
    expect(row!.lastSignature).toBe('sig-new');
  });
});

describe('PDA derivation + ix builder', () => {
  it('deriveRevenuePdas produces deterministic results', () => {
    const a = deriveRevenuePdas(OT_MINT, OT_PROGRAM);
    const b = deriveRevenuePdas(OT_MINT, OT_PROGRAM);
    expect(a.revenueAccount.toBase58()).toBe(b.revenueAccount.toBase58());
    expect(a.revenueConfig.toBase58()).toBe(b.revenueConfig.toBase58());
  });

  it('discriminator equals sha256("global:distribute_revenue")[..8]', () => {
    const disc = discDistributeRevenue();
    expect(disc.length).toBe(8);
    // Re-compute and assert byte equality (catches accidental drift).
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHash('sha256').update('global:distribute_revenue').digest().subarray(0, 8);
    expect(disc.equals(expected)).toBe(true);
  });

  it('buildDistributeRevenueIx layouts all required accounts including remaining_accounts', () => {
    const { revenueAccount, revenueConfig } = deriveRevenuePdas(OT_MINT, OT_PROGRAM);
    const account = makeAccount();
    const config = makeConfig(3);
    const crank = Keypair.generate().publicKey;

    const ix = buildDistributeRevenueIx({
      otProgramId: OT_PROGRAM,
      crank,
      otMint: OT_MINT,
      revenueAccount,
      revenueConfig,
      account,
      config,
    });

    // 7 named + 3 remaining = 10 accounts.
    expect(ix.keys.length).toBe(7 + 3);
    expect(ix.keys[0]!.pubkey.equals(crank)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(OT_MINT)).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(revenueAccount)).toBe(true);
    expect(ix.keys[2]!.isWritable).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(account.revenueTokenAccount)).toBe(true);
    expect(ix.keys[5]!.pubkey.equals(config.arealFeeDestination)).toBe(true);
    // Remaining accounts at indices 7..10 are the destination ATAs.
    for (let i = 0; i < 3; i++) {
      expect(ix.keys[7 + i]!.pubkey.equals(config.destinations[i]!.address)).toBe(true);
      expect(ix.keys[7 + i]!.isWritable).toBe(true);
    }
    expect(ix.data.length).toBe(8); // discriminator only, no args
    expect(ix.programId.equals(OT_PROGRAM)).toBe(true);
  });
});

describe('parseRevenueAccount', () => {
  it('round-trips a hand-rolled buffer', () => {
    const buf = Buffer.alloc(8 + 98);
    // discriminator stays zero — the parser ignores it
    OT_MINT.toBuffer().copy(buf, 8);
    new PublicKey('11111111111111111111111111111113').toBuffer().copy(buf, 8 + 32);
    buf.writeBigUInt64LE(123n, 8 + 64); // total_distributed
    buf.writeBigUInt64LE(7n, 8 + 72); // distribution_count
    buf.writeBigInt64LE(1_700_000_000n, 8 + 80); // last_distribution_ts
    buf.writeBigUInt64LE(100_000_000n, 8 + 88); // min_distribution_amount
    buf.writeUInt8(1, 8 + 96); // is_distributing = true
    buf.writeUInt8(254, 8 + 97); // bump

    const parsed = parseRevenueAccount(buf);
    expect(parsed.totalDistributed).toBe(123n);
    expect(parsed.distributionCount).toBe(7n);
    expect(parsed.lastDistributionTs).toBe(1_700_000_000);
    expect(parsed.minDistributionAmount).toBe(100_000_000n);
    expect(parsed.isDistributing).toBe(true);
    expect(parsed.bump).toBe(254);
  });

  it('rejects buffers shorter than 106 bytes', () => {
    expect(() => parseRevenueAccount(Buffer.alloc(50))).toThrow();
  });
});

describe('parseRevenueConfig', () => {
  it('extracts only the active destinations slice', () => {
    const buf = Buffer.alloc(8 + 734);
    OT_MINT.toBuffer().copy(buf, 8);
    // Fill destinations[0..2] with distinct addresses + bps
    for (let i = 0; i < 3; i++) {
      const off = 8 + 32 + i * 66;
      Buffer.alloc(32, i + 1).copy(buf, off);
      buf.writeUInt16LE((i + 1) * 1000, off + 32);
      Buffer.from(`label${i}`).copy(buf, off + 34);
    }
    buf.writeUInt8(2, 8 + 692); // active_count = 2
    buf.writeBigUInt64LE(42n, 8 + 693); // config_version
    Buffer.alloc(32, 0xff).copy(buf, 8 + 701); // areal_fee_destination
    buf.writeUInt8(255, 8 + 733); // bump

    const cfg = parseRevenueConfig(buf);
    expect(cfg.activeCount).toBe(2);
    expect(cfg.destinations).toHaveLength(2);
    expect(cfg.destinations[0]!.allocationBps).toBe(1000);
    expect(cfg.destinations[1]!.allocationBps).toBe(2000);
    expect(cfg.configVersion).toBe(42n);
    expect(cfg.bump).toBe(255);
  });
});
