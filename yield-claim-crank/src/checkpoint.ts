import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

/**
 * Checkpoint store for yield-claim-crank (D9).
 *
 * One row per (claim_kind, key) where:
 *   claim_kind ∈ { 'vault', 'pool', 'treasury' }
 *   key        = ot_mint (vault, treasury) or pool_address (pool)
 *
 * The store records the highest epoch we've ever fed into the on-chain ix
 * for that key. The on-chain `ClaimStatus` PDA is the absolute truth — this
 * SQLite row only avoids the network round-trip when we already know the
 * epoch is stale.
 */
export type ClaimKind = 'vault' | 'pool' | 'treasury';

export interface ClaimRow {
  claimKind: ClaimKind;
  key: string;
  lastEpoch: bigint;
  lastSignature: string | null;
  updatedAt: number;
}

export class CheckpointStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.defaultSafeIntegers(true);

    this.migrate();
    logger.info('yield-claim-crank checkpoint store ready', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claim_progress (
        claim_kind     TEXT    NOT NULL,
        key            TEXT    NOT NULL,
        last_epoch     INTEGER NOT NULL DEFAULT 0,
        last_signature TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (claim_kind, key)
      );
    `);
  }

  get(kind: ClaimKind, key: string): ClaimRow | null {
    const row = this.db
      .prepare(
        `SELECT claim_kind, key, last_epoch, last_signature, updated_at
         FROM claim_progress
         WHERE claim_kind = ? AND key = ?`,
      )
      .get(kind, key) as
      | {
          claim_kind: string;
          key: string;
          last_epoch: bigint;
          last_signature: string | null;
          updated_at: bigint;
        }
      | undefined;
    if (!row) return null;
    return {
      claimKind: row.claim_kind as ClaimKind,
      key: row.key,
      lastEpoch: row.last_epoch,
      lastSignature: row.last_signature,
      updatedAt: Number(row.updated_at),
    };
  }

  upsert(kind: ClaimKind, key: string, epoch: bigint, signature: string | null): void {
    const now = BigInt(Math.floor(Date.now() / 1000));
    this.db
      .prepare(
        `INSERT INTO claim_progress (claim_kind, key, last_epoch, last_signature, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(claim_kind, key) DO UPDATE SET
           last_epoch     = excluded.last_epoch,
           last_signature = excluded.last_signature,
           updated_at     = excluded.updated_at`,
      )
      .run(kind, key, epoch, signature, now);
  }

  /** Returns true if the supplied epoch is greater than the stored row's. */
  isNewer(kind: ClaimKind, key: string, epoch: bigint): boolean {
    const row = this.get(kind, key);
    if (!row) return true;
    return epoch > row.lastEpoch;
  }

  close(): void {
    this.db.close();
  }
}
