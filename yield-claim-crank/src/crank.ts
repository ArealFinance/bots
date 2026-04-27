import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  MultiRpcClient,
  logger,
  reconcileEvents,
} from '@areal/bots-shared';

import type { BotConfig } from './config.js';
import type { CheckpointStore, ClaimKind } from './checkpoint.js';
import type { ClaimDecision, ProofFile } from './types.js';
import { ProofFetcher } from './proof-fetcher.js';
import {
  buildDexCompoundIx,
  buildOtTreasuryClaimIx,
  buildRwtClaimYieldIx,
  proofFileToArgs,
  wrapClaimTx,
} from './claim-builders.js';
import {
  deriveClaimStatusPda,
  deriveDistConfigPda,
  deriveDistributorPda,
  deriveOtTreasuryPda,
  deriveRwtDistConfigPda,
  deriveRwtVaultPda,
} from './pdas.js';

/**
 * yield-claim-crank main loop.
 *
 * Three sub-flows execute in order on every tick:
 *   1. Vault claim    → `RWT::claim_yield` (per OT distributor; one ix per OT)
 *   2. Pool compound  → `DEX::compound_yield` (per OT/RWT pool)
 *   3. Treasury claim → `OT::claim_yd_for_treasury` (per OT distributor; cross-project)
 *
 * D9: each (kind, key) tuple checks the local checkpoint epoch first; if the
 * proof file's epoch is not strictly greater, we skip. The on-chain
 * `ClaimStatus` PDA is the absolute source of truth (`claimed_amount`
 * accumulates), so a stale local checkpoint just means an extra RPC round-
 * trip — never a double-claim.
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
}

/** Pure decision: is this proof newer than what we've already submitted? */
export function decideClaim(args: {
  proof: ProofFile | null;
  checkpoint: CheckpointStore;
  kind: ClaimKind;
  key: string;
}): ClaimDecision {
  const { proof, checkpoint, kind, key } = args;
  if (!proof) return { kind: 'skip', reason: 'no_proof' };
  const epoch = BigInt(proof.epoch);
  if (!checkpoint.isNewer(kind, key, epoch)) {
    return { kind: 'skip', reason: 'epoch_stale' };
  }
  return {
    kind: 'send',
    cumulativeAmount: BigInt(proof.cumulativeAmount),
    epoch,
  };
}

/**
 * Vault flow per OT.
 *
 * Inputs the operator must wire (architecture §5.2):
 *   - `liquidity_dest`         (RwtDistributionConfig.liquidity_destination, D11.1)
 *   - `protocol_revenue_dest`  (RwtDistributionConfig.protocol_revenue_destination)
 *   - `rwt_claim_ata`          (vault-PDA-owned RWT ATA)
 *   - `yd_reward_vault`        (MerkleDistributor.reward_vault)
 *
 * For Layer 8 we read these from on-chain config / state via the dashboard or
 * one-shot bootstrap; the bot exposes the builders so any caller can compose.
 * Once the dynamic-account reader lands (Step 10) this function will go from
 * "log decision" to "send TX" with no API change.
 */
export interface VaultClaimInputs {
  rwtClaimAta: PublicKey;
  liquidityDest: PublicKey;
  protocolRevenueDest: PublicKey;
  ydRewardVault: PublicKey;
}

export async function processVaultClaim(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  otMint: PublicKey;
  inputs: VaultClaimInputs | null; // null → log decision only
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, otMint, inputs } = args;

  const distributor = deriveDistributorPda(otMint, cfg.ydProgramId);
  const rwtVault = deriveRwtVaultPda(cfg.rwtEngineProgramId);

  let proof: ProofFile | null = null;
  try {
    proof = await fetcher.fetch(distributor.toBase58(), rwtVault.toBase58());
  } catch (err) {
    logger.warn('vault proof fetch failed', { ot: otMint.toBase58(), err: String(err) });
  }

  const decision = decideClaim({
    proof,
    checkpoint,
    kind: 'vault',
    key: otMint.toBase58(),
  });

  if (decision.kind === 'skip') {
    logger.debug('skip vault claim', {
      ot: otMint.toBase58(),
      reason: decision.reason,
    });
    return decision;
  }

  if (!inputs) {
    logger.info('vault claim ready (assembly deferred to caller)', {
      ot: otMint.toBase58(),
      epoch: decision.epoch.toString(),
      cumulative: decision.cumulativeAmount.toString(),
    });
    return decision;
  }

  const distConfig = deriveDistConfigPda(cfg.ydProgramId);
  const rwtDistConfig = deriveRwtDistConfigPda(cfg.rwtEngineProgramId);
  const ydClaimStatus = deriveClaimStatusPda({
    distributor,
    claimant: rwtVault,
    ydProgramId: cfg.ydProgramId,
  });

  const { proof: proofNodes } = proofFileToArgs(proof!);
  const ix = buildRwtClaimYieldIx({
    rwtEngineProgramId: cfg.rwtEngineProgramId,
    ydProgramId: cfg.ydProgramId,
    crank: cfg.crankKeypair.publicKey,
    rwtVault,
    distConfig: rwtDistConfig,
    rwtClaimAta: inputs.rwtClaimAta,
    liquidityDest: inputs.liquidityDest,
    protocolRevenueDest: inputs.protocolRevenueDest,
    ydConfig: distConfig,
    otMint,
    ydDistributor: distributor,
    ydClaimStatus,
    ydRewardVault: inputs.ydRewardVault,
    cumulativeAmount: decision.cumulativeAmount,
    proof: proofNodes,
  });

  const tx = wrapClaimTx({
    ix,
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
  });
  return await sendAndCheckpoint({
    conn,
    cfg,
    checkpoint,
    tx,
    kind: 'vault',
    key: otMint.toBase58(),
    decision,
  });
}

export interface PoolCompoundInputs {
  /** Pool's RWT-side vault ATA (must equal pool.vault_a OR pool.vault_b). */
  targetVault: PublicKey;
  /** OT mint for the non-RWT side of the pool — identifies the YD distributor. */
  otMint: PublicKey;
  /** MerkleDistributor.reward_vault for that OT. */
  ydRewardVault: PublicKey;
}

export async function processPoolCompound(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  pool: PublicKey;
  inputs: PoolCompoundInputs | null;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, pool, inputs } = args;
  if (!inputs) {
    // Without inputs we can't even derive distributor / claim status meaningfully;
    // log a hint and return.
    logger.debug('pool compound — operator wiring required (otMint, ydRewardVault, targetVault)', {
      pool: pool.toBase58(),
    });
    return { kind: 'skip', reason: 'no_proof' };
  }
  const distributor = deriveDistributorPda(inputs.otMint, cfg.ydProgramId);

  let proof: ProofFile | null = null;
  try {
    proof = await fetcher.fetch(distributor.toBase58(), pool.toBase58());
  } catch (err) {
    logger.warn('pool proof fetch failed', { pool: pool.toBase58(), err: String(err) });
  }

  const decision = decideClaim({
    proof,
    checkpoint,
    kind: 'pool',
    key: pool.toBase58(),
  });
  if (decision.kind === 'skip') return decision;

  const ydConfig = deriveDistConfigPda(cfg.ydProgramId);
  const ydClaimStatus = deriveClaimStatusPda({
    distributor,
    claimant: pool,
    ydProgramId: cfg.ydProgramId,
  });

  const { proof: proofNodes } = proofFileToArgs(proof!);
  const ix = buildDexCompoundIx({
    dexProgramId: cfg.dexProgramId,
    ydProgramId: cfg.ydProgramId,
    crank: cfg.crankKeypair.publicKey,
    poolState: pool,
    targetVault: inputs.targetVault,
    ydConfig,
    otMint: inputs.otMint,
    ydDistributor: distributor,
    ydClaimStatus,
    ydRewardVault: inputs.ydRewardVault,
    cumulativeAmount: decision.cumulativeAmount,
    proof: proofNodes,
  });
  const tx = wrapClaimTx({
    ix,
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
  });
  return await sendAndCheckpoint({
    conn,
    cfg,
    checkpoint,
    tx,
    kind: 'pool',
    key: pool.toBase58(),
    decision,
  });
}

export interface TreasuryClaimInputs {
  /** RWT ATA owned by `OtTreasury(otMint)` — receives claimed RWT. */
  treasuryRwtAta: PublicKey;
  /** YD distributor's reward_vault for `ydOtMint`. */
  ydRewardVault: PublicKey;
}

export async function processTreasuryClaim(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  /** This treasury's OT mint (used to derive OtTreasury PDA). */
  otMint: PublicKey;
  /** OT mint of the source distributor — may differ from `otMint`. */
  ydOtMint: PublicKey;
  inputs: TreasuryClaimInputs | null;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, otMint, ydOtMint, inputs } = args;
  const otTreasury = deriveOtTreasuryPda(otMint, cfg.otProgramId);
  const distributor = deriveDistributorPda(ydOtMint, cfg.ydProgramId);

  let proof: ProofFile | null = null;
  try {
    proof = await fetcher.fetch(distributor.toBase58(), otTreasury.toBase58());
  } catch (err) {
    logger.warn('treasury proof fetch failed', {
      ot: otMint.toBase58(),
      ydOt: ydOtMint.toBase58(),
      err: String(err),
    });
  }

  const key = `${otMint.toBase58()}:${ydOtMint.toBase58()}`;
  const decision = decideClaim({
    proof,
    checkpoint,
    kind: 'treasury',
    key,
  });
  if (decision.kind === 'skip' || !inputs) {
    if (decision.kind === 'send' && !inputs) {
      logger.info('treasury claim ready (assembly deferred to caller)', {
        otMint: otMint.toBase58(),
        ydOtMint: ydOtMint.toBase58(),
        epoch: decision.epoch.toString(),
        cumulative: decision.cumulativeAmount.toString(),
      });
    }
    return decision;
  }

  const ydConfig = deriveDistConfigPda(cfg.ydProgramId);
  const ydClaimStatus = deriveClaimStatusPda({
    distributor,
    claimant: otTreasury,
    ydProgramId: cfg.ydProgramId,
  });

  const { proof: proofNodes } = proofFileToArgs(proof!);
  const ix = buildOtTreasuryClaimIx({
    otProgramId: cfg.otProgramId,
    ydProgramId: cfg.ydProgramId,
    crank: cfg.crankKeypair.publicKey,
    otMint,
    otTreasury,
    treasuryRwtAta: inputs.treasuryRwtAta,
    ydConfig,
    ydOtMint,
    ydDistributor: distributor,
    ydClaimStatus,
    ydRewardVault: inputs.ydRewardVault,
    cumulativeAmount: decision.cumulativeAmount,
    proof: proofNodes,
  });
  const tx = wrapClaimTx({
    ix,
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
  });
  return await sendAndCheckpoint({
    conn,
    cfg,
    checkpoint,
    tx,
    kind: 'treasury',
    key,
    decision,
  });
}

async function sendAndCheckpoint(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  tx: Transaction;
  kind: ClaimKind;
  key: string;
  decision: ClaimDecision & { kind: 'send' };
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, tx, kind, key, decision } = args;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [cfg.crankKeypair], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    logger.info(`${kind} claim OK`, {
      key,
      sig,
      epoch: decision.epoch.toString(),
      cumulative: decision.cumulativeAmount.toString(),
    });
    checkpoint.upsert(kind, key, decision.epoch, sig);
    return decision;
  } catch (err) {
    logger.error(`${kind} claim TX failed`, err, { key });
    return { kind: 'skip', reason: 'rpc_error' };
  }
}

/**
 * Run all three flows once. Stops only on AbortSignal.
 */
export async function runClaimCycle(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
}): Promise<void> {
  const { conn, cfg, checkpoint, fetcher, lock } = args;

  // (1) Vault claim per OT
  for (const ot of cfg.otProjects) {
    const k = `vault:${ot.toBase58()}`;
    if (!lock.acquire(k)) continue;
    try {
      await processVaultClaim({
        conn,
        cfg,
        checkpoint,
        fetcher,
        otMint: ot,
        inputs: null,
      });
    } finally {
      lock.release(k);
    }
  }

  // (2) Pool compound per OT/RWT pool
  for (const pool of cfg.otRwtPools) {
    const k = `pool:${pool.toBase58()}`;
    if (!lock.acquire(k)) continue;
    try {
      await processPoolCompound({
        conn,
        cfg,
        checkpoint,
        fetcher,
        pool,
        inputs: null,
      });
    } finally {
      lock.release(k);
    }
  }

  // (3) Treasury claim per OT distributor (ARL claims its share for every OT)
  for (const ydOtMint of cfg.otProjects) {
    const k = `treasury:${cfg.arlOtMint.toBase58()}:${ydOtMint.toBase58()}`;
    if (!lock.acquire(k)) continue;
    try {
      await processTreasuryClaim({
        conn,
        cfg,
        checkpoint,
        fetcher,
        otMint: cfg.arlOtMint,
        ydOtMint,
        inputs: null,
      });
    } finally {
      lock.release(k);
    }
  }
}

export async function runLoop(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
  signal: AbortSignal;
}): Promise<void> {
  const { signal } = args;
  while (!signal.aborted) {
    try {
      await runClaimCycle(args);
    } catch (err) {
      logger.error('runClaimCycle errored', err);
    }
    if (signal.aborted) break;
    await sleep(args.cfg.claimIntervalSecs * 1000, signal);
  }
}

/**
 * Subscribe to YD program logs (RootPublished events trigger fresh proof
 * availability). Re-run the claim cycle on any program log, gated by the
 * single-flight lock per (kind, key).
 */
export function subscribeRootPublished(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
}): { unsubscribe: () => Promise<void> } {
  const { conn, cfg, checkpoint } = args;
  const subId = conn.onLogs(
    cfg.ydProgramId,
    async (logs, ctx) => {
      if (logs.err) return;
      // Track the highest seen slot so reconcile after a reconnect can pick
      // up where the live subscription left off.
      checkpoint.setLastSeenSlot(cfg.ydProgramId.toBase58(), ctx?.slot ?? 0);
      try {
        await runClaimCycle(args);
      } catch (err) {
        logger.error('WS-triggered runClaimCycle failed', err);
      }
    },
    'confirmed',
  );
  logger.info('yield-claim-crank WS subscribed', { programId: cfg.ydProgramId.toBase58() });
  return {
    unsubscribe: async (): Promise<void> => {
      await conn.removeOnLogsListener(subId);
    },
  };
}

/**
 * R31: walk YD program signatures since the last-seen slot and re-run the
 * claim cycle for every dispatched event. Called once at startup and on
 * every WS reconnect path. Idempotent — `runClaimCycle` re-reads chain
 * state and on-chain ClaimStatus enforces strict-greater-than-cumulative.
 */
export async function reconcileSinceLastSeen(args: {
  client: MultiRpcClient;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
  signal?: AbortSignal;
}): Promise<number> {
  const { client, cfg, checkpoint, fetcher, lock, signal } = args;
  const programKey = cfg.ydProgramId.toBase58();
  const fromSlot = checkpoint.getLastSeenSlot(programKey);
  if (fromSlot === null) {
    logger.info('reconcile skipped — no prior checkpoint slot', { programId: programKey });
    return 0;
  }
  return await client.withFallback(conn =>
    reconcileEvents(
      conn,
      { programId: cfg.ydProgramId, fromSlot, signal },
      async ({ slot }) => {
        if (signal?.aborted) return;
        try {
          await runClaimCycle({ conn, cfg, checkpoint, fetcher, lock });
        } catch (err) {
          logger.error('reconcile-triggered runClaimCycle failed', err);
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
