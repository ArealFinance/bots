/**
 * SQLite checkpoint store for the nexus-manager bot.
 *
 * Schema (per Layer 9 architecture §5.1.3):
 *   action_id    SHA-256 over (kind, pool, args, slot_window) — primary key.
 *                Used as a hint-cache to dedupe quick re-emissions of the
 *                same action across consecutive WS+poll cycles. The on-chain
 *                ix's own access-control + invariant checks are the trust
 *                anchor — this table is purely an off-chain optimisation.
 *   pool         base58 PoolState pubkey, indexed for per-pool lookups.
 *   kind         'swap' | 'addLiquidity' | 'removeLiquidity'.
 *   args         JSON-encoded args snapshot (debugging / replay only).
 *   ts           Unix seconds when the row was inserted.
 *   tx_signature signature of the submitted TX (null = action recorded but
 *                submission failed).
 *   confirmed    0/1 — set to 1 once the TX is observed in `confirmed`
 *                commitment by the crank loop.
 *
 * Idempotency depth (D9 / D10 pattern from Layer 8):
 *   1. Off-chain dedupe — `recentAction()` skips re-emissions for an
 *      identical `action_id` within the configurable cooldown.
 *   2. On-chain re-check — every Nexus ix re-validates state and reverts
 *      with a typed error if the chain has moved past the action's premise.
 *
 * Cleanup: rows older than `retentionSec` are pruned at every `record()`
 * call. The per-pool index keeps prune cost amortised low.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '@areal/bots-shared';

export type ActionKind = 'swap' | 'addLiquidity' | 'removeLiquidity';

export interface CheckpointRow {
  actionId: string;
  pool: string;
  kind: ActionKind;
  args: string;
  ts: number;
  txSignature: string | null;
  confirmed: boolean;
}

const DEFAULT_RETENTION_SECS = 7 * 24 * 60 * 60; // 7 days

export class CheckpointStore {
  private readonly db: Database.Database;
  private readonly retentionSecs: number;

  constructor(dbPath: string, retentionSecs: number = DEFAULT_RETENTION_SECS) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.retentionSecs = retentionSecs;

    this.migrate();
    logger.info('nexus-manager checkpoint store ready', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nexus_actions (
        action_id    TEXT    NOT NULL PRIMARY KEY,
        pool         TEXT    NOT NULL,
        kind         TEXT    NOT NULL,
        args         TEXT    NOT NULL,
        ts           INTEGER NOT NULL,
        tx_signature TEXT,
        confirmed    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_nexus_actions_pool_kind_ts
        ON nexus_actions (pool, kind, ts DESC);
    `);
  }

  /**
   * Returns the most recent action row for a given `(pool, kind)` pair, or
   * `null` if none exists. Used by the cooldown check in `runManagerCycle`.
   */
  latestForPoolKind(pool: string, kind: ActionKind): CheckpointRow | null {
    const row = this.db
      .prepare(
        `SELECT action_id, pool, kind, args, ts, tx_signature, confirmed
         FROM nexus_actions
         WHERE pool = ? AND kind = ?
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get(pool, kind) as
      | {
          action_id: string;
          pool: string;
          kind: ActionKind;
          args: string;
          ts: number;
          tx_signature: string | null;
          confirmed: number;
        }
      | undefined;
    if (!row) return null;
    return {
      actionId: row.action_id,
      pool: row.pool,
      kind: row.kind,
      args: row.args,
      ts: row.ts,
      txSignature: row.tx_signature,
      confirmed: row.confirmed !== 0,
    };
  }

  /**
   * Insert or update a row. Caller passes the `txSignature` once available;
   * `confirmed=true` after `getSignatureStatuses` reports success.
   */
  record(args: {
    actionId: string;
    pool: string;
    kind: ActionKind;
    args: unknown;
    txSignature: string | null;
    confirmed: boolean;
    nowSecs?: number;
  }): void {
    const now = args.nowSecs ?? Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO nexus_actions (action_id, pool, kind, args, ts, tx_signature, confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET
           tx_signature = excluded.tx_signature,
           confirmed    = excluded.confirmed,
           ts           = excluded.ts`,
      )
      .run(
        args.actionId,
        args.pool,
        args.kind,
        JSON.stringify(args.args ?? null),
        now,
        args.txSignature,
        args.confirmed ? 1 : 0,
      );
    this.prune(now);
  }

  /**
   * Returns `true` if a row matching `actionId` was inserted within the last
   * `cooldownSec` seconds — used by the crank to skip re-emitting the same
   * action across a WS event + poll tick collision.
   */
  recentAction(actionId: string, cooldownSec: number, nowSecs?: number): boolean {
    const now = nowSecs ?? Math.floor(Date.now() / 1000);
    const cutoff = now - cooldownSec;
    const row = this.db
      .prepare(
        `SELECT ts FROM nexus_actions WHERE action_id = ? AND ts >= ?`,
      )
      .get(actionId, cutoff) as { ts: number } | undefined;
    return !!row;
  }

  private prune(nowSecs: number): void {
    const cutoff = nowSecs - this.retentionSecs;
    this.db.prepare(`DELETE FROM nexus_actions WHERE ts < ?`).run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
