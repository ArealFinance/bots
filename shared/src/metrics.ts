/**
 * Phase 21: prom-client metrics surface for off-chain bots.
 *
 * Design (per architect/PM decisions 1-6):
 * - All metric names prefixed `bot_*`.
 * - Default label `bot=<name>` set via registry.setDefaultLabels (Decision 1).
 * - Multi-env labels (env/cluster/network) come from Prometheus
 *   external_labels on the scrape side — DO NOT add them here.
 * - `result` label is the locked TS literal-union — 5 values, no others
 *   (Decision 2).
 * - `instruction` label is per-bot fixed enum, validated at create time
 *   (Decision 3, cardinality control).
 * - HTTP server binds strictly 127.0.0.1 (Decision 5).
 * - `bot_info` is a one-shot gauge holding the bot's own wallet pubkey.
 *   NO user wallets anywhere (Decision 4).
 *
 * Cardinality budget:
 * - `instruction` label is per-bot fixed enum (1–3 values per bot).
 * - `result` label is 5-value literal union.
 * - `endpoint` label cardinality is bounded by operator's `RPC_URLS` env
 *   (typically ≤5 endpoints; operator policy enforces ≤10).
 * - `provider` label is 4 fixed values (gcp/local/ed25519/ec25519).
 * Total bounded series count per bot: well below 100 across all metrics.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';

import { logger } from './logger.js';

// ---- Public types ---------------------------------------------------------

/** Locked enum — the only legal values for `result` label (Decision 2). */
export type TxResult =
  | 'ok'
  | 'rpc_error'
  | 'sim_error'
  | 'onchain_error'
  | 'timeout';

export const TX_RESULTS: readonly TxResult[] = [
  'ok',
  'rpc_error',
  'sim_error',
  'onchain_error',
  'timeout',
] as const;

/** KMS provider label — instruments the sign sites in merkle-publisher.
 *  Locked taxonomy mirrors merkle-publisher/src/kms-signer.ts:
 *    - 'local' — LocalMockSigner (devnet/testnet only)
 *    - 'aws'   — AwsKmsSigner (ECC_ED25519)
 *    - 'gcp'   — GcpKmsSigner (EC_SIGN_ED25519)
 *  Future providers (Turnkey / Fireblocks / etc.) extend this union. */
export type KmsProvider = 'local' | 'aws' | 'gcp';

export interface CreateBotMetricsOptions {
  /** Bot name — drives `bot=` default label. */
  bot: string;
  /** Per-bot fixed instruction enum (Decision 3). Values become the only
   *  legal `instruction` label values; passing anything else throws. */
  instructions: readonly string[];
  /** TCP port to bind on 127.0.0.1. Caller passes BOT_METRICS_PORT env. */
  port: number;
  /** ISO timestamp of bot start; used by `/healthz` uptime calc. */
  startedAt?: Date;
  /** Optional bot wallet for one-shot `bot_info` (Decision 4). */
  walletPubkey?: string;
}

export interface BotMetrics {
  readonly registry: Registry;
  readonly bot: string;

  // -- Counters ----------------------------------------------------------
  /** Increments once per crank tick attempt (success and failure). */
  readonly tickTotal: Counter<'instruction'>;
  /** Increments once per TX submit, labelled by classified result. */
  readonly txTotal: Counter<'instruction' | 'result'>;
  /** Increments on each RPC failover (one per fallback hop). */
  readonly rpcFallbackTotal: Counter<'endpoint'>;
  /** Increments on each KMS sign call, labelled by provider + result. */
  readonly kmsSignTotal: Counter<'provider' | 'result'>;

  // -- Gauges ------------------------------------------------------------
  /** 1 = bot loop iterated within last heartbeat; 0 = stalled. */
  readonly alive: Gauge;
  /** Unix seconds of last successful crank tick (any instruction). */
  readonly lastProgressTs: Gauge;
  /** Bot wallet SOL balance (lamports / 1e9). */
  readonly walletSol: Gauge;
  /** SQLite checkpoint file size in bytes. */
  readonly sqliteSize: Gauge;
  /** One-shot gauge with bot wallet pubkey as label (value=1). */
  readonly info: Gauge<'wallet' | 'version'>;

  // -- Histograms --------------------------------------------------------
  /** End-to-end TX submit duration (build → sendAndConfirm). */
  readonly txDuration: Histogram<'instruction' | 'result'>;
  /** KMS sign duration (publisher only, but module-level for uniformity). */
  readonly kmsSignDuration: Histogram<'provider'>;

  // -- Helpers -----------------------------------------------------------
  /** Wraps an async TX-submit op. Auto-records counter + histogram + classify. */
  observeTx<T>(
    instruction: string,
    op: () => Promise<T>,
    classify: (err: unknown) => TxResult,
  ): Promise<T>;

  /** Wraps any signing op for KMS instrumentation. */
  observeKmsSign<T>(provider: KmsProvider, op: () => Promise<T>): Promise<T>;

  /** Mark progress after a successful tick (any instruction). */
  markProgress(): void;

  /** Stop the heartbeat loop and close the HTTP server. */
  shutdown(): Promise<void>;
}

// ---- Constants ------------------------------------------------------------

/** Decision 6 — heartbeat interval floor. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Histogram buckets (seconds) — tuned for Solana TX latency (sub-second
 *  build, 1–30s confirmation, 60s timeout edge). */
const TX_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60] as const;

/** KMS-sign latency: GCP usually 50–500ms, local <5ms. */
const KMS_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2] as const;

// ---- Implementation -------------------------------------------------------

export function createBotMetrics(opts: CreateBotMetricsOptions): BotMetrics {
  if (!opts.bot) throw new Error('createBotMetrics: bot name required');
  if (opts.port <= 0 || opts.port > 65_535) {
    throw new Error(`createBotMetrics: invalid port ${opts.port}`);
  }
  if (opts.instructions.length === 0) {
    throw new Error('createBotMetrics: instructions enum must be non-empty');
  }

  const registry = new Registry();
  registry.setDefaultLabels({ bot: opts.bot });

  // Default Node.js process metrics (CPU, RSS, event-loop lag, GC) — useful
  // for distinguishing bot-internal stalls from RPC-side stalls.
  collectDefaultMetrics({ register: registry, prefix: 'bot_' });

  const allowedInstructions = new Set(opts.instructions);
  const checkInstruction = (i: string): void => {
    if (!allowedInstructions.has(i)) {
      throw new Error(
        `metrics: unknown instruction "${i}" for bot ${opts.bot}. ` +
          `Allowed: [${opts.instructions.join(', ')}]`,
      );
    }
  };

  // -- Counters -----------------------------------------------------------
  const tickTotal = new Counter({
    name: 'bot_tick_total',
    help: 'Total crank tick attempts (success + failure)',
    labelNames: ['instruction'] as const,
    registers: [registry],
  });

  const txTotal = new Counter({
    name: 'bot_tx_total',
    help: 'Total TX submits, labelled by instruction and classified result',
    labelNames: ['instruction', 'result'] as const,
    registers: [registry],
  });

  const rpcFallbackTotal = new Counter({
    name: 'bot_rpc_fallback_total',
    help: 'RPC endpoint fallback hops (each failover increments once)',
    labelNames: ['endpoint'] as const,
    registers: [registry],
  });

  const kmsSignTotal = new Counter({
    name: 'bot_kms_sign_total',
    help: 'KMS sign operations, labelled by provider and result',
    labelNames: ['provider', 'result'] as const,
    registers: [registry],
  });

  // -- Gauges -------------------------------------------------------------
  const alive = new Gauge({
    name: 'bot_alive',
    help: '1 if bot heartbeat ticked within the last interval, else 0',
    registers: [registry],
  });

  const lastProgressTs = new Gauge({
    name: 'bot_last_progress_timestamp_seconds',
    help: 'Unix timestamp (seconds) of last successful crank progress',
    registers: [registry],
  });

  const walletSol = new Gauge({
    name: 'bot_wallet_sol',
    help: 'Bot signer SOL balance (lamports / 1e9)',
    registers: [registry],
  });

  const sqliteSize = new Gauge({
    name: 'bot_sqlite_size_bytes',
    help: 'Bot checkpoint SQLite file size in bytes',
    registers: [registry],
  });

  const info = new Gauge({
    name: 'bot_info',
    help: 'One-shot info gauge (value=1) carrying bot wallet + version labels',
    labelNames: ['wallet', 'version'] as const,
    registers: [registry],
  });

  // -- Histograms ---------------------------------------------------------
  const txDuration = new Histogram({
    name: 'bot_tx_duration_seconds',
    help: 'End-to-end TX submit duration (build to confirm)',
    labelNames: ['instruction', 'result'] as const,
    buckets: [...TX_DURATION_BUCKETS],
    registers: [registry],
  });

  const kmsSignDuration = new Histogram({
    name: 'bot_kms_sign_duration_seconds',
    help: 'KMS asymmetric sign duration',
    labelNames: ['provider'] as const,
    buckets: [...KMS_DURATION_BUCKETS],
    registers: [registry],
  });

  // -- One-shot bot_info --------------------------------------------------
  if (opts.walletPubkey) {
    info.set(
      { wallet: opts.walletPubkey, version: process.env.npm_package_version ?? '0.1.0' },
      1,
    );
  }

  // -- Heartbeat ----------------------------------------------------------
  const startedAt = (opts.startedAt ?? new Date()).getTime();
  let lastTickAt = Date.now();

  const heartbeat = setInterval(() => {
    const stale = Date.now() - lastTickAt > HEARTBEAT_INTERVAL_MS * 2;
    alive.set(stale ? 0 : 1);
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive solely for the heartbeat.
  heartbeat.unref();
  // Initialise alive=1 so the first scrape after startup isn't a flap.
  alive.set(1);

  // -- HTTP server (127.0.0.1 only) --------------------------------------
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.url === '/metrics') {
      try {
        const body = await registry.metrics();
        res.statusCode = 200;
        res.setHeader('Content-Type', registry.contentType);
        res.end(body);
      } catch (err) {
        logger.error('metrics scrape failed', err);
        res.statusCode = 500;
        res.end();
      }
      return;
    }
    if (req.url === '/healthz') {
      const uptimeS = Math.floor((Date.now() - startedAt) / 1000);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', bot: opts.bot, uptime_s: uptimeS }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  // SECURITY: bind explicit 127.0.0.1, never 0.0.0.0. Phase 20 prom runs
  // host-network so localhost works directly (Decision 5).
  server.listen(opts.port, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo | null;
    logger.info('metrics http server listening', {
      bot: opts.bot,
      address: addr?.address,
      port: addr?.port,
    });
  });

  // -- Helpers ------------------------------------------------------------
  const observeTx: BotMetrics['observeTx'] = async (instruction, op, classify) => {
    checkInstruction(instruction);
    tickTotal.labels({ instruction } as LabelValues<'instruction'>).inc();
    const stop = txDuration.startTimer({ instruction });
    try {
      const out = await op();
      txTotal.labels({ instruction, result: 'ok' }).inc();
      stop({ result: 'ok' });
      lastTickAt = Date.now();
      lastProgressTs.set(Math.floor(Date.now() / 1000));
      return out;
    } catch (err) {
      const result = classify(err);
      txTotal.labels({ instruction, result }).inc();
      stop({ result });
      throw err;
    }
  };

  const observeKmsSign: BotMetrics['observeKmsSign'] = async (provider, op) => {
    const stop = kmsSignDuration.startTimer({ provider });
    try {
      const out = await op();
      kmsSignTotal.labels({ provider, result: 'ok' }).inc();
      stop();
      return out;
    } catch (err) {
      // KMS errors classify as `rpc_error` (network/auth) — caller may
      // refine further; here we keep the granularity coarse.
      kmsSignTotal.labels({ provider, result: 'rpc_error' }).inc();
      stop();
      throw err;
    }
  };

  const markProgress = (): void => {
    lastTickAt = Date.now();
    lastProgressTs.set(Math.floor(Date.now() / 1000));
    alive.set(1);
  };

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  };

  return {
    registry,
    bot: opts.bot,
    tickTotal,
    txTotal,
    rpcFallbackTotal,
    kmsSignTotal,
    alive,
    lastProgressTs,
    walletSol,
    sqliteSize,
    info,
    txDuration,
    kmsSignDuration,
    observeTx,
    observeKmsSign,
    markProgress,
    shutdown,
  };
}
