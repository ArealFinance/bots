import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

/**
 * Per-OT checkpoint for convert-and-fund-crank (D9).
 *
 * Records the slot of the last `convert_to_rwt` we observed/sent. The slot is
 * a hint for restart-time backoff: if the local row is recent, we know we
 * just acted; if stale, we read on-chain Accumulator USDC balance directly
 * and decide afresh.
 */
export interface CheckpointRow {
  otMint: string;
  lastConvertSlot: bigint;
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
    logger.info('convert-and-fund-crank checkpoint store ready', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS convert_checkpoint (
        ot_mint           TEXT    NOT NULL PRIMARY KEY,
        last_convert_slot INTEGER NOT NULL DEFAULT 0,
        last_signature    TEXT,
        updated_at        INTEGER NOT NULL
      );
    `);
  }

  get(otMint: string): CheckpointRow | null {
    const row = this.db
      .prepare(
        `SELECT ot_mint, last_convert_slot, last_signature, updated_at
         FROM convert_checkpoint
         WHERE ot_mint = ?`,
      )
      .get(otMint) as
      | {
          ot_mint: string;
          last_convert_slot: bigint;
          last_signature: string | null;
          updated_at: bigint;
        }
      | undefined;
    if (!row) return null;
    return {
      otMint: row.ot_mint,
      lastConvertSlot: row.last_convert_slot,
      lastSignature: row.last_signature,
      updatedAt: Number(row.updated_at),
    };
  }

  upsert(otMint: string, lastConvertSlot: bigint, lastSignature: string | null): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO convert_checkpoint (ot_mint, last_convert_slot, last_signature, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ot_mint) DO UPDATE SET
           last_convert_slot = excluded.last_convert_slot,
           last_signature    = excluded.last_signature,
           updated_at        = excluded.updated_at`,
      )
      .run(otMint, lastConvertSlot, lastSignature, BigInt(now));
  }

  close(): void {
    this.db.close();
  }
}
