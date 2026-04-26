import { Connection } from '@solana/web3.js';

import { CheckpointStore } from './checkpoint.js';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { SingleFlightLock, runLoop, subscribeRevenueDistributed } from './crank.js';

/**
 * convert-and-fund-crank entrypoint.
 *
 * The bot reacts to RevenueDistributed events emitted by the OT program (the
 * predecessor crank — revenue-crank — fires distribute_revenue which moves
 * USDC into the per-OT Accumulator ATA). It then builds the per-OT
 * convert_to_rwt TX with ComputeBudget(300_000) per D5.
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

  logger.info('convert-and-fund-crank starting', {
    network: cfg.network,
    rpc: cfg.rpcUrl,
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
  const lock = new SingleFlightLock();

  const stopController = new AbortController();

  const wsSub = subscribeRevenueDistributed({
    conn,
    cfg,
    checkpoint,
    lock,
    otProgramId: cfg.otProgramId,
  });

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
    await runLoop({ conn, cfg, checkpoint, lock, signal: stopController.signal });
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
