import fs from 'node:fs';

import {
  AlreadyRunningError,
  MultiRpcClient,
  SingleInstanceLock,
  createBotMetrics,
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
  subscribeRevenueDistributed,
} from './crank.js';

/**
 * convert-and-fund-crank entrypoint.
 *
 * The bot reacts to RevenueDistributed events emitted by the OT program (the
 * predecessor crank — revenue-crank — fires distribute_revenue which moves
 * USDC into the per-OT Accumulator ATA). It then builds the per-OT
 * convert_to_rwt TX with ComputeBudget(300_000) per D5.
 *
 * Substep 9 wired in the shared hardening primitives:
 *   - R29: {@link MultiRpcClient} replaces single-RPC `Connection`.
 *   - R30: {@link SingleInstanceLock} guards against duplicate instances.
 *   - R31: {@link reconcileEvents} replays missed events on startup + after
 *     WS reconnects, bounded by the persisted `last_seen_slot`.
 *
 * NOTE: For Layer 8 this entrypoint emits SEND decisions but does not
 * automatically send the full TX yet — the dynamic-account assembly
 * (DistributionConfig.areal_fee_destination, MerkleDistributor.reward_vault,
 * RwtVault.capital_acc / dao_fee_account, master pool vault_a / vault_b)
 * is intentionally left to the operator + Step 10 E2E tooling so we don't
 * introduce a parser drift between Layer 7 and Layer 8 in this PR. See README
 * "Wiring fee_account / vaults" for the explicit env-var handoff path.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  // Phase 21: prom-client metrics surface. BOT_METRICS_PORT is supplied by
  // scripts/lib/start-bots.ts (locked port 9104 for convert-and-fund-crank).
  const metricsPort = parseInt(process.env.BOT_METRICS_PORT ?? '0', 10);
  if (!metricsPort) {
    throw new Error('convert-and-fund-crank: BOT_METRICS_PORT env not set');
  }
  const metrics = createBotMetrics({
    bot: 'convert-and-fund-crank',
    instructions: ['convert_to_rwt'],
    port: metricsPort,
    startedAt: new Date(),
    walletPubkey: cfg.crankKeypair.publicKey.toBase58(),
  });

  logger.info('convert-and-fund-crank starting', {
    network: cfg.network,
    rpcs: cfg.rpcEndpoints.map(e => redactUrl(e.url)),
    crank: cfg.crankKeypair.publicKey.toBase58(),
    ydProgram: cfg.ydProgramId.toBase58(),
    dexProgram: cfg.dexProgramId.toBase58(),
    rwtEngineProgram: cfg.rwtEngineProgramId.toBase58(),
    rwtUsdcPool: cfg.rwtUsdcPool.toBase58(),
    otProjects: cfg.otProjects.length,
    cuLimit: cfg.computeUnitLimit,
    cuPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
    slippageBps: cfg.slippageBps.toString(),
    minConvertUsdc: cfg.minConvertUsdc.toString(),
    intervalSecs: cfg.checkIntervalSecs,
  });

  if (cfg.otProjects.length === 0) {
    logger.warn(
      'OT_PROJECTS is empty — bot will idle. Populate the env var to monitor OTs.',
    );
  }

  if (cfg.computeUnitLimit < 300_000) {
    logger.warn(
      'COMPUTE_UNIT_LIMIT < 300_000: convert_to_rwt may run out of CU on the swap+mint path (D5)',
      { actual: cfg.computeUnitLimit },
    );
  }

  const client = new MultiRpcClient(cfg.rpcEndpoints, {
    commitment: 'confirmed',
    onFallback: endpoint => {
      metrics.rpcFallbackTotal.labels({ endpoint }).inc();
    },
  });

  try {
    const height = await client.withFallback(c => c.getBlockHeight('confirmed'));
    logger.info('RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `convert-and-fund-crank: no RPC reachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lock = new SingleInstanceLock();
  try {
    await lock.acquire({
      lockDir: cfg.lockDir,
      instanceId: 'convert-and-fund-crank',
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      logger.error(
        'convert-and-fund-crank: another instance is already running',
        err,
        { pid: err.pid, startedAt: err.startedAt },
      );
    }
    throw err;
  }

  const conn = client.primary();

  const checkpoint = new CheckpointStore(cfg.dbPath);
  const dedupe = new SingleFlightLock();

  // Phase 21: 60s heartbeat task — refresh wallet SOL gauge + checkpoint
  // file size. Failures silenced (rpc_fallback + alerts catch downstream).
  const metricsHeartbeat = setInterval(() => {
    void (async (): Promise<void> => {
      try {
        const lamports = await client.withFallback(c =>
          c.getBalance(cfg.crankKeypair.publicKey, 'confirmed'),
        );
        metrics.walletSol.set(lamports / 1e9);
      } catch {
        /* surfaces via rpc_fallback */
      }
      try {
        const stat = fs.statSync(cfg.dbPath);
        metrics.sqliteSize.set(stat.size);
      } catch {
        /* db not yet open — ignore */
      }
    })();
  }, 60_000);
  metricsHeartbeat.unref();

  const stopController = new AbortController();

  // R31: catch up on signatures we may have missed across restarts / WS gaps.
  reconcileSinceLastSeen({
    client,
    cfg,
    checkpoint,
    lock: dedupe,
    signal: stopController.signal,
    metrics,
  }).catch(err => {
    logger.error('startup reconcile failed', err);
  });

  const wsSub = subscribeRevenueDistributed({
    conn,
    cfg,
    checkpoint,
    lock: dedupe,
    otProgramId: cfg.otProgramId,
    client,
    metrics,
  });

  let alreadyShuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    stopController.abort();
    clearInterval(metricsHeartbeat);
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
    try {
      await metrics.shutdown();
    } catch (e) {
      logger.error('metrics shutdown failed', e);
    }
    logger.info('shutdown complete');
    process.exit(exitCode);
  };
  installSignalHandlers(shutdown);

  try {
    await runLoop({ conn, cfg, checkpoint, lock: dedupe, signal: stopController.signal, client, metrics });
  } catch (err) {
    logger.error('runLoop crashed', err);
    void shutdown('crash', 1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[fatal] convert-and-fund-crank failed to start:', err);
  process.exit(1);
});
