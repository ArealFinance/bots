import { Connection, PublicKey } from '@solana/web3.js';

import {
  type BotMetrics,
  MultiRpcClient,
  assertCrankBalance,
  classifyError,
  logger,
  reconcileEvents,
  resolveMinLamportsFromEnv,
} from '@areal/bots-shared';

import type { BotConfig } from './config.js';
import type { CheckpointStore } from './checkpoint.js';
import type { ConvertContext, ConvertDecision } from './types.js';
import { findAssociatedTokenAddressPda } from '@areal/sdk/pda';
import {
  deriveAccumulatorPda,
  deriveDexConfigPda,
  deriveDistConfigPda,
  deriveDistributorPda,
  deriveRwtVaultPda,
  fetchDexArealFeeDestination,
  fetchDistributorRewardVault,
  fetchNav,
  fetchPoolAccountList,
  fetchPoolSnapshot,
  fetchRwtVaultAccounts,
  fetchTokenAmount,
  fetchYdArealFeeDestination,
  resolveUsdcSide,
} from './readers.js';
import { chooseRoute } from './slippage.js';
import { sendConvertToRwt } from './convert.js';

/**
 * Single-flight lock per OT — same shape as revenue-crank's. WS callback and
 * poll tick that target the same OT must not both fire convert_to_rwt.
 */
export class SingleFlightLock {
  private inflight = new Set<string>();
  acquire(key: string): boolean {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }
  release(key: string): void {
    this.inflight.delete(key);
  }
  has(key: string): boolean {
    return this.inflight.has(key);
  }
}

/**
 * Decide whether to fire convert_to_rwt this tick. Pure function, exposed
 * for unit tests.
 */
export function decideConvert(
  ctx: ConvertContext,
  cfg: { usdcMint: PublicKey; minConvertUsdc: bigint; slippageBps: bigint },
): ConvertDecision {
  if (ctx.accumulatorUsdcBalance === 0n) {
    return { kind: 'skip', reason: 'zero_balance' };
  }
  if (ctx.accumulatorUsdcBalance < cfg.minConvertUsdc) {
    return {
      kind: 'skip',
      reason: 'below_min',
      details: {
        balance: ctx.accumulatorUsdcBalance.toString(),
        min: cfg.minConvertUsdc.toString(),
      },
    };
  }
  if (!ctx.pool && (ctx.navBookValue === 0n || !ctx.navBookValue)) {
    // No pool AND no NAV — can't price; bail.
    return { kind: 'skip', reason: 'no_pool_no_nav' };
  }

  const { swapFirst, expectedRwt, minRwtOut } = chooseRoute({
    usdcAmount: ctx.accumulatorUsdcBalance,
    pool: ctx.pool,
    usdcMint: cfg.usdcMint,
    nav: ctx.navBookValue,
    slippageBps: cfg.slippageBps,
  });
  if (expectedRwt === 0n) {
    return { kind: 'skip', reason: 'no_pool_no_nav' };
  }
  // Sec M-1 — min_rwt_out = 0 is a sandwich-attack surface (any output
  // accepted). Only happens when slippageBps is pathologically large or
  // amounts round to zero through the swap-fee path. Same defensive guard
  // as Substep 11 dashboard sec M-1.
  if (minRwtOut === 0n) {
    return { kind: 'skip', reason: 'zero_min_out' };
  }
  return {
    kind: 'send',
    usdcAmount: ctx.accumulatorUsdcBalance,
    minRwtOut,
    swapFirst,
    expectedRwt,
  };
}

/**
 * Read everything we need to make a decision for one OT. Pure RPC reads —
 * no chain mutation here.
 */
export async function readConvertContext(args: {
  conn: Connection;
  cfg: BotConfig;
  otMint: PublicKey;
}): Promise<ConvertContext | { kind: 'rpc_error'; err: unknown }> {
  const { conn, cfg, otMint } = args;
  const accumulator = deriveAccumulatorPda(otMint, cfg.ydProgramId);
  const rwtVault = deriveRwtVaultPda(cfg.rwtEngineProgramId);

  // Accumulator USDC ATA — Associated Token Account: derive on the fly.
  // The on-chain ix accepts whichever ATA the caller passes (validated against
  // the Accumulator PDA owner + USDC mint), so we use the canonical ATA.
  const accumulatorUsdcAta = await getAssociatedTokenAddress(cfg.usdcMint, accumulator);

  try {
    const [balance, nav, pool] = await Promise.all([
      fetchTokenAmount(conn, accumulatorUsdcAta),
      fetchNav(conn, rwtVault),
      fetchPoolSnapshot(conn, cfg.rwtUsdcPool),
    ]);
    return {
      accumulatorUsdcBalance: balance,
      navBookValue: nav ?? 0n,
      pool,
    };
  } catch (err) {
    return { kind: 'rpc_error', err };
  }
}

/**
 * Resolve the Associated Token Account for `(owner, mint)`. Async-typed for
 * historical caller compatibility — the SDK's PDA derivation is synchronous.
 */
export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  return findAssociatedTokenAddressPda(owner, mint)[0];
}

/**
 * Process one OT: read context, decide, send TX, update checkpoint.
 *
 * Idempotency (D9):
 *   - On-chain `convert_to_rwt` is itself idempotent for `usdc_amount=0` (it
 *     no-ops) — see `convert_to_rwt::handler` step 4 (`if usdc_balance_before
 *     == 0 return Ok(())`). We never enter that path because we skip on
 *     `zero_balance`.
 *   - Local checkpoint records last seen slot/signature. On crash before
 *     update, the next tick re-reads the Accumulator ATA balance and finds
 *     it drained by the prior TX (or not, if the prior TX failed).
 */
export async function processOt(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  otMint: PublicKey;
  client?: MultiRpcClient;
  metrics?: BotMetrics;
}): Promise<ConvertDecision> {
  const { conn, cfg, checkpoint, otMint, client, metrics } = args;

  const ctxOrErr = await readConvertContext({ conn, cfg, otMint });
  if ('kind' in ctxOrErr && ctxOrErr.kind === 'rpc_error') {
    logger.error('convert: rpc fetch failed', ctxOrErr.err, { ot: otMint.toBase58() });
    return { kind: 'skip', reason: 'rpc_error' };
  }

  const ctx = ctxOrErr as ConvertContext;
  const decision = decideConvert(ctx, {
    usdcMint: cfg.usdcMint,
    minConvertUsdc: cfg.minConvertUsdc,
    slippageBps: cfg.slippageBps,
  });

  if (decision.kind === 'skip') {
    logger.debug('skip convert_to_rwt', {
      ot: otMint.toBase58(),
      reason: decision.reason,
      details: decision.details,
    });
    return decision;
  }

  const distributor = deriveDistributorPda(otMint, cfg.ydProgramId);
  const accumulator = deriveAccumulatorPda(otMint, cfg.ydProgramId);
  const ydConfigPda = deriveDistConfigPda(cfg.ydProgramId);
  const rwtVaultPda = deriveRwtVaultPda(cfg.rwtEngineProgramId);
  const dexConfigPda = deriveDexConfigPda(cfg.dexProgramId);

  // SEND_TX gate (Substep 13). When disabled, surface decision and return.
  if (!cfg.sendTx) {
    logger.info('convert decision = SEND (SEND_TX=false, skipping submit)', {
      ot: otMint.toBase58(),
      distributor: distributor.toBase58(),
      usdcAmount: decision.usdcAmount.toString(),
      minRwtOut: decision.minRwtOut.toString(),
      swapFirst: decision.swapFirst,
    });
    const slot = BigInt(await conn.getSlot('confirmed'));
    checkpoint.upsert(otMint.toBase58(), slot, null);
    return decision;
  }

  // Resolve dynamic on-chain accounts needed for full TX assembly.
  // We read everything in parallel from `conn` (consensus is overkill —
  // these structs are static once initialized; routine reads).
  let rewardVault: PublicKey | null;
  let ydArealFeeDest: PublicKey | null;
  let rwtVaultAccs: Awaited<ReturnType<typeof fetchRwtVaultAccounts>>;
  let dexArealFeeDest: PublicKey | null;
  let poolAccs: Awaited<ReturnType<typeof fetchPoolAccountList>>;
  try {
    [rewardVault, ydArealFeeDest, rwtVaultAccs, dexArealFeeDest, poolAccs] = await Promise.all([
      fetchDistributorRewardVault(conn, distributor),
      fetchYdArealFeeDestination(conn, ydConfigPda),
      fetchRwtVaultAccounts(conn, rwtVaultPda),
      fetchDexArealFeeDestination(conn, dexConfigPda),
      fetchPoolAccountList(conn, cfg.rwtUsdcPool),
    ]);
  } catch (err) {
    logger.error('convert: account-list fetch failed', err, { ot: otMint.toBase58() });
    return { kind: 'skip', reason: 'submit_failed' };
  }

  if (!rewardVault || !ydArealFeeDest || !rwtVaultAccs || !dexArealFeeDest || !poolAccs) {
    logger.warn('convert: account-list incomplete, skipping submit', {
      ot: otMint.toBase58(),
      hasRewardVault: !!rewardVault,
      hasYdFeeDest: !!ydArealFeeDest,
      hasRwtVaultAccs: !!rwtVaultAccs,
      hasDexFeeDest: !!dexArealFeeDest,
      hasPoolAccs: !!poolAccs,
    });
    return { kind: 'skip', reason: 'account_list_incomplete' };
  }

  if (!ctx.pool) {
    logger.warn('convert: pool snapshot missing, skipping submit', {
      ot: otMint.toBase58(),
    });
    return { kind: 'skip', reason: 'pool_missing' };
  }

  // Resolve which side of the pool is USDC (vault_in for swap_first=true).
  const usdcSide = resolveUsdcSide(ctx.pool, poolAccs.vaultA, poolAccs.vaultB, cfg.usdcMint);
  if (!usdcSide) {
    logger.error('convert: pool does not contain USDC mint', undefined, {
      ot: otMint.toBase58(),
      pool: cfg.rwtUsdcPool.toBase58(),
    });
    return { kind: 'skip', reason: 'pool_missing' };
  }

  const accumulatorUsdcAta = await getAssociatedTokenAddress(cfg.usdcMint, accumulator);
  const accumulatorRwtAta = await getAssociatedTokenAddress(cfg.rwtMint, accumulator);

  // Pre-flight balance check on the crank wallet (D9 — fail before submit if
  // we won't be able to pay fees / rent). R-60: route through the shared
  // assertCrankBalance helper so the gate, threshold, and env override are
  // identical across all cranks. We still swallow AggregateError (every
  // endpoint failed) — sending will surface a richer error from RPC, and the
  // outer cycle handler will retry on the next tick.
  if (client) {
    const minLamports = resolveMinLamportsFromEnv('CONVERT');
    try {
      const gate = await assertCrankBalance(client, cfg.crankKeypair.publicKey, minLamports);
      if (gate.kind === 'skip') {
        logger.warn('convert: crank wallet low SOL — skipping submit', {
          ot: otMint.toBase58(),
          balance: gate.balance,
          required: gate.required,
        });
        return { kind: 'skip', reason: 'low_sol' };
      }
    } catch {
      // All RPC endpoints failed — let the submit path fail loudly instead.
    }
  } else {
    // No multi-RPC client (unit tests): fall back to a direct check.
    try {
      const lamports = await conn.getBalance(cfg.crankKeypair.publicKey, 'confirmed');
      // Sec M-1 (Substep 14 follow-up): NaN/Infinity guard — a misbehaving
      // RPC returning non-finite lamports would fail-OPEN under `<` alone.
      if (!Number.isFinite(lamports) || lamports < 5_000_000) {
        logger.warn('convert: crank wallet low SOL — skipping submit', {
          ot: otMint.toBase58(),
          lamports: Number.isFinite(lamports) ? lamports : 0,
        });
        return { kind: 'skip', reason: 'low_sol' };
      }
    } catch {
      // Best-effort.
    }
  }

  // Sec H-1: re-fetch pool reserves at submit time to defend against the
  // sandwich-attack window between decide (line 117) and submit. Without a
  // fresh snapshot, `chooseRoute` would assert the same minRwtOut against
  // the stale reserves — a no-op tautology. Wrapping the read in
  // client.withFallback keeps the same R29 fallback policy as the submit.
  let freshPool = ctx.pool;
  try {
    const refetched = client
      ? await client.withFallback(c => fetchPoolSnapshot(c, cfg.rwtUsdcPool))
      : await fetchPoolSnapshot(conn, cfg.rwtUsdcPool);
    if (refetched) {
      freshPool = refetched;
    } else {
      logger.warn('convert: pool refetch returned null, falling back to stale snapshot', {
        ot: otMint.toBase58(),
      });
    }
  } catch (err) {
    logger.warn('convert: pool refetch failed, falling back to stale snapshot', {
      ot: otMint.toBase58(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const recheck = chooseRoute({
    usdcAmount: ctx.accumulatorUsdcBalance,
    pool: freshPool,
    usdcMint: cfg.usdcMint,
    nav: ctx.navBookValue,
    slippageBps: cfg.slippageBps,
  });
  // Drift threshold: 2× declared slippage. Tighter than min-only check;
  // catches the case where reserves moved unfavorably but the recheck's
  // minRwtOut is still nominally >= decision.minRwtOut.
  const driftBps =
    decision.minRwtOut > 0n
      ? ((decision.minRwtOut - recheck.minRwtOut) * 10_000n) / decision.minRwtOut
      : 0n;
  if (
    recheck.swapFirst !== decision.swapFirst ||
    recheck.minRwtOut < decision.minRwtOut ||
    driftBps > cfg.slippageBps * 2n
  ) {
    logger.warn('convert: route drifted between decide and submit, retrying next tick', {
      ot: otMint.toBase58(),
      decideMin: decision.minRwtOut.toString(),
      recheckMin: recheck.minRwtOut.toString(),
      driftBps: driftBps.toString(),
    });
    return { kind: 'skip', reason: 'slippage_drift' };
  }

  // Build + submit. Wrap in withFallback when a multi-RPC client is wired.
  try {
    const submit = (c: Connection): Promise<{ signature: string }> =>
      sendConvertToRwt(c, cfg.crankKeypair, {
        ydProgramId: cfg.ydProgramId,
        dexProgramId: cfg.dexProgramId,
        rwtEngineProgramId: cfg.rwtEngineProgramId,
        crank: cfg.crankKeypair.publicKey,
        otMint,
        accumulatorUsdcAta,
        accumulatorRwtAta,
        feeAccount: ydArealFeeDest!,
        rewardVault: rewardVault!,
        rwtMint: cfg.rwtMint,
        dexConfig: dexConfigPda,
        poolState: cfg.rwtUsdcPool,
        dexPoolVaultIn: usdcSide.poolUsdcVault,
        dexPoolVaultOut: usdcSide.poolRwtVault,
        dexArealFeeAccount: dexArealFeeDest!,
        rwtCapitalAcc: rwtVaultAccs!.capitalAccumulatorAta,
        rwtDaoFeeAccount: rwtVaultAccs!.arealFeeDestination,
        usdcAmount: decision.usdcAmount,
        minRwtOut: decision.minRwtOut,
        swapFirst: decision.swapFirst,
        computeUnitLimit: cfg.computeUnitLimit,
        computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
      }).then(({ signature }) => ({ signature }));

    // Phase 21: when metrics is wired, observe the submit so each TX is
    // recorded in bot_tx_total + bot_tx_duration_seconds with the
    // classified `result` label and on-success drives markProgress().
    const submitWithFallback = (): Promise<{ signature: string }> =>
      client ? client.withFallback(submit) : submit(conn);
    const { signature } = metrics
      ? await metrics.observeTx('convert_to_rwt', submitWithFallback, classifyError)
      : await submitWithFallback();

    logger.info('convert_to_rwt OK', {
      ot: otMint.toBase58(),
      sig: signature,
      usdcAmount: decision.usdcAmount.toString(),
      swapFirst: decision.swapFirst,
    });
    const slot = BigInt(await conn.getSlot('confirmed'));
    checkpoint.upsert(otMint.toBase58(), slot, signature);
    return decision;
  } catch (err) {
    // Sec M-4 — distinguish on-chain reverts (handler said no) from RPC
    // transport failures (endpoint dropped). Anchor / Solana surfaces the
    // former as `SendTransactionError` carrying a `Custom(N)` instruction
    // error in the logs string. Either way the checkpoint is NOT advanced
    // (idempotent retry); the split is for incident-triage signal.
    const message = err instanceof Error ? err.message : String(err);
    const isOnChainRevert =
      /custom program error|InstructionError|Transaction simulation failed/i.test(message);
    if (isOnChainRevert) {
      logger.warn('convert_to_rwt reverted on-chain', {
        ot: otMint.toBase58(),
        message,
      });
      return { kind: 'skip', reason: 'on_chain_revert', details: { message } };
    }
    logger.error('convert_to_rwt submit failed', err, {
      ot: otMint.toBase58(),
      message,
    });
    return { kind: 'skip', reason: 'submit_failed', details: { message } };
  }
}

/**
 * One full sweep through every configured OT. Exposed for E2E harness usage.
 */
export async function runOnce(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  client?: MultiRpcClient;
  metrics?: BotMetrics;
}): Promise<ConvertDecision[]> {
  const { conn, cfg, checkpoint, lock, client, metrics } = args;
  const out: ConvertDecision[] = [];
  for (const ot of cfg.otProjects) {
    const key = ot.toBase58();
    if (!lock.acquire(key)) {
      logger.debug('lock held — WS handler in flight, skipping poll', { ot: key });
      continue;
    }
    try {
      out.push(await processOt({ conn, cfg, checkpoint, otMint: ot, client, metrics }));
    } finally {
      lock.release(key);
    }
  }
  return out;
}

/**
 * Poll loop (D10 fallback). Runs every CHECK_INTERVAL_SECS.
 */
export async function runLoop(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  signal: AbortSignal;
  client?: MultiRpcClient;
  metrics?: BotMetrics;
}): Promise<void> {
  const { cfg, signal } = args;
  while (!signal.aborted) {
    await runOnce(args);
    if (signal.aborted) break;
    await sleep(cfg.checkIntervalSecs * 1000, signal);
  }
}

/**
 * Subscribe to OT program logs (RevenueDistributed event triggers indicate
 * Accumulator USDC may have just topped up). Re-read each configured OT.
 *
 * We could be smarter and parse `RevenueDistributed` to find the OT mint —
 * for L8 we keep the hot path simple: any program log → re-check all OTs,
 * gated by the single-flight lock.
 */
export function subscribeRevenueDistributed(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  otProgramId: PublicKey;
  client?: MultiRpcClient;
  metrics?: BotMetrics;
}): { unsubscribe: () => Promise<void> } {
  const { conn, cfg, checkpoint, lock, otProgramId, client, metrics } = args;
  const subId = conn.onLogs(
    otProgramId,
    async (logs, ctx) => {
      if (logs.err) return;
      // Track the highest seen slot so reconcile after a reconnect can pick
      // up where the live subscription left off.
      checkpoint.setLastSeenSlot(otProgramId.toBase58(), ctx?.slot ?? 0);
      for (const ot of cfg.otProjects) {
        const key = ot.toBase58();
        if (!lock.acquire(key)) continue;
        try {
          await processOt({ conn, cfg, checkpoint, otMint: ot, client, metrics });
        } catch (e) {
          logger.error('WS-triggered convert processOt failed', e, { ot: key });
        } finally {
          lock.release(key);
        }
      }
    },
    'confirmed',
  );
  logger.info('convert-and-fund-crank WS subscribed', { programId: otProgramId.toBase58() });
  return {
    unsubscribe: async (): Promise<void> => {
      await conn.removeOnLogsListener(subId);
    },
  };
}

/**
 * R31: walk OT program signatures since the last-seen slot and re-dispatch
 * any missed RevenueDistributed events through `processOt`. Called once at
 * startup and on every WS reconnect path. Idempotent — `processOt` always
 * re-reads chain state and on-chain `convert_to_rwt` is itself idempotent
 * when the Accumulator USDC ATA is empty.
 */
export async function reconcileSinceLastSeen(args: {
  client: MultiRpcClient;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  lock: SingleFlightLock;
  signal?: AbortSignal;
  metrics?: BotMetrics;
}): Promise<number> {
  const { client, cfg, checkpoint, lock, signal, metrics } = args;
  const programKey = cfg.otProgramId.toBase58();
  const fromSlot = checkpoint.getLastSeenSlot(programKey);
  if (fromSlot === null) {
    logger.info('reconcile skipped — no prior checkpoint slot', { programId: programKey });
    return 0;
  }
  return await client.withFallback(conn =>
    reconcileEvents(
      conn,
      { programId: cfg.otProgramId, fromSlot, signal },
      async ({ slot }) => {
        // Re-walk every configured OT (matches the WS handler — we don't
        // parse event payloads, just trigger a fresh chain read per OT).
        for (const ot of cfg.otProjects) {
          if (signal?.aborted) return;
          const key = ot.toBase58();
          if (!lock.acquire(key)) continue;
          try {
            await processOt({ conn, cfg, checkpoint, otMint: ot, client, metrics });
          } catch (e) {
            logger.error('reconcile-triggered processOt failed', e, { ot: key });
          } finally {
            lock.release(key);
          }
        }
        checkpoint.setLastSeenSlot(programKey, slot);
      },
    ),
  );
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
