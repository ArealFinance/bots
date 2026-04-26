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

import { MultiRpcClient, logger, setLogLevel } from '@areal/bots-shared';

import { loadConfig } from './config.js';
import { startManager } from './crank.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('nexus-manager booting', {
    network: cfg.network,
    manager: cfg.managerKeypair.publicKey.toBase58(),
    dexProgramId: cfg.dexProgramId.toBase58(),
    managedPools: cfg.managedPools.length,
    pollIntervalSec: cfg.pollIntervalSec,
  });

  const client = new MultiRpcClient(cfg.rpcEndpoints, { commitment: 'confirmed' });

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

  const stopController = new AbortController();

  let alreadyShuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    logger.info(`nexus-manager: received ${signal}, shutting down`);
    stopController.abort();
    // The startManager finally-block releases the lock + closes the
    // checkpoint. Give it a brief grace window then exit.
    setTimeout(() => process.exit(exitCode), 200).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('uncaughtException', (e: unknown) => {
    logger.error('uncaughtException', e);
    shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (e: unknown) => {
    logger.error('unhandledRejection', e);
    shutdown('unhandledRejection', 1);
  });

  await startManager({ cfg, client, signal: stopController.signal });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[fatal] nexus-manager failed to start:', err);
  process.exit(1);
});
