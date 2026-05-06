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
import { ProofFetcher } from './proof-fetcher.js';
import {
  SingleFlightLock,
  reconcileSinceLastSeen,
  runLoop,
  subscribeRootPublished,
} from './crank.js';

/**
 * yield-claim-crank entrypoint.
 *
 * The bot reacts to RootPublished events from yield-distribution and runs the
 * three claim flows (vault, pool, treasury) for every configured target. The
 * proof source is either a shared filesystem directory written by the
 * merkle-publisher, or an HTTP endpoint exposing the same JSON layout.
 *
 * Layer 9 Substep 9 wired in the shared hardening primitives:
 *   - R29: {@link MultiRpcClient} replaces single-RPC `Connection`.
 *   - R30: {@link SingleInstanceLock} guards against duplicate instances.
 *   - R31: {@link reconcileSinceLastSeen} replays missed RootPublished events
 *     on startup + after WS reconnects, bounded by the persisted
 *     `last_seen_slot`. {@link runClaimCycle} is idempotent — on-chain
 *     `ClaimStatus.cumulative_amount` enforces strict-greater-than, so
 *     re-runs are safe.
 *
 * For Layer 8, dynamic-account assembly (rwt_claim_ata, liquidity_dest, etc.)
 * is intentionally deferred — the bot runs decisions, logs them, and updates
 * checkpoints. The claim ix builders now live in `@areal/sdk/tx`; only the
 * thin bot-local helpers (`proofFileToArgs`, `wrapClaimTx`) remain in
 * `src/claim-builders.ts`. See README "Wiring dynamic accounts" for details.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('yield-claim-crank starting', {
    network: cfg.network,
    rpcs: cfg.rpcEndpoints.map(e => redactUrl(e.url)),
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

  const client = new MultiRpcClient(cfg.rpcEndpoints, { commitment: 'confirmed' });

  try {
    const height = await client.withFallback(c => c.getBlockHeight('confirmed'));
    logger.info('RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `yield-claim-crank: no RPC reachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lock = new SingleInstanceLock();
  try {
    await lock.acquire({
      lockDir: cfg.lockDir,
      instanceId: 'yield-claim-crank',
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      logger.error(
        'yield-claim-crank: another instance is already running',
        err,
        { pid: err.pid, startedAt: err.startedAt },
      );
    }
    throw err;
  }

  const conn = client.primary();

  const checkpoint = new CheckpointStore(cfg.dbPath);
  const fetcher = new ProofFetcher(cfg.proofSource);
  const dedupe = new SingleFlightLock();

  const stopController = new AbortController();

  // R31: catch up on RootPublished signatures we may have missed across
  // restarts / WS gaps. runClaimCycle is idempotent under on-chain
  // ClaimStatus.cumulative_amount, so a duplicate run is a no-op.
  reconcileSinceLastSeen({
    client,
    cfg,
    checkpoint,
    fetcher,
    lock: dedupe,
    signal: stopController.signal,
  }).catch(err => {
    logger.error('startup reconcile failed', err);
  });

  const wsSub = subscribeRootPublished({ conn, cfg, checkpoint, fetcher, lock: dedupe, client });

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

  try {
    await runLoop({
      conn,
      cfg,
      checkpoint,
      fetcher,
      lock: dedupe,
      signal: stopController.signal,
      client,
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
