/**
 * SnapshotStore persistence tests — catches silent regressions in the bot's
 * core fairness guarantee (no double-counting of deposits, u64 bigint fidelity,
 * idempotency).
 *
 * Uses on-disk SQLite files in the OS tempdir (not `:memory:` because the
 * store insists on creating a parent directory and opening via path). Each
 * test creates a unique file so they can run in parallel.
 *
 * @see plan/layer-07-review-tester.md §"Missing Tests" H1
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotStore } from '../src/snapshot-store.js';
import type { Snapshot } from '../src/types.js';

function makeTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-store-test-'));
  return path.join(dir, 'store.db');
}

function cleanup(dbPath: string) {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    // ignore — not critical for test correctness
  }
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    distributor: 'Distr1111111111111111111111111111111111111',
    depositEpoch: 0,
    depositAmount: 1_000_000_000n,
    totalFundedAtEvent: 1_000_000_000n,
    slot: 42,
    fundTs: 1_700_000_000,
    txSignature: 'sig-default',
    totalEligible: 500_000_000n,
    balances: [
      { holder: 'Holder11111111111111111111111111111111111', balance: 300_000_000n, eligible: 1 },
      { holder: 'Holder22222222222222222222222222222222222', balance: 200_000_000n, eligible: 1 },
    ],
    ...overrides,
  };
}

describe('SnapshotStore', () => {
  let dbPath: string;
  let store: SnapshotStore;

  beforeEach(() => {
    dbPath = makeTempPath();
    store = new SnapshotStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore double-close */
    }
    cleanup(dbPath);
  });

  it('insert → read back preserves all fields', () => {
    const s = makeSnapshot({ txSignature: 'sig-insert-readback' });
    store.saveSnapshot(s);
    const all = store.getAllSnapshots(s.distributor);
    expect(all).toHaveLength(1);
    const r = all[0]!;
    expect(r.depositEpoch).toBe(s.depositEpoch);
    expect(r.depositAmount).toBe(s.depositAmount);
    expect(r.totalFundedAtEvent).toBe(s.totalFundedAtEvent);
    expect(r.totalEligible).toBe(s.totalEligible);
    expect(r.txSignature).toBe(s.txSignature);
    expect(r.balances).toHaveLength(2);
  });

  it('UNIQUE constraint on (distributor, deposit_epoch) rejects duplicate', () => {
    const s = makeSnapshot({ depositEpoch: 0, txSignature: 'sig-a' });
    store.saveSnapshot(s);
    // Same (distributor, depositEpoch) — must reject.
    expect(() => store.saveSnapshot(makeSnapshot({ depositEpoch: 0, txSignature: 'sig-b' }))).toThrow();
  });

  it('UNIQUE idx_snap_tx rejects duplicate tx_signature within same distributor', () => {
    store.saveSnapshot(makeSnapshot({ depositEpoch: 0, txSignature: 'dup-sig' }));
    expect(() => store.saveSnapshot(makeSnapshot({ depositEpoch: 1, txSignature: 'dup-sig' }))).toThrow();
  });

  it('preserves u64 precision for values > Number.MAX_SAFE_INTEGER', () => {
    const big = (1n << 62n); // 4611686018427387904
    const s = makeSnapshot({
      depositEpoch: 7,
      depositAmount: big,
      totalFundedAtEvent: big,
      totalEligible: big,
      balances: [{ holder: 'HolderBig0000000000000000000000000000000000', balance: big, eligible: 1 }],
      txSignature: 'sig-bigint',
    });
    store.saveSnapshot(s);
    const all = store.getAllSnapshots(s.distributor);
    expect(all[0]!.depositAmount).toBe(big);
    expect(all[0]!.totalFundedAtEvent).toBe(big);
    expect(all[0]!.totalEligible).toBe(big);
    expect(all[0]!.balances[0]!.balance).toBe(big);
  });

  it('nextEpoch returns max(deposit_epoch) + 1 with gaps', () => {
    const distributor = 'DistributorGaps111111111111111111111111111';
    store.saveSnapshot(makeSnapshot({ distributor, depositEpoch: 0, txSignature: 'g-0' }));
    store.saveSnapshot(makeSnapshot({ distributor, depositEpoch: 5, txSignature: 'g-5' }));
    // gap: 1..4 missing
    expect(store.nextEpoch(distributor)).toBe(6);
    // empty distributor returns 0
    expect(store.nextEpoch('EmptyDistributor1111111111111111111111111')).toBe(0);
  });

  it('migration is idempotent — second SnapshotStore on same file re-opens cleanly', () => {
    const distributor = 'DistributorReopen11111111111111111111111111';
    store.saveSnapshot(makeSnapshot({ distributor, depositEpoch: 0, txSignature: 'r-0' }));
    store.close();

    // Re-open: migrate() runs CREATE TABLE IF NOT EXISTS; must not fail and must
    // preserve data.
    const reopened = new SnapshotStore(dbPath);
    const all = reopened.getAllSnapshots(distributor);
    expect(all).toHaveLength(1);
    expect(all[0]!.txSignature).toBe('r-0');
    reopened.close();
  });

  it('hasSnapshotForTx detects existing tx_signature', () => {
    const s = makeSnapshot({ distributor: 'DDup11111111111111111111111111111111111111', txSignature: 'check-me' });
    store.saveSnapshot(s);
    expect(store.hasSnapshotForTx(s.distributor, 'check-me')).toBe(true);
    expect(store.hasSnapshotForTx(s.distributor, 'not-there')).toBe(false);
    // different distributor
    expect(store.hasSnapshotForTx('OtherDist111111111111111111111111111111111', 'check-me')).toBe(false);
  });

  it('recordPublish throws on duplicate tx_signature (idempotency guard)', () => {
    const dist = 'DPub111111111111111111111111111111111111111';
    store.recordPublish({
      distributor: dist,
      epoch: 1,
      merkleRoot: 'aa'.repeat(32),
      maxTotalClaim: 1000n,
      txSignature: 'publish-sig',
      publishedAt: 1_700_000_000,
    });
    expect(() =>
      store.recordPublish({
        distributor: dist,
        epoch: 2,
        merkleRoot: 'bb'.repeat(32),
        maxTotalClaim: 2000n,
        txSignature: 'publish-sig', // dup
        publishedAt: 1_700_000_010,
      }),
    ).toThrow();
  });

  it('getLastPublish returns highest epoch publish record', () => {
    const dist = 'DLatest111111111111111111111111111111111111';
    store.recordPublish({ distributor: dist, epoch: 1, merkleRoot: '11'.repeat(32), maxTotalClaim: 100n, txSignature: 'p-1', publishedAt: 100 });
    store.recordPublish({ distributor: dist, epoch: 3, merkleRoot: '33'.repeat(32), maxTotalClaim: 300n, txSignature: 'p-3', publishedAt: 300 });
    store.recordPublish({ distributor: dist, epoch: 2, merkleRoot: '22'.repeat(32), maxTotalClaim: 200n, txSignature: 'p-2', publishedAt: 200 });
    const last = store.getLastPublish(dist);
    expect(last?.epoch).toBe(3);
    expect(last?.maxTotalClaim).toBe(300n);
  });

  describe('leader lock (M-2 / NEW-M-1)', () => {
    it('acquires the lock on an empty table', () => {
      expect(store.tryAcquireLeaderLock(1111, 'host-a')).toBe(true);
    });

    it('refuses acquire when an alive lock is held by a different (pid, hostname)', () => {
      expect(store.tryAcquireLeaderLock(1111, 'host-a')).toBe(true);
      // Second caller — alive heartbeat still fresh (< 60s old).
      expect(store.tryAcquireLeaderLock(2222, 'host-b')).toBe(false);
    });

    it('refreshes the lock when the same (pid, hostname) re-acquires', () => {
      expect(store.tryAcquireLeaderLock(1111, 'host-a')).toBe(true);
      // Same owner re-acquiring should succeed (idempotent refresh).
      expect(store.tryAcquireLeaderLock(1111, 'host-a')).toBe(true);
    });

    it('succeeds when the existing lock is stale (heartbeat older than threshold)', () => {
      expect(store.tryAcquireLeaderLock(1111, 'host-a', 60)).toBe(true);
      // Simulate stale by calling acquire with a 0-second staleness window
      // from a different owner — the existing row's heartbeat is "now",
      // so it's still alive at staleSecs=60 but NOT at staleSecs=0.
      expect(store.tryAcquireLeaderLock(2222, 'host-b', 0)).toBe(true);
    });

    it('NEW-M-1: acquire is atomic — sequential cross-owner acquire returns false for the loser', () => {
      // A full concurrent race is hard to simulate without worker_threads,
      // but the atomicity test reduces to: after owner A acquires, owner B
      // CANNOT also return true. This would fail with the pre-fix SELECT →
      // INSERT sequence only under real concurrency; the test captures the
      // contract: "one acquire must return false when another owner is live".
      const a = store.tryAcquireLeaderLock(3000, 'host-x');
      const b = store.tryAcquireLeaderLock(3001, 'host-y');
      expect(a).toBe(true);
      expect(b).toBe(false);
    });

    it('heartbeat + release behave as expected', () => {
      expect(store.tryAcquireLeaderLock(1111, 'host-a')).toBe(true);
      // Heartbeat of wrong owner is a no-op; right owner refreshes.
      expect(() => store.heartbeatLeaderLock(2222, 'other-host')).not.toThrow();
      expect(() => store.heartbeatLeaderLock(1111, 'host-a')).not.toThrow();
      // Release by wrong owner is a no-op (lock still held).
      store.releaseLeaderLock(9999, 'host-a');
      expect(store.tryAcquireLeaderLock(2222, 'host-b')).toBe(false);
      // Right owner releases → next caller can acquire.
      store.releaseLeaderLock(1111, 'host-a');
      expect(store.tryAcquireLeaderLock(2222, 'host-b')).toBe(true);
    });
  });

  describe('isEpochPublished (NEW-M-3)', () => {
    it('returns true for recorded publishes, false otherwise', () => {
      const dist = 'DistPublishCheck11111111111111111111111111';
      expect(store.isEpochPublished(dist, 1)).toBe(false);
      store.recordPublish({
        distributor: dist,
        epoch: 1,
        merkleRoot: 'aa'.repeat(32),
        maxTotalClaim: 100n,
        txSignature: 'pub-tx-1',
        publishedAt: 100,
      });
      expect(store.isEpochPublished(dist, 1)).toBe(true);
      expect(store.isEpochPublished(dist, 2)).toBe(false);
      expect(store.isEpochPublished('OtherDistRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', 1)).toBe(false);
    });
  });
});
