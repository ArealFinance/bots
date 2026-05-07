/**
 * nexus-manager entrypoint.
 *
 * 1. Load env-driven config (validates DEX program id, mints, RPC tuples,
 *    and the Manager keypair file).
 * 2. Build the {@link MultiRpcClient} with R29 fallback chain.
 * 3. Quick RPC sanity check — fail fast on misconfigured endpoint.
 * 4. Hand off to {@link startManager}, which acquires the single-instance
 *    lock and runs the poll loop until SIGINT / SIGTERM.
 */

import fs from 'node:fs';

import {
  MultiRpcClient,
  createBotMetrics,
  installSignalHandlers,
  logger,
  setLogLevel,
} from '@areal/bots-shared';

import { loadConfig } from './config.js';
import { startManager } from './crank.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  // Phase 21: prom-client metrics surface. BOT_METRICS_PORT is supplied by
  // scripts/lib/start-bots.ts (locked port 9106 for nexus-manager).
  const metricsPort = parseInt(process.env.BOT_METRICS_PORT ?? '0', 10);
  if (!metricsPort) {
    throw new Error('nexus-manager: BOT_METRICS_PORT env not set');
  }
  const metrics = createBotMetrics({
    bot: 'nexus-manager',
    instructions: ['nexus_swap', 'nexus_add_liquidity', 'nexus_remove_liquidity'],
    port: metricsPort,
    startedAt: new Date(),
    walletPubkey: cfg.managerKeypair.publicKey.toBase58(),
  });

  logger.info('nexus-manager booting', {
    network: cfg.network,
    manager: cfg.managerKeypair.publicKey.toBase58(),
    dexProgramId: cfg.dexProgramId.toBase58(),
    managedPools: cfg.managedPools.length,
    pollIntervalSec: cfg.pollIntervalSec,
    metricsPort,
  });

  const client = new MultiRpcClient(cfg.rpcEndpoints, {
    commitment: 'confirmed',
    onFallback: endpoint => {
      metrics.rpcFallbackTotal.labels({ endpoint }).inc();
    },
  });

  // RPC sanity check — fail fast on misconfiguration before acquiring the
  // single-instance lock so a broken deploy doesn't park a lock-file behind
  // a config error.
  try {
    const blockHeight = await client.withFallback(conn => conn.getBlockHeight('confirmed'));
    logger.info('nexus-manager: RPC OK', { blockHeight });
  } catch (err) {
    throw new Error(
      `nexus-manager: no RPC reachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Phase 21: 60s heartbeat — refresh wallet SOL gauge + checkpoint size.
  const metricsHeartbeat = setInterval(() => {
    void (async (): Promise<void> => {
      try {
        const lamports = await client.withFallback(c =>
          c.getBalance(cfg.managerKeypair.publicKey, 'confirmed'),
        );
        metrics.walletSol.set(lamports / 1e9);
      } catch {
        /* surfaces via rpc_fallback */
      }
      try {
        const stat = fs.statSync(cfg.checkpointDb);
        metrics.sqliteSize.set(stat.size);
      } catch {
        /* db not yet open — ignore */
      }
    })();
  }, 60_000);
  metricsHeartbeat.unref();

  const stopController = new AbortController();

  let alreadyShuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    logger.info(`nexus-manager: received ${signal}, shutting down`);
    stopController.abort();
    clearInterval(metricsHeartbeat);
    // Phase 21: best-effort metrics close — fire-and-forget so we don't
    // delay process exit on a slow socket teardown.
    void metrics.shutdown().catch(err => logger.error('metrics shutdown failed', err));
    // The startManager finally-block releases the lock + closes the
    // checkpoint. Give it a brief grace window then exit.
    setTimeout(() => process.exit(exitCode), 200).unref();
  };
  installSignalHandlers(shutdown);

  await startManager({ cfg, client, signal: stopController.signal, metrics });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[fatal] nexus-manager failed to start:', err);
  process.exit(1);
});
