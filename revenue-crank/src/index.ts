import { Connection } from '@solana/web3.js';

import { CheckpointStore } from './checkpoint.js';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { SingleFlightLock, runLoop, subscribeRevenueEvents } from './crank.js';

/**
 * revenue-crank entrypoint.
 *
 * 1. Load config (validates OT program ID, OT project list, crank keypair).
 * 2. Open RPC + WS connection pair.
 * 3. Open SQLite checkpoint store.
 * 4. Start WS subscription (D10 — primary trigger).
 * 5. Start poll loop (D10 — fallback trigger).
 * 6. Wait for SIGINT/SIGTERM, then unsubscribe and close.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('revenue-crank starting', {
    network: cfg.network,
    rpc: cfg.rpcUrl,
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

  const conn = new Connection(cfg.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: cfg.rpcWsUrl,
  });

  // RPC sanity check — fail fast on misconfiguration.
  try {
    const height = await conn.getBlockHeight('confirmed');
    logger.info('RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `RPC unreachable at ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const checkpoint = new CheckpointStore(cfg.dbPath);
  const lock = new SingleFlightLock();

  const stopController = new AbortController();

  const wsSub = subscribeRevenueEvents({ conn, cfg, checkpoint, lock });

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
    logger.info('shutdown complete');
    process.exit(exitCode);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('uncaughtException', (e: unknown) => {
    logger.error('uncaughtException', e);
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (e: unknown) => {
    logger.error('unhandledRejection', e);
    void shutdown('unhandledRejection', 1);
  });

  // Run-forever loop. `runLoop` returns only when the abort signal fires.
  try {
    await runLoop({ conn, cfg, checkpoint, lock, signal: stopController.signal });
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
