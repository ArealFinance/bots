/**
 * nexus-manager crank loop.
 *
 * Per Layer 9 architecture §5.1.1:
 *   1. Acquire a single-instance lock (R30 — kept while the process is
 *      running, released on SIGINT / SIGTERM).
 *   2. Every `pollIntervalSec`, run one `runManagerCycle()`:
 *        a. Read the LiquidityNexus singleton via consensus (R29).
 *        b. Read all managed pool states + Nexus's LpPositions for them.
 *        c. Read Nexus-owned ATA balances (USDC + RWT).
 *        d. Pass everything through `decideRebalance`.
 *        e. If the decision is non-noop, build the matching TX, sign with
 *           the Manager keypair, submit via `withFallback`.
 *        f. Persist the action to the checkpoint (idempotency hint).
 *   3. Kill-switch handling: if `decideRebalance` returns `kind=killSwitch`,
 *      the cycle logs a structured warning and returns. The main loop
 *      exits cleanly when the operator-side rotation runbook (DEX
 *      `update_nexus_manager`) is complete.
 *
 * No WS subscription in V1 — the 5-min poll cadence is sufficient given
 * the bot's medium trust level (§5.1.5). A future iteration can plug in
 * `reconcileEvents` from `@areal/bots-shared` for sub-second event
 * reaction.
 */

import { createHash } from 'node:crypto';
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  AlreadyRunningError,
  MultiRpcClient,
  SingleInstanceLock,
  assertCrankBalance,
  logger,
  redactUrl,
  resolveMinLamportsFromEnv,
} from '@areal/bots-shared';

import type { ManagerConfig } from './config.js';
import {
  CheckpointStore,
  type ActionKind,
} from './checkpoint.js';
import {
  decideRebalance,
  type ManagerStrategyConfig,
} from './decision-engine.js';
import {
  deriveDexConfigPda,
  deriveLiquidityNexusPda,
  deriveLpPositionPda,
  fetchTokenAmount,
  readLiquidityNexus,
  readLpPosition,
  readPoolStates,
} from './nexus-state-reader.js';
import {
  buildNexusAddLiquidityTx,
  buildNexusRemoveLiquidityTx,
  buildNexusSwapTx,
} from '@areal/sdk/tx';
import type {
  Decision,
  NexusAccountContext,
  PoolAccountContext,
  PoolStateInfo,
} from './types.js';

const SUBMIT_DEDUPE_COOLDOWN_SEC = 60;

export interface CrankDeps {
  client: MultiRpcClient;
  manager: Keypair;
  cfg: ManagerConfig;
  checkpoint: CheckpointStore;
  /** Resolved at startup — derived from `cfg.dexProgramId` + the Manager pubkey. */
  baseCtx: NexusAccountContext;
}

/**
 * Hash a Decision into a stable `action_id` string. The hash window is
 * `(kind, pool, primary-amount-arg)` — finer-grained than slot, coarser
 * than full-args hash. Two cycles emitting the same decision within
 * `SUBMIT_DEDUPE_COOLDOWN_SEC` collapse to a single submission.
 */
export function actionIdFor(decision: Decision): string | null {
  if (decision.kind === 'noop' || decision.kind === 'killSwitch') return null;
  const h = createHash('sha256');
  h.update(decision.kind);
  h.update(decision.pool.toBase58());
  if (decision.kind === 'swap') {
    h.update(decision.amountIn.toString());
    h.update(decision.aToB ? '1' : '0');
  } else if (decision.kind === 'addLiquidity') {
    h.update(decision.amountA.toString());
    h.update(decision.amountB.toString());
  } else {
    h.update(decision.sharesToBurn.toString());
  }
  return h.digest('hex');
}

/**
 * One full cycle. Returns the (possibly null) `Decision` for telemetry /
 * tests. Errors are caught + logged so the outer loop can continue.
 */
export async function runManagerCycle(deps: CrankDeps): Promise<Decision | null> {
  const { client, manager, cfg, checkpoint, baseCtx } = deps;

  // 1. Read Nexus state (consensus).
  let nexus;
  try {
    nexus = await readLiquidityNexus(client, baseCtx.liquidityNexus);
  } catch (err) {
    logger.error('nexus-manager: readLiquidityNexus failed', err);
    return null;
  }

  // 2. Read managed pool states.
  const poolStates = await readPoolStates(client, cfg.managedPools).catch(err => {
    logger.error('nexus-manager: readPoolStates failed', err);
    return [];
  });

  // 3. For every initialised managed pool, read the Nexus's LpPosition.
  const positions = await Promise.all(
    cfg.managedPools.map(pool => {
      const lpPda = deriveLpPositionPda(cfg.dexProgramId, pool, baseCtx.liquidityNexus);
      return readLpPosition(client, lpPda).catch(err => {
        logger.warn('nexus-manager: readLpPosition failed', {
          pool: pool.toBase58(),
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    }),
  );

  // 4. Read Nexus ATA balances.
  let usdcBal = 0n;
  let rwtBal = 0n;
  try {
    [usdcBal, rwtBal] = await Promise.all([
      client.withFallback(conn => fetchTokenAmount(conn, baseCtx.nexusUsdcAta)),
      client.withFallback(conn => fetchTokenAmount(conn, baseCtx.nexusRwtAta)),
    ]);
  } catch (err) {
    logger.error('nexus-manager: fetchTokenAmount failed', err);
    return null;
  }

  const strategyCfg: ManagerStrategyConfig = {
    minRebalanceUsdc: cfg.minRebalanceUsdc,
    lpTargetRatioBps: cfg.lpTargetRatioBps,
    lpRebalanceTriggerBps: cfg.lpRebalanceTriggerBps,
    maxPoolConcentrationBps: cfg.maxPoolConcentrationBps,
    usdcMint: cfg.usdcMint,
    rwtMint: cfg.rwtMint,
  };

  const decision = decideRebalance({
    nexus,
    positions,
    pools: poolStates,
    balances: { usdc: usdcBal, rwt: rwtBal },
    cfg: strategyCfg,
  });

  // 5. Apply the decision.
  if (decision.kind === 'killSwitch') {
    logger.warn('nexus-manager: kill-switch observed', {
      reason: decision.reason,
      manager: nexus.manager.toBase58(),
      isActive: nexus.isActive,
    });
    return decision;
  }

  if (decision.kind === 'noop') {
    logger.debug('nexus-manager: noop', { reason: decision.reason });
    return decision;
  }

  // Off-chain idempotency hint.
  const actionId = actionIdFor(decision);
  if (actionId && checkpoint.recentAction(actionId, SUBMIT_DEDUPE_COOLDOWN_SEC)) {
    logger.debug('nexus-manager: action recently submitted, skipping', { actionId });
    return decision;
  }

  // 6. Resolve per-pool wiring.
  const poolCtx = resolvePoolCtx({
    cfg,
    baseCtx,
    decision,
    poolStates,
  });
  if (!poolCtx) {
    logger.warn('nexus-manager: pool context missing for decision', {
      kind: decision.kind,
      pool: decision.pool.toBase58(),
    });
    return decision;
  }

  // 7. Build TX.
  const tx = buildTxForDecision(decision, baseCtx, poolCtx);
  if (!tx) return decision;

  // SEND_TX gate (Substep 13). When disabled, log decision and exit.
  if (!cfg.sendTx) {
    logger.info('nexus-manager: decision (SEND_TX=false, skipping submit)', {
      kind: decision.kind,
      pool: decision.pool.toBase58(),
      reason: decision.reason,
      args: decisionArgsForLog(decision),
    });
    if (actionId) {
      checkpoint.record({
        actionId,
        pool: decision.pool.toBase58(),
        kind: decision.kind as ActionKind,
        args: decisionArgsForLog(decision),
        txSignature: null,
        confirmed: false,
      });
    }
    return decision;
  }

  // 7b. R-60 SOL pre-flight. Skip the submit cleanly when the Manager
  //     keypair is too low to pay fees + rent. We surface balance + threshold
  //     so the operator runbook reads obvious; AggregateError (every endpoint
  //     down) propagates from withFallback inside the helper, but we swallow
  //     it here because the submit retry will re-surface a richer error.
  try {
    const minLamports = resolveMinLamportsFromEnv('NEXUS_MANAGER');
    const gate = await assertCrankBalance(client, manager.publicKey, minLamports);
    if (gate.kind === 'skip') {
      logger.warn('nexus-manager: manager wallet low SOL — skipping submit', {
        kind: decision.kind,
        pool: decision.pool.toBase58(),
        balance: gate.balance,
        required: gate.required,
      });
      if (actionId) {
        checkpoint.record({
          actionId,
          pool: decision.pool.toBase58(),
          kind: decision.kind as ActionKind,
          args: decisionArgsForLog(decision),
          txSignature: null,
          confirmed: false,
        });
      }
      return decision;
    }
  } catch {
    // All endpoints failed — let the actual submit raise.
  }

  // 8. Submit via fallback.
  let signature: string | null = null;
  try {
    signature = await client.withFallback(conn =>
      sendAndConfirmTransaction(conn, tx, [manager], {
        commitment: 'confirmed',
        skipPreflight: false,
      }),
    );
    logger.info('nexus-manager: action submitted', {
      kind: decision.kind,
      pool: decision.pool.toBase58(),
      reason: decision.reason,
      signature,
    });
  } catch (err) {
    logger.error('nexus-manager: TX submit failed', err, {
      kind: decision.kind,
      pool: decision.pool.toBase58(),
    });
  }

  if (actionId) {
    checkpoint.record({
      actionId,
      pool: decision.pool.toBase58(),
      kind: decision.kind as ActionKind,
      args: decisionArgsForLog(decision),
      txSignature: signature,
      confirmed: !!signature,
    });
  }

  return decision;
}

/**
 * One full Manager cycle, given a config + client + checkpoint. Used by the
 * Substep 13 E2E harness to drive the bot deterministically without the
 * single-instance lock or poll loop. Returns the decision (or `null` on
 * top-level read failure) for telemetry.
 */
export async function runCycle(args: {
  cfg: ManagerConfig;
  client: MultiRpcClient;
  checkpoint: CheckpointStore;
}): Promise<Decision | null> {
  const { cfg, client, checkpoint } = args;
  const baseCtx = resolveBaseCtx(cfg);
  return runManagerCycle({
    cfg,
    client,
    manager: cfg.managerKeypair,
    checkpoint,
    baseCtx,
  });
}

/**
 * Acquire single-instance lock + run an infinite poll loop until the
 * `signal` aborts. Uses `setTimeout` rather than `setInterval` to avoid
 * runaway concurrency if a cycle exceeds `pollIntervalSec`.
 */
export async function startManager(args: {
  cfg: ManagerConfig;
  client: MultiRpcClient;
  signal: AbortSignal;
}): Promise<void> {
  const { cfg, client, signal } = args;

  const lock = new SingleInstanceLock();
  try {
    await lock.acquire({
      lockDir: cfg.lockDir,
      instanceId: 'nexus-manager',
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      logger.error(
        'nexus-manager: another instance is already running',
        err,
        { pid: err.pid, startedAt: err.startedAt },
      );
      throw err;
    }
    throw err;
  }

  const checkpoint = new CheckpointStore(cfg.checkpointDb);
  const baseCtx = resolveBaseCtx(cfg);

  // Print a redacted RPC summary at startup so operators can verify the
  // bot connected to the configured pool.
  logger.info('nexus-manager started', {
    network: cfg.network,
    manager: cfg.managerKeypair.publicKey.toBase58(),
    pollIntervalSec: cfg.pollIntervalSec,
    managedPools: cfg.managedPools.length,
    rpcs: client.describe().map(e => redactUrl(e.url)),
  });

  try {
    while (!signal.aborted) {
      try {
        await runManagerCycle({
          cfg,
          client,
          manager: cfg.managerKeypair,
          checkpoint,
          baseCtx,
        });
      } catch (err) {
        logger.error('nexus-manager: cycle threw', err);
      }
      if (signal.aborted) break;
      await sleep(cfg.pollIntervalSec * 1000, signal);
    }
  } finally {
    try {
      checkpoint.close();
    } catch (err) {
      logger.warn('nexus-manager: checkpoint close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await lock.release();
  }
}

/**
 * Build the global account context (DEX config + Nexus PDA + manager
 * pubkey + Areal fee account). The Areal fee account is read by reading
 * `dex_config.areal_fee_destination` at startup. For the V1 builder
 * scaffold we accept the fee account as part of `ManagerConfig`'s
 * `usdcMint` companion — leave a TODO that links to the dynamic-reader
 * upgrade path.
 *
 * Until the dynamic reader lands, the dashboard / ops resolves the
 * areal_fee_account once at provisioning time and pins it via env
 * (deferred to Substep 10 dashboard wiring D1 closure).
 */
export function resolveBaseCtx(cfg: ManagerConfig): NexusAccountContext {
  const liquidityNexus = deriveLiquidityNexusPda(cfg.dexProgramId);
  const dexConfig = deriveDexConfigPda(cfg.dexProgramId);
  return {
    dexProgramId: cfg.dexProgramId,
    dexConfig,
    liquidityNexus,
    manager: cfg.managerKeypair.publicKey,
    // V1 placeholder — see TODO above. The crank treats this as opaque
    // and does not fail the cycle when the fee account is the manager
    // itself; production resolves via `readDexConfig` at startup.
    arealFeeAccount: cfg.managerKeypair.publicKey,
    nexusUsdcAta: deriveAssociatedTokenAccount(liquidityNexus, cfg.usdcMint),
    nexusRwtAta: deriveAssociatedTokenAccount(liquidityNexus, cfg.rwtMint),
  };
}

/**
 * Resolve the per-pool context for a non-noop decision. Returns `null`
 * if the pool state isn't loaded yet (e.g. the decision targeted a pool
 * that the multi-account read failed for).
 */
function resolvePoolCtx(args: {
  cfg: ManagerConfig;
  baseCtx: NexusAccountContext;
  decision: Decision;
  poolStates: (PoolStateInfo | null)[];
}): PoolAccountContext | null {
  if (
    args.decision.kind === 'noop' ||
    args.decision.kind === 'killSwitch'
  ) {
    return null;
  }
  const target = args.decision.pool;
  const poolState = args.poolStates.find(p => p && p.pool.equals(target)) ?? null;
  if (!poolState) return null;
  const lpPosition = deriveLpPositionPda(
    args.cfg.dexProgramId,
    poolState.pool,
    args.baseCtx.liquidityNexus,
  );
  return {
    pool: poolState.pool,
    vaultA: poolState.vaultA,
    vaultB: poolState.vaultB,
    lpPosition,
  };
}

function buildTxForDecision(
  decision: Decision,
  baseCtx: NexusAccountContext,
  poolCtx: PoolAccountContext,
): Transaction | null {
  switch (decision.kind) {
    case 'swap':
      return buildNexusSwapTx({
        ctx: baseCtx,
        pool: poolCtx,
        amountIn: decision.amountIn,
        minAmountOut: decision.minAmountOut,
        aToB: decision.aToB,
      });
    case 'addLiquidity':
      return buildNexusAddLiquidityTx({
        ctx: baseCtx,
        pool: poolCtx,
        amountA: decision.amountA,
        amountB: decision.amountB,
        minShares: decision.minShares,
      });
    case 'removeLiquidity':
      return buildNexusRemoveLiquidityTx({
        ctx: baseCtx,
        pool: poolCtx,
        sharesToBurn: decision.sharesToBurn,
      });
    default:
      return null;
  }
}

function decisionArgsForLog(decision: Decision): unknown {
  switch (decision.kind) {
    case 'swap':
      return {
        amountIn: decision.amountIn.toString(),
        minAmountOut: decision.minAmountOut.toString(),
        aToB: decision.aToB,
      };
    case 'addLiquidity':
      return {
        amountA: decision.amountA.toString(),
        amountB: decision.amountB.toString(),
        minShares: decision.minShares.toString(),
      };
    case 'removeLiquidity':
      return { sharesToBurn: decision.sharesToBurn.toString() };
    default:
      return null;
  }
}

/**
 * Derive an Associated Token Account address. We do NOT depend on
 * `@solana/spl-token` to keep the dependency footprint at @solana/web3.js
 * + better-sqlite3 + zod + dotenv — the ATA derivation is a 3-seed
 * `findProgramAddress` so doing it inline is trivial.
 *
 * Seed: `[owner, TOKEN_PROGRAM, mint]` under the ATA program ID.
 */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

function deriveAssociatedTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
