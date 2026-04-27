import {
  AlreadyRunningError,
  MultiRpcClient,
  SingleInstanceLock,
  installSignalHandlers,
  logger,
  redactUrl,
  setLogLevel,
} from '@areal/bots-shared';

import { CheckpointStore } from './checkpoint.js';
import { loadConfig } from './config.js';
import {
  SingleFlightLock,
  reconcileSinceLastSeen,
  runLoop,
  subscribeRevenueEvents,
} from './crank.js';

/**
 * revenue-crank entrypoint.
 *
 * 1. Load config (validates OT program ID, OT project list, crank keypair).
 * 2. Build the {@link MultiRpcClient} (R29 multi-RPC fallback).
 * 3. Acquire single-instance lock (R30) — fail fast if a peer is alive.
 * 4. Open SQLite checkpoint store.
 * 5. Reconcile any signatures missed since the last seen slot (R31).
 * 6. Start WS subscription (D10 — primary trigger).
 * 7. Start poll loop (D10 — fallback trigger).
 * 8. Wait for SIGINT/SIGTERM, then unsubscribe + release lock + close.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('revenue-crank starting', {
    network: cfg.network,
    rpcs: cfg.rpcEndpoints.map(e => redactUrl(e.url)),
    crank: cfg.crankKeypair.publicKey.toBase58(),
    otProgram: cfg.otProgramId.toBase58(),
    otProjects: cfg.otProjects.length,
    intervalSecs: cfg.checkIntervalSecs,
  });

  if (cfg.otProjects.length === 0) {
    logger.warn(
      'OT_PROJECTS is empty — bot will idle. Populate the env var to monitor OTs.',
    );
  }

  const client = new MultiRpcClient(cfg.rpcEndpoints, { commitment: 'confirmed' });

  // RPC sanity check — fail fast on misconfiguration before acquiring the lock.
  try {
    const height = await client.withFallback(c => c.getBlockHeight('confirmed'));
    logger.info('RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `revenue-crank: no RPC reachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lock = new SingleInstanceLock();
  try {
    await lock.acquire({
      lockDir: cfg.lockDir,
      instanceId: 'revenue-crank',
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      logger.error(
        'revenue-crank: another instance is already running',
        err,
        { pid: err.pid, startedAt: err.startedAt },
      );
    }
    throw err;
  }

  // Use the primary connection for the WS subscription + per-tick reads;
  // critical-path failures fall back via `client.withFallback` inside the
  // reconcile helper. Same pattern as nexus-manager (Substep 8).
  const conn = client.primary();

  const checkpoint = new CheckpointStore(cfg.dbPath);
  const dedupe = new SingleFlightLock();

  const stopController = new AbortController();

  // R31: catch up on signatures we may have missed across restarts / WS gaps.
  reconcileSinceLastSeen({
    client,
    cfg,
    checkpoint,
    lock: dedupe,
    signal: stopController.signal,
  }).catch(err => {
    logger.error('startup reconcile failed', err);
  });

  const wsSub = subscribeRevenueEvents({ conn, cfg, checkpoint, lock: dedupe });

  let alreadyShuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    stopController.abort();
    try {
      await wsSub.unsubscribe();
    } catch (e) {
      logger.error('WS unsubscribe failed', e);
    }
    try {
      checkpoint.close();
    } catch (e) {
      logger.error('checkpoint close failed', e);
    }
    try {
      await lock.release();
    } catch (e) {
      logger.error('lock release failed', e);
    }
    logger.info('shutdown complete');
    process.exit(exitCode);
  };
  installSignalHandlers(shutdown);

  // Run-forever loop. `runLoop` returns only when the abort signal fires.
  try {
    await runLoop({ conn, cfg, checkpoint, lock: dedupe, signal: stopController.signal });
  } catch (err) {
    logger.error('runLoop crashed', err);
    void shutdown('crash', 1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[fatal] revenue-crank failed to start:', err);
  process.exit(1);
});
