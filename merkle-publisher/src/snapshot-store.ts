import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HolderBalance,
  PublishRecord,
  Snapshot,
  SnapshotEventKind,
} from './types.js';
import { logger } from './logger.js';

/**
 * Raw shape of a row read from the `snapshots` table. Aligned with the
 * column list used by `getUnpublishedSnapshots` / `getAllSnapshots`. Integer
 * columns surface as `bigint` because `defaultSafeIntegers(true)` is enabled.
 */
interface SnapshotRow {
  deposit_epoch: bigint;
  deposit_amount: bigint;
  slot: bigint;
  fund_ts: bigint;
  tx_signature: string;
  total_eligible: bigint;
  total_funded_at_event: bigint;
  event_kind: string;
}

/**
 * SQLite-backed persistence for snapshots and publish history.
 *
 * Design choice: `better-sqlite3` — synchronous, zero-fuss, durable WAL.
 * The workload is low-QPS (one write per fund event, one per publish cycle),
 * so synchronous transactions are simpler and safer than async pooling.
 *
 * BigInt handling: better-sqlite3 returns INTEGER columns as `number`
 * unless `.safeIntegers(true)` is enabled — which returns them as `bigint`.
 * We enable it at the connection level so u64 balances never silently lose
 * precision past Number.MAX_SAFE_INTEGER (2^53).
 */
export class SnapshotStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    // Critical for u64 precision:
    this.db.defaultSafeIntegers(true);

    this.migrate();
    logger.info('SnapshotStore ready', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        distributor     TEXT    NOT NULL,
        deposit_epoch   INTEGER NOT NULL,
        deposit_amount  INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        fund_ts         INTEGER NOT NULL,
        tx_signature    TEXT    NOT NULL,
        total_eligible  INTEGER NOT NULL,
        published_epoch INTEGER,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (distributor, deposit_epoch)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_tx
        ON snapshots(distributor, tx_signature);

      CREATE TABLE IF NOT EXISTS snapshot_balances (
        distributor     TEXT    NOT NULL,
        deposit_epoch   INTEGER NOT NULL,
        holder          TEXT    NOT NULL,
        balance         INTEGER NOT NULL,
        eligible        INTEGER NOT NULL,
        PRIMARY KEY (distributor, deposit_epoch, holder),
        FOREIGN KEY (distributor, deposit_epoch)
          REFERENCES snapshots(distributor, deposit_epoch) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_snap_balances_holder
        ON snapshot_balances(distributor, holder);

      CREATE TABLE IF NOT EXISTS publishes (
        distributor     TEXT    NOT NULL,
        epoch           INTEGER NOT NULL,
        merkle_root     TEXT    NOT NULL,
        max_total_claim INTEGER NOT NULL,
        tx_signature    TEXT    NOT NULL UNIQUE,
        published_at    INTEGER NOT NULL,
        PRIMARY KEY (distributor, epoch)
      );

      CREATE TABLE IF NOT EXISTS proofs (
        distributor       TEXT NOT NULL,
        epoch             INTEGER NOT NULL,
        holder            TEXT NOT NULL,
        cumulative_amount INTEGER NOT NULL,
        proof_json        TEXT NOT NULL,
        PRIMARY KEY (distributor, epoch, holder)
      );

      CREATE TABLE IF NOT EXISTS leader_lock (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        pid           INTEGER NOT NULL,
        hostname      TEXT    NOT NULL,
        acquired_at   INTEGER NOT NULL,
        heartbeat_at  INTEGER NOT NULL
      );
    `);

    // Lightweight additive migrations — all idempotent (check before add).
    const cols = this.db
      .prepare(`PRAGMA table_info(snapshots)`)
      .all() as Array<{ name: string }>;
    const hasCol = (n: string) => cols.some(c => c.name === n);

    // Layer 7 v2 introduced `total_funded_at_event` to track authoritative
    // on-chain `total_funded` per fund event; older DBs may not have it.
    if (!hasCol('total_funded_at_event')) {
      this.db.exec(
        `ALTER TABLE snapshots ADD COLUMN total_funded_at_event INTEGER NOT NULL DEFAULT 0`,
      );
      logger.info('SnapshotStore: added total_funded_at_event column');
    }

    // Layer 8 introduced `StreamConverted` as a distinct fund-event source
    // (D12). We persist `event_kind` to disambiguate snapshot rows for
    // analytics / dashboards and to keep an audit trail of which on-chain ix
    // sourced each per-deposit row. Older snapshots default to
    // `'DistributorFunded'` since that was the only source pre-Layer-8.
    if (!hasCol('event_kind')) {
      this.db.exec(
        `ALTER TABLE snapshots ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'DistributorFunded'`,
      );
      logger.info('SnapshotStore: added event_kind column');
    }
  }

  /** Returns true if a snapshot for this tx_signature already exists (idempotency guard). */
  hasSnapshotForTx(distributor: string, txSignature: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM snapshots WHERE distributor = ? AND tx_signature = ? LIMIT 1')
      .get(distributor, txSignature);
    return row !== undefined;
  }

  /** Returns next deposit_epoch = max(deposit_epoch) + 1 for a distributor, 0 if none. */
  nextEpoch(distributor: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(deposit_epoch), -1) AS max_epoch FROM snapshots WHERE distributor = ?',
      )
      .get(distributor) as { max_epoch: bigint };
    return Number(row.max_epoch) + 1;
  }

  /** Inserts a snapshot + all balances atomically. Idempotent by (distributor, tx_signature). */
  saveSnapshot(snap: Snapshot): void {
    const insertSnap = this.db.prepare(`
      INSERT INTO snapshots
        (distributor, deposit_epoch, deposit_amount, slot, fund_ts,
         tx_signature, total_eligible, total_funded_at_event, event_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBal = this.db.prepare(`
      INSERT INTO snapshot_balances
        (distributor, deposit_epoch, holder, balance, eligible)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((s: Snapshot) => {
      insertSnap.run(
        s.distributor,
        s.depositEpoch,
        s.depositAmount,
        s.slot,
        s.fundTs,
        s.txSignature,
        s.totalEligible,
        s.totalFundedAtEvent,
        s.eventKind,
      );
      for (const b of s.balances) {
        insertBal.run(s.distributor, s.depositEpoch, b.holder, b.balance, b.eligible);
      }
    });
    tx(snap);
  }

  /** Returns all unpublished snapshots for a distributor, oldest first. */
  getUnpublishedSnapshots(distributor: string): Snapshot[] {
    const rows = this.db
      .prepare(
        `SELECT deposit_epoch, deposit_amount, slot, fund_ts, tx_signature,
                total_eligible, total_funded_at_event, event_kind
         FROM snapshots
         WHERE distributor = ? AND published_epoch IS NULL
         ORDER BY deposit_epoch ASC`,
      )
      .all(distributor) as Array<SnapshotRow>;

    return rows.map(r => this.rowToSnapshot(distributor, r));
  }

  /** Returns all snapshots (published + unpublished) for a distributor. */
  getAllSnapshots(distributor: string): Snapshot[] {
    const rows = this.db
      .prepare(
        `SELECT deposit_epoch, deposit_amount, slot, fund_ts, tx_signature,
                total_eligible, total_funded_at_event, event_kind
         FROM snapshots
         WHERE distributor = ?
         ORDER BY deposit_epoch ASC`,
      )
      .all(distributor) as Array<SnapshotRow>;

    return rows.map(r => this.rowToSnapshot(distributor, r));
  }

  private rowToSnapshot(distributor: string, r: SnapshotRow): Snapshot {
    return {
      distributor,
      depositEpoch: Number(r.deposit_epoch),
      depositAmount: r.deposit_amount,
      totalFundedAtEvent: r.total_funded_at_event,
      slot: Number(r.slot),
      fundTs: Number(r.fund_ts),
      txSignature: r.tx_signature,
      totalEligible: r.total_eligible,
      // Defensive: r.event_kind comes from a TEXT column with a DEFAULT of
      // 'DistributorFunded'; the type assertion mirrors the SnapshotEventKind
      // union — anything outside it indicates a corrupted DB.
      eventKind: r.event_kind as SnapshotEventKind,
      balances: this.getBalances(distributor, Number(r.deposit_epoch)),
    };
  }

  private getBalances(distributor: string, depositEpoch: number): HolderBalance[] {
    const rows = this.db
      .prepare(
        `SELECT holder, balance, eligible
         FROM snapshot_balances
         WHERE distributor = ? AND deposit_epoch = ?`,
      )
      .all(distributor, depositEpoch) as Array<{
      holder: string;
      balance: bigint;
      eligible: bigint;
    }>;
    return rows.map(r => ({
      holder: r.holder,
      balance: r.balance,
      eligible: (Number(r.eligible) === 1 ? 1 : 0) as 0 | 1,
    }));
  }

  /** Marks all snapshots with deposit_epoch <= covered as published under publish epoch. */
  markSnapshotsPublished(distributor: string, coveredEpochs: number[], publishEpoch: number): void {
    if (coveredEpochs.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE snapshots SET published_epoch = ?
       WHERE distributor = ? AND deposit_epoch = ? AND published_epoch IS NULL`,
    );
    const tx = this.db.transaction(() => {
      for (const e of coveredEpochs) stmt.run(publishEpoch, distributor, e);
    });
    tx();
  }

  /** Persists a publish record. Idempotent — duplicate tx_signature throws UNIQUE. */
  recordPublish(rec: PublishRecord): void {
    this.db
      .prepare(
        `INSERT INTO publishes
           (distributor, epoch, merkle_root, max_total_claim, tx_signature, published_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.distributor,
        rec.epoch,
        rec.merkleRoot,
        rec.maxTotalClaim,
        rec.txSignature,
        rec.publishedAt,
      );
  }

  /**
   * NEW-M-3 support: true iff a confirmed publish row exists for this
   * (distributor, epoch). Used by `ProofStore.sweepStaleStaging` at bootstrap
   * to distinguish successful publishes from crashed ones.
   */
  isEpochPublished(distributor: string, epoch: number): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM publishes WHERE distributor = ? AND epoch = ? LIMIT 1',
      )
      .get(distributor, epoch);
    return row !== undefined;
  }

  getLastPublish(distributor: string): PublishRecord | null {
    const row = this.db
      .prepare(
        `SELECT epoch, merkle_root, max_total_claim, tx_signature, published_at
         FROM publishes
         WHERE distributor = ?
         ORDER BY epoch DESC
         LIMIT 1`,
      )
      .get(distributor) as
      | {
          epoch: bigint;
          merkle_root: string;
          max_total_claim: bigint;
          tx_signature: string;
          published_at: bigint;
        }
      | undefined;
    if (!row) return null;
    return {
      distributor,
      epoch: Number(row.epoch),
      merkleRoot: row.merkle_root,
      maxTotalClaim: row.max_total_claim,
      txSignature: row.tx_signature,
      publishedAt: Number(row.published_at),
    };
  }

  /** Returns all distinct distributors that have at least one snapshot. */
  getActiveDistributors(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT distributor FROM snapshots')
      .all() as Array<{ distributor: string }>;
    return rows.map(r => r.distributor);
  }

  /**
   * Returns the MAX(slot) across all snapshots, or null if the store is empty.
   * Used at startup to reconcile missed on-chain events since the bot was
   * last running (MED-5 + HIGH-3).
   */
  getMaxSlot(): bigint | null {
    const row = this.db
      .prepare('SELECT MAX(slot) AS max_slot FROM snapshots')
      .get() as { max_slot: bigint | null };
    return row.max_slot ?? null;
  }

  /**
   * Returns up to `limit` most recent tx signatures persisted in `snapshots`.
   * Used at startup to seed the EventWatcher.processed set (L-4) so that
   * reconcile + live subscription do not race on the same signature.
   */
  getAllRecentTxSignatures(limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT tx_signature FROM snapshots
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ tx_signature: string }>;
    return rows.map(r => r.tx_signature);
  }

  // ──────────────────────── Leader lock (M-2) ────────────────────────

  /**
   * Attempts to acquire the singleton leader lock for this publisher process.
   *
   * Semantics:
   *   - Single-row table `leader_lock` (id = 1).
   *   - A lock is considered stale if `heartbeat_at < now - staleSecs`.
   *   - Acquire succeeds iff the row is missing OR stale OR owned by our
   *     current (pid, hostname) tuple.
   *
   * Atomicity (M-R2-1 / NEW-M-1 fix): the SELECT + INSERT/UPDATE are wrapped in
   * a single `BEGIN IMMEDIATE` transaction via better-sqlite3's
   * `transaction(...).immediate()`. SQLite's immediate mode acquires a RESERVED
   * lock up-front, so two concurrent processes serialise on the transaction
   * itself — eliminating the TOCTOU window where both processes could SELECT
   * "no row" and both proceed to INSERT.
   *
   * Returns true on success, false if another live publisher owns the lock.
   * Callers should abort startup on false with a clear operator error.
   */
  tryAcquireLeaderLock(pid: number, hostname: string, staleSecs = 60): boolean {
    const now = Math.floor(Date.now() / 1000);

    const selectStmt = this.db.prepare(
      `SELECT pid, hostname, heartbeat_at FROM leader_lock WHERE id = 1`,
    );
    const upsertStmt = this.db.prepare(
      `INSERT INTO leader_lock (id, pid, hostname, acquired_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pid = excluded.pid,
         hostname = excluded.hostname,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at`,
    );

    const tx = this.db.transaction((): boolean => {
      const existing = selectStmt.get() as
        | { pid: bigint; hostname: string; heartbeat_at: bigint }
        | undefined;

      if (existing) {
        // "Stale" means heartbeat is OLDER than staleSecs seconds.
        // Use strict `<` so staleSecs=0 means "treat any existing lock as stale".
        const alive = now - Number(existing.heartbeat_at) < staleSecs;
        const ownedByUs =
          Number(existing.pid) === pid && existing.hostname === hostname;
        if (alive && !ownedByUs) {
          logger.error(
            'Leader lock held by another live publisher — aborting start',
            null,
            {
              heldByPid: Number(existing.pid),
              heldByHost: existing.hostname,
              heartbeatAt: Number(existing.heartbeat_at),
            },
          );
          return false;
        }
      }

      upsertStmt.run(pid, hostname, now, now);
      return true;
    });

    // .immediate() issues `BEGIN IMMEDIATE` — acquires the write lock before
    // running the function body. Concurrent callers serialise.
    const acquired = tx.immediate();
    if (acquired) {
      logger.info('leader lock acquired', { pid, hostname });
    }
    return acquired;
  }

  /** Refreshes our heartbeat on the leader lock. Must be our pid. */
  heartbeatLeaderLock(pid: number, hostname: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE leader_lock
           SET heartbeat_at = ?
         WHERE id = 1 AND pid = ? AND hostname = ?`,
      )
      .run(now, pid, hostname);
  }

  /** Releases the leader lock — no-op if not owned by us. */
  releaseLeaderLock(pid: number, hostname: string): void {
    this.db
      .prepare(
        `DELETE FROM leader_lock WHERE id = 1 AND pid = ? AND hostname = ?`,
      )
      .run(pid, hostname);
    logger.info('leader lock released', { pid, hostname });
  }

  close(): void {
    this.db.close();
  }
}
