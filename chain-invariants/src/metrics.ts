/**
 * Phase 22: chain-invariants metrics surface + HTTP server.
 *
 * NOTE on duplication: the HTTP server boilerplate (~60 LOC) is
 * intentionally duplicated from `bots/shared/src/metrics.ts`
 * (`createBotMetrics`) per Architect Q1 decision. The Phase 21
 * createBotMetrics is TX-bot shaped — `bot_*` prefix, mandatory
 * `instructions` enum, `bot_alive` heartbeat tied to TX ticks. Forcing
 * a read-only watchdog through that shape would produce meaningless
 * `bot_tx_total{instructions="none"}` time series and a `bot_alive`
 * that lies (alive without TXs). When a third HTTP-exposing component
 * appears, extract `createMetricsServer({ extraRoutes })` into a shared
 * module and migrate both consumers. Tracker: Phase 23 follow-up.
 *
 * Cardinality budget (bounded):
 *   distributor × 1, rwt_engine × 1, contract × 5, authority × 5,
 *   check × 4. Total active series across all custom metrics: ~20.
 */

import http from 'node:http';
import {
  Counter,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Logger } from '@areal/bots-shared';

// ---- Public types ---------------------------------------------------------

export interface ChainInvariantsMetrics {
  registry: Registry;

  // Freshness
  merkleRootAgeSeconds: Gauge<'distributor'>;
  navAgeSeconds: Gauge<'rwt_engine'>;

  // Authority drift — value: 1=match, 0=drift, -1=unable_to_fetch
  authorityMatch: Gauge<'contract' | 'authority'>;

  // Supply integrity
  rwtSupplyTracked: Gauge<'rwt_engine'>;
  rwtSupplyMintActual: Gauge<'rwt_engine'>;
  rwtSupplyDriftAbs: Gauge<'rwt_engine'>;

  // Operational
  checkErrorsTotal: Counter<'check'>;
  checkLastSuccessTimestamp: Gauge<'check'>;
  checkDurationSeconds: Gauge<'check'>;

  // Process health (NOT bot_alive — semantically distinct, not tied to TX
  // ticks; set to 1 by the poller after every successful pollOnce).
  exporterAlive: Gauge;
  exporterPollsTotal: Counter;
}

export interface MetricsServerHandle {
  registry: Registry;
  metrics: ChainInvariantsMetrics;
  server: Server;
  close: () => Promise<void>;
}

export type BadgesHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

export interface CreateMetricsServerOpts {
  port: number;
  host?: string;
  logger: Logger;
  badgesHandler: BadgesHandler;
}

// ---- Implementation -------------------------------------------------------

export function createMetrics(): ChainInvariantsMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'chain-invariants' });
  collectDefaultMetrics({ register: registry, prefix: 'chain_invariant_proc_' });

  const merkleRootAgeSeconds = new Gauge({
    name: 'chain_invariant_merkle_root_age_seconds',
    help: 'Seconds since the last on-chain TX touched the YD MerkleDistributor PDA',
    labelNames: ['distributor'] as const,
    registers: [registry],
  });

  const navAgeSeconds = new Gauge({
    name: 'chain_invariant_nav_age_seconds',
    help: 'Seconds since the last on-chain TX touched the RWT vault PDA (any vault TX resets — Phase 22 limitation)',
    labelNames: ['rwt_engine'] as const,
    registers: [registry],
  });

  const authorityMatch = new Gauge({
    name: 'chain_invariant_authority_match',
    help: 'On-chain authority vs expected: 1=match, 0=drift, -1=unable_to_fetch',
    labelNames: ['contract', 'authority'] as const,
    registers: [registry],
  });

  const rwtSupplyTracked = new Gauge({
    name: 'chain_invariant_rwt_supply_tracked',
    help: 'RwtVault.total_rwt_supply (the vault-tracked figure)',
    labelNames: ['rwt_engine'] as const,
    registers: [registry],
  });

  const rwtSupplyMintActual = new Gauge({
    name: 'chain_invariant_rwt_supply_mint_actual',
    help: 'SPL mint .supply for the RWT mint (the on-chain truth)',
    labelNames: ['rwt_engine'] as const,
    registers: [registry],
  });

  const rwtSupplyDriftAbs = new Gauge({
    name: 'chain_invariant_rwt_supply_drift_abs',
    help: '|tracked - mint_actual| — must be 0 in steady state',
    labelNames: ['rwt_engine'] as const,
    registers: [registry],
  });

  const checkErrorsTotal = new Counter({
    name: 'chain_invariant_check_errors_total',
    help: 'Per-check error counter; increments on every ok:false return from a check function',
    labelNames: ['check'] as const,
    registers: [registry],
  });

  const checkLastSuccessTimestamp = new Gauge({
    name: 'chain_invariant_check_last_success_timestamp',
    help: 'Unix seconds of the last successful poll for this check; powers the ChainInvariantsCheckFailing meta-alert',
    labelNames: ['check'] as const,
    registers: [registry],
  });

  const checkDurationSeconds = new Gauge({
    name: 'chain_invariant_check_duration_seconds',
    help: 'Last-poll wall-clock duration for this check (seconds)',
    labelNames: ['check'] as const,
    registers: [registry],
  });

  const exporterAlive = new Gauge({
    name: 'chain_invariant_exporter_alive',
    help: '1 while the poll loop is ticking — set to 1 after every successful pollOnce',
    registers: [registry],
  });

  const exporterPollsTotal = new Counter({
    name: 'chain_invariant_exporter_polls_total',
    help: 'Total pollOnce invocations',
    registers: [registry],
  });

  // Initialise alive=1 so the first scrape after startup is not a flap.
  exporterAlive.set(1);

  return {
    registry,
    merkleRootAgeSeconds,
    navAgeSeconds,
    authorityMatch,
    rwtSupplyTracked,
    rwtSupplyMintActual,
    rwtSupplyDriftAbs,
    checkErrorsTotal,
    checkLastSuccessTimestamp,
    checkDurationSeconds,
    exporterAlive,
    exporterPollsTotal,
  };
}

/**
 * Build the metrics + HTTP server pair. The server binds strictly to
 * 127.0.0.1 by default — public exposure happens through the operator's
 * cloudflared tunnel. Routes:
 *   GET  /metrics                  — prom text scrape
 *   GET  /api/badges/<name>        — shields.io endpoint JSON
 *   GET  /healthz                  — {"ok": true}
 *   any non-GET/HEAD               — 405 Allow: GET, HEAD
 *   anything else                  — 404
 */
export async function createMetricsServer(
  opts: CreateMetricsServerOpts,
): Promise<MetricsServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  // port=0 is valid (OS-assigned, used in tests); reject only negative or
  // above the 16-bit max.
  if (opts.port < 0 || opts.port > 65_535) {
    throw new Error(`createMetricsServer: invalid port ${opts.port}`);
  }
  const metrics = createMetrics();
  const { registry } = metrics;
  const logger = opts.logger;

  const server = http.createServer(async (req, res) => {
    try {
      // Method gate — only GET/HEAD; everything else is 405.
      const method = req.method ?? '';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      const rawUrl = req.url ?? '/';
      // Use a synthetic origin — req.headers.host may be absent on direct
      // socket-level scrapes from prometheus.
      const url = new URL(rawUrl, `http://${req.headers.host ?? host}`);

      if (url.pathname === '/metrics') {
        const body = method === 'HEAD' ? '' : await registry.metrics();
        res.writeHead(200, { 'Content-Type': registry.contentType });
        return res.end(body);
      }

      if (url.pathname.startsWith('/api/badges/')) {
        return await opts.badgesHandler(req, res);
      }

      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      res.writeHead(404);
      return res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('metrics_server_handler_error', err, { url: req.url, msg });
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      } catch {
        // headers may already be sent — best effort
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info('metrics_server_listening', { host, port: opts.port });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { registry, metrics, server, close };
}
