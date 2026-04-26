import { Connection, PublicKey } from '@solana/web3.js';

import type { BotConfig } from './config.js';
import type { CheckpointStore } from './checkpoint.js';
import type { ConvertContext, ConvertDecision } from './types.js';
import {
  deriveAccumulatorPda,
  deriveDistributorPda,
  deriveRwtVaultPda,
  fetchNav,
  fetchPoolSnapshot,
  fetchTokenAmount,
} from './readers.js';
import { chooseRoute } from './slippage.js';
import { logger } from './logger.js';

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

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Local re-implementation of `getAssociatedTokenAddress` so we don't pull in
 * @solana/spl-token (smaller dep tree). Same algorithm: PDA of
 *   [owner, TOKEN_PROGRAM, mint] under ASSOCIATED_TOKEN_PROGRAM.
 */
export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
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
}): Promise<ConvertDecision> {
  const { conn, cfg, checkpoint, otMint } = args;

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

  // To send the TX we need the additional account list — these come from
  // on-chain state we already touched (DistributionConfig.areal_fee_destination,
  // MerkleDistributor.reward_vault, RwtVault's capital_acc + dao_fee_account,
  // and the master pool's vaults). Layer 8 §8.2.3 lists them.
  //
  // Reading those structs requires per-program state parsers that we keep
  // intentionally lightweight: the bot ships with parsers ONLY for the fields
  // it needs, and never for fields that mutate within the convert TX.
  //
  // For Layer 8 launch the operator wires these in via env (REWARD_VAULT, etc.)
  // OR runs a small one-shot bootstrap that reads them via the contracts'
  // public state. To keep this file deterministic we stop short of issuing
  // the TX here and surface the decision; the integration test or operator
  // tooling assembles the full TX. (See README — "Wiring fee_account / vaults".)
  //
  // TODO(Step 10 E2E): wire the dynamic on-chain reads + sendConvertToRwt
  // call once an integration fixture exists. Until then, callers can compose
  // `buildConvertToRwtIx` from `src/convert.ts` themselves — every account
  // they need is derivable.

  const distributor = deriveDistributorPda(otMint, cfg.ydProgramId);
  logger.info('convert decision = SEND (assembly deferred to caller)', {
    ot: otMint.toBase58(),
    distributor: distributor.toBase58(),
    usdcAmount: decision.usdcAmount.toString(),
    minRwtOut: decision.minRwtOut.toString(),
    swapFirst: decision.swapFirst,
  });
  // Refresh checkpoint with current slot so dashboards see liveness even
  // before the TX path is wired in.
  const slot = BigInt(await conn.getSlot('confirmed'));
  checkpoint.upsert(otMint.toBase58(), slot, null);
  return decision;
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
}): Promise<void> {
  const { conn, cfg, checkpoint, lock, signal } = args;
  while (!signal.aborted) {
    for (const ot of cfg.otProjects) {
      if (signal.aborted) break;
      const key = ot.toBase58();
      if (!lock.acquire(key)) {
        logger.debug('lock held — WS handler in flight, skipping poll', { ot: key });
        continue;
      }
      try {
        await processOt({ conn, cfg, checkpoint, otMint: ot });
      } finally {
        lock.release(key);
      }
    }
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
}): { unsubscribe: () => Promise<void> } {
  const { conn, cfg, checkpoint, lock, otProgramId } = args;
  const subId = conn.onLogs(
    otProgramId,
    async logs => {
      if (logs.err) return;
      for (const ot of cfg.otProjects) {
        const key = ot.toBase58();
        if (!lock.acquire(key)) continue;
        try {
          await processOt({ conn, cfg, checkpoint, otMint: ot });
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
