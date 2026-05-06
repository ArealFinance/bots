import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  MultiRpcClient,
  assertCrankBalance,
  logger,
  reconcileEvents,
  resolveMinLamportsFromEnv,
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
  findClaimStatusPda,
  findMerkleDistributorPda,
  findOtTreasuryPda,
  findRwtDistConfigPda,
  findRwtVaultPda,
  findYdConfigPda,
} from '@areal/sdk/pda';

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
  client?: MultiRpcClient;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, otMint, inputs, client } = args;

  const [distributor] = findMerkleDistributorPda(otMint, cfg.ydProgramId);
  const [rwtVault] = findRwtVaultPda(cfg.rwtEngineProgramId);

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

  const [distConfig] = findYdConfigPda(cfg.ydProgramId);
  const [rwtDistConfig] = findRwtDistConfigPda(cfg.rwtEngineProgramId);
  const [ydClaimStatus] = findClaimStatusPda(distributor, rwtVault, cfg.ydProgramId);

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
    client,
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
  client?: MultiRpcClient;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, pool, inputs, client } = args;
  if (!inputs) {
    // Without inputs we can't even derive distributor / claim status meaningfully;
    // log a hint and return.
    logger.debug('pool compound — operator wiring required (otMint, ydRewardVault, targetVault)', {
      pool: pool.toBase58(),
    });
    return { kind: 'skip', reason: 'no_proof' };
  }
  const [distributor] = findMerkleDistributorPda(inputs.otMint, cfg.ydProgramId);

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

  const [ydConfig] = findYdConfigPda(cfg.ydProgramId);
  const [ydClaimStatus] = findClaimStatusPda(distributor, pool, cfg.ydProgramId);

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
    client,
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
  client?: MultiRpcClient;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, fetcher, otMint, ydOtMint, inputs, client } = args;
  const [otTreasury] = findOtTreasuryPda(otMint, cfg.otProgramId);
  const [distributor] = findMerkleDistributorPda(ydOtMint, cfg.ydProgramId);

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

  const [ydConfig] = findYdConfigPda(cfg.ydProgramId);
  const [ydClaimStatus] = findClaimStatusPda(distributor, otTreasury, cfg.ydProgramId);

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
    client,
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
  client?: MultiRpcClient;
}): Promise<ClaimDecision> {
  const { conn, cfg, checkpoint, tx, kind, key, decision, client } = args;

  // SEND_TX gate (Substep 13). When disabled, surface the decision and exit.
  if (!cfg.sendTx) {
    logger.info(`${kind} claim decision = SEND (SEND_TX=false, skipping submit)`, {
      key,
      epoch: decision.epoch.toString(),
      cumulative: decision.cumulativeAmount.toString(),
    });
    return decision;
  }

  try {
    // R29 sweep: prefer multi-RPC fallback when available.
    const sig = client
      ? await client.withFallback((c) =>
          sendAndConfirmTransaction(c, tx, [cfg.crankKeypair], {
            commitment: 'confirmed',
            skipPreflight: false,
          }),
        )
      : await sendAndConfirmTransaction(conn, tx, [cfg.crankKeypair], {
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
 * Drain accumulated RWT from `LiquidityHolding` once per epoch via
 * `YD::withdraw_liquidity_holding`. Opt-in (`YIELD_CLAIM_ENABLE_LH_DRAIN`) and
 * gated by `SEND_TX`. Disabled by default until R20 (RWT_MINT pin migration)
 * lands — until then the YD program rejects the holding init/drain.
 *
 * NOTE: full TX assembly (account list, discriminator) is intentionally
 * deferred to the operator-side runbook because the on-chain handler is
 * pinned to a specific RWT mint that may not match the bootstrap. The bot
 * surfaces the decision so dashboards / E2E logs flag the pending action.
 */
export async function processLiquidityHoldingDrain(args: {
  conn: Connection;
  cfg: BotConfig;
  fetcher: ProofFetcher;
}): Promise<ClaimDecision> {
  const { cfg } = args;
  if (!cfg.enableLhDrain) {
    return { kind: 'skip', reason: 'deferred' };
  }
  if (!cfg.sendTx) {
    logger.info('lh-drain: opt-in enabled, dry-run (SEND_TX=false)', {
      note: 'TX assembly deferred until R20 RWT_MINT pin migration lands',
    });
    return { kind: 'skip', reason: 'deferred' };
  }
  // R20 / R-58: full assembly lands once the RWT mint pin migration is final.
  // Use `logger.debug` (not `warn`) to avoid spamming operators on every
  // claim cycle once they explicitly opt in — they already know R20 pends.
  logger.debug('lh-drain: opt-in enabled but TX assembly gated on R20', {
    note: 'see R-58 / SD-29',
  });
  return { kind: 'skip', reason: 'deferred' };
}

/**
 * Per-OT-revenue-cycle USDC `nexus_deposit` flow (DEX program). Opt-in
 * (`YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT`) and gated by `SEND_TX`. The on-chain
 * `nexus_deposit` ix is permissionless, so any signer can fund the
 * LiquidityNexus from the OT Treasury USDC ATA. Wiring of the full TX
 * (account list + discriminator) lands once nexus-manager's tx-builders
 * surface a public helper for the deposit path.
 */
export async function processNexusDeposit(args: {
  conn: Connection;
  cfg: BotConfig;
  otMint: PublicKey;
}): Promise<ClaimDecision> {
  const { cfg } = args;
  if (!cfg.enableNexusDeposit) {
    return { kind: 'skip', reason: 'deferred' };
  }
  if (!cfg.sendTx) {
    logger.info('nexus-deposit: opt-in enabled, dry-run (SEND_TX=false)', {
      ot: args.otMint.toBase58(),
      note: 'TX assembly defers to nexus-manager builders',
    });
    return { kind: 'skip', reason: 'deferred' };
  }
  logger.debug(
    'nexus-deposit: opt-in enabled but TX assembly defers to nexus-manager builders',
    { ot: args.otMint.toBase58(), note: 'see SD-29' },
  );
  return { kind: 'skip', reason: 'deferred' };
}

/**
 * Run all flows once. Stops only on AbortSignal.
 *
 * Ordering matters:
 *   (1) vault claim → (2) pool compound → (3) treasury claim
 *   (4) opt-in: LH drain (per epoch)
 *   (5) opt-in: nexus_deposit (per OT)
 */
export async function runClaimCycle(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
  client?: MultiRpcClient;
}): Promise<void> {
  const { conn, cfg, checkpoint, fetcher, lock, client } = args;

  // R-60: shared SOL pre-flight. When SEND_TX is enabled and the wallet is
  // dry, every per-flow submit would burn an RPC round-trip only to surface
  // InsufficientFunds. Skip the cycle entirely with a single warn line and
  // let the next tick re-check after the operator tops up. Decision-only
  // dry-runs (SEND_TX=false) skip the gate so the cycle still emits its
  // surface-level decisions for E2E logs.
  if (cfg.sendTx && client) {
    try {
      const minLamports = resolveMinLamportsFromEnv('YIELD_CLAIM');
      const gate = await assertCrankBalance(
        client,
        cfg.crankKeypair.publicKey,
        minLamports,
      );
      if (gate.kind === 'skip') {
        logger.warn('yield-claim: crank wallet low SOL — skipping entire cycle', {
          balance: gate.balance,
          required: gate.required,
        });
        return;
      }
    } catch {
      // All endpoints failed — let downstream submits surface a richer error.
    }
  }

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
        client,
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
        client,
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
        client,
      });
    } finally {
      lock.release(k);
    }
  }

  // (4) Opt-in LH drain (gated on YIELD_CLAIM_ENABLE_LH_DRAIN + SEND_TX)
  if (cfg.enableLhDrain) {
    const k = 'lh-drain:singleton';
    if (lock.acquire(k)) {
      try {
        await processLiquidityHoldingDrain({ conn, cfg, fetcher });
      } finally {
        lock.release(k);
      }
    }
  }

  // (5) Opt-in nexus_deposit per OT (gated on YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT)
  if (cfg.enableNexusDeposit) {
    for (const ot of cfg.otProjects) {
      const k = `nexus-deposit:${ot.toBase58()}`;
      if (!lock.acquire(k)) continue;
      try {
        await processNexusDeposit({ conn, cfg, otMint: ot });
      } finally {
        lock.release(k);
      }
    }
  }
}

/**
 * E2E entrypoint: run the claim cycle once and return. Wraps the per-flow
 * single-flight lock to keep the harness deterministic.
 */
export async function runOnce(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
  client?: MultiRpcClient;
}): Promise<void> {
  await runClaimCycle(args);
}

export async function runLoop(args: {
  conn: Connection;
  cfg: BotConfig;
  checkpoint: CheckpointStore;
  fetcher: ProofFetcher;
  lock: SingleFlightLock;
  signal: AbortSignal;
  client?: MultiRpcClient;
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
  client?: MultiRpcClient;
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
