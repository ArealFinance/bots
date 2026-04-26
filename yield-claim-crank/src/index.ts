import { Connection } from '@solana/web3.js';

import { CheckpointStore } from './checkpoint.js';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { ProofFetcher } from './proof-fetcher.js';
import { SingleFlightLock, runLoop, subscribeRootPublished } from './crank.js';

/**
 * yield-claim-crank entrypoint.
 *
 * The bot reacts to RootPublished events from yield-distribution and runs the
 * three claim flows (vault, pool, treasury) for every configured target. The
 * proof source is either a shared filesystem directory written by the
 * merkle-publisher, or an HTTP endpoint exposing the same JSON layout.
 *
 * For Layer 8, dynamic-account assembly (rwt_claim_ata, liquidity_dest, etc.)
 * is intentionally deferred — the bot runs decisions, logs them, and updates
 * checkpoints. The claim builders in `src/claim-builders.ts` are exported so
 * dashboards / Step 10 E2E can compose the actual TX. See README "Wiring
 * dynamic accounts" for details.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('yield-claim-crank starting', {
    network: cfg.network,
    rpc: cfg.rpcUrl,
    crank: cfg.crankKeypair.publicKey.toBase58(),
    ydProgram: cfg.ydProgramId.toBase58(),
    rwtEngineProgram: cfg.rwtEngineProgramId.toBase58(),
    dexProgram: cfg.dexProgramId.toBase58(),
    otProgram: cfg.otProgramId.toBase58(),
    otProjects: cfg.otProjects.length,
    otRwtPools: cfg.otRwtPools.length,
    arlOtMint: cfg.arlOtMint.toBase58(),
    proofSource: cfg.proofSource.kind,
    intervalSecs: cfg.claimIntervalSecs,
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
  try {
    const height = await conn.getBlockHeight('confirmed');
    logger.info('RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `RPC unreachable at ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const checkpoint = new CheckpointStore(cfg.dbPath);
  const fetcher = new ProofFetcher(cfg.proofSource);
  const lock = new SingleFlightLock();

  const stopController = new AbortController();
  const wsSub = subscribeRootPublished({ conn, cfg, checkpoint, fetcher, lock });

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

  try {
    await runLoop({
      conn,
      cfg,
      checkpoint,
      fetcher,
      lock,
      signal: stopController.signal,
    });
  } catch (err) {
    logger.error('runLoop crashed', err);
    void shutdown('crash', 1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[fatal] yield-claim-crank failed to start:', err);
  process.exit(1);
});
