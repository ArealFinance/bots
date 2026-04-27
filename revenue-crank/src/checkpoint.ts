import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@areal/bots-shared';

/**
 * SQLite checkpoint store for the revenue crank (D9).
 *
 * Schema:
 *   ot_mint               base58 OT mint — primary key
 *   last_distribution_ts  Unix seconds of the last successful distribute_revenue
 *                         this bot observed for that OT (mirrors the on-chain
 *                         RevenueAccount.last_distribution_ts)
 *   last_signature        signature of the TX that we sent (or observed)
 *   updated_at            Unix seconds when the row was last touched
 *
 * The store is a hint-cache only: every loop tick re-reads the on-chain
 * RevenueAccount before deciding whether to act. The on-chain ix has its own
 * cooldown enforcement (`DistributionCooldown`) so even if our local hint is
 * stale, no double-distribute can occur.
 */
export interface CheckpointRow {
  otMint: string;
  lastDistributionTs: number;
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

    this.migrate();
    logger.info('revenue-crank checkpoint store ready', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revenue_checkpoint (
        ot_mint              TEXT    NOT NULL PRIMARY KEY,
        last_distribution_ts INTEGER NOT NULL DEFAULT 0,
        last_signature       TEXT,
        updated_at           INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revenue_reconcile_state (
        program_id      TEXT NOT NULL PRIMARY KEY,
        last_seen_slot  INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );
    `);
  }

  /**
   * Highest slot we've already dispatched events for via WS or reconcile.
   * Used by R31 `reconcileEvents()` to bound the catch-up scan on startup +
   * after WS reconnects. Returns `null` if the bot has never reconciled.
   */
  getLastSeenSlot(programId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT last_seen_slot FROM revenue_reconcile_state WHERE program_id = ?`,
      )
      .get(programId) as { last_seen_slot: number } | undefined;
    return row ? row.last_seen_slot : null;
  }

  /** Persist the highest slot dispatched for a given programId. */
  setLastSeenSlot(programId: string, slot: number): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO revenue_reconcile_state (program_id, last_seen_slot, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET
           last_seen_slot = MAX(excluded.last_seen_slot, revenue_reconcile_state.last_seen_slot),
           updated_at     = excluded.updated_at`,
      )
      .run(programId, slot, now);
  }

  get(otMint: string): CheckpointRow | null {
    const row = this.db
      .prepare(
        `SELECT ot_mint, last_distribution_ts, last_signature, updated_at
         FROM revenue_checkpoint
         WHERE ot_mint = ?`,
      )
      .get(otMint) as
      | {
          ot_mint: string;
          last_distribution_ts: number;
          last_signature: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      otMint: row.ot_mint,
      lastDistributionTs: row.last_distribution_ts,
      lastSignature: row.last_signature,
      updatedAt: row.updated_at,
    };
  }

  upsert(otMint: string, lastDistributionTs: number, lastSignature: string | null): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO revenue_checkpoint (ot_mint, last_distribution_ts, last_signature, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ot_mint) DO UPDATE SET
           last_distribution_ts = excluded.last_distribution_ts,
           last_signature       = excluded.last_signature,
           updated_at           = excluded.updated_at`,
      )
      .run(otMint, lastDistributionTs, lastSignature, now);
  }

  close(): void {
    this.db.close();
  }
}
