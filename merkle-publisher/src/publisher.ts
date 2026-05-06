import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { findYdConfigPda } from '@areal/sdk/pda';
import type { BotConfig } from './config.js';
import type { KmsSigner } from './kms-signer.js';
import type { ProofStore } from './proof-store.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { PendingPublish } from './types.js';
import { aggregateSnapshots, buildTree, verifyProof } from './tree-builder.js';
import { logger } from './logger.js';

/**
 * Arlex/Anchor-style account discriminator for the MerkleDistributor type:
 *   sha256("account:MerkleDistributor")[..8]
 *
 * Computed once at module load. Used by `loadDistributorOtMint` to validate
 * that the on-chain account we're reading is actually a MerkleDistributor
 * before trusting the byte offset of `ot_mint` (INFO-R2-1).
 */
const MERKLE_DISTRIBUTOR_DISCRIMINATOR: Buffer = createHash('sha256')
  .update('account:MerkleDistributor')
  .digest()
  .subarray(0, 8);

/**
 * Publisher loop — every PUBLISH_INTERVAL_MS:
 *   for each distributor with unpublished snapshots:
 *     1. Aggregate snapshots → cumulative[holder]
 *     2. Build merkle tree (canonical ordering)
 *     3. Verify a sample proof locally (defensive)
 *     4. Write proofs to disk
 *     5. Submit publish_root tx via KMS signer
 *     6. Mark snapshots published + record publish
 */
export class Publisher {
  constructor(
    private readonly cfg: BotConfig,
    private readonly conn: Connection,
    private readonly signer: KmsSigner,
    private readonly snapshotStore: SnapshotStore,
    private readonly proofStore: ProofStore,
  ) {}

  /** Run one pass — iterate distributors and publish where appropriate. */
  async runOnce(): Promise<void> {
    const distributors = this.snapshotStore.getActiveDistributors();
    if (distributors.length === 0) {
      logger.debug('no active distributors');
      return;
    }

    for (const d of distributors) {
      try {
        await this.processDistributor(d);
      } catch (err) {
        logger.error('processDistributor failed', err, { distributor: d });
      }
    }
  }

  /** Long-running loop with graceful shutdown support. */
  async loop(stopSignal: AbortSignal): Promise<void> {
    while (!stopSignal.aborted) {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error('publisher.runOnce threw', err);
      }
      await sleep(this.cfg.publishIntervalMs, stopSignal);
    }
    logger.info('publisher loop stopped');
  }

  private async processDistributor(distributorKey: string): Promise<void> {
    const snapshots = this.snapshotStore.getAllSnapshots(distributorKey);
    if (snapshots.length === 0) return;

    // Aggregate cumulative amounts across all snapshots — this is what each
    // publish_root encodes. Note: per-deposit fairness means we re-aggregate
    // from ALL snapshots each publish, not just unpublished — the cumulative
    // amount is a monotonic function across the distributor's lifetime.
    const leafMap = aggregateSnapshots(snapshots, this.cfg.arlOtTreasury);
    if (leafMap.size === 0) {
      logger.debug('no eligible holders yet', { distributor: distributorKey });
      return;
    }

    const { root, proofs } = buildTree(leafMap);

    // Authoritative max_total_claim: the largest `total_funded_at_event` across
    // all snapshots — this mirrors the on-chain MerkleDistributor.total_funded
    // AFTER the most recent fund event. Using the chain-reported value (vs
    // re-summing `depositAmount`) hardens against any off-by-one in fee math
    // and against historical NULL rows in older DBs. CRIT-1 fix.
    let maxTotalClaim = 0n;
    for (const s of snapshots) {
      if (s.totalFundedAtEvent > maxTotalClaim) maxTotalClaim = s.totalFundedAtEvent;
    }

    // INFO-R2-3: defensive — legacy snapshots with `total_funded_at_event = 0`
    // (from the additive ALTER TABLE DEFAULT 0 migration) would produce
    // `maxTotalClaim = 0`, which on-chain fails with `ZeroMaxClaim`. That
    // leaves the bot in a loud-but-unhelpful retry loop. Detect + skip.
    if (maxTotalClaim === 0n) {
      logger.warn(
        'skipping publish: maxTotalClaim == 0 (likely legacy snapshots with total_funded_at_event = 0). ' +
          'Purge or backfill the snapshots before retrying.',
        {
          distributor: distributorKey,
          snapshotCount: snapshots.length,
        },
      );
      return;
    }

    // Belt-and-suspenders invariant: Σ depositAmount (Σ NET) must equal
    // maxTotalClaim when the bot has seen every fund event. If they disagree
    // we are missing a fund event and must refuse to publish — publishing a
    // lower cap would cause `publish_root` to revert with `InvalidMaxClaim`
    // anyway, but aborting early with a clear error is better UX.
    const summedNet = snapshots.reduce((s, x) => s + x.depositAmount, 0n);
    if (summedNet !== maxTotalClaim) {
      logger.warn('snapshot sum != totalFundedAtEvent, possibly missing events', {
        distributor: distributorKey,
        summedNet,
        maxTotalClaim,
      });
    }

    // Idempotency: skip if the last publish was identical.
    const last = this.snapshotStore.getLastPublish(distributorKey);
    const rootHex = Buffer.from(root).toString('hex');
    if (last && last.merkleRoot === rootHex && last.maxTotalClaim === maxTotalClaim) {
      logger.debug('root unchanged, skip', { distributor: distributorKey });
      return;
    }

    // Defensive self-verify: pick one holder and verify its proof against root.
    const sampleHolder = leafMap.keys().next().value as string | undefined;
    if (sampleHolder) {
      const proof = proofs.get(sampleHolder) ?? [];
      const cumulative = leafMap.get(sampleHolder)!;
      if (!verifyProof(sampleHolder, cumulative, proof, root)) {
        throw new Error('self-verify failed: proof does not match root');
      }
    }

    const distributor = new PublicKey(distributorKey);

    // Determine ot_mint — required for the publish_root accounts list.
    // The distributor PDA does not itself contain a readable ot_mint field
    // *before* we parse the account; to avoid an extra RPC read per cycle on
    // steady state, we derive ot_mint from the snapshot (every snapshot carries
    // its originating distributor, which is seeded by ot_mint).
    //
    // The cleanest is to read it from on-chain state (distributor.ot_mint).
    const otMint = await this.loadDistributorOtMint(distributor);
    if (!otMint) {
      logger.warn('could not resolve ot_mint, deferring publish', {
        distributor: distributorKey,
      });
      return;
    }

    const nextEpoch = (last?.epoch ?? 0) + 1;

    const pending: PendingPublish = {
      distributor,
      epoch: nextEpoch,
      root,
      maxTotalClaim,
      leafMap,
      proofs,
      coveredSnapshotEpochs: snapshots.map(s => s.depositEpoch),
    };

    // NEW-M-3: two-phase proof publication.
    //   Phase 1: write the new epoch to staging (production dir untouched).
    //   Phase 2: after tx confirmation, promote staging → production.
    // If the tx fails, staging persists on disk; production keeps advertising
    // the previous epoch. Stale staging is swept at next startup via
    // `ProofStore.sweepStaleStaging` in index.ts.
    await this.proofStore.writeProofsToStaging(
      distributorKey,
      nextEpoch,
      root,
      leafMap,
      proofs,
    );

    // Submit publish_root tx.
    const signature = await this.submitPublishRoot(otMint, distributor, root, maxTotalClaim);

    // Finalize: record publish FIRST (so staging sweep on future startups
    // sees this epoch as "published"), then promote staging → production,
    // then mark snapshots. If we crash between recordPublish and promote,
    // the staging sweep will keep this epoch's staging (because
    // isEpochPublished returns true) and the next run will re-attempt
    // promote via `ensurePromotedForCurrentEpoch()` below.
    this.snapshotStore.recordPublish({
      distributor: distributorKey,
      epoch: nextEpoch,
      merkleRoot: rootHex,
      maxTotalClaim,
      txSignature: signature,
      publishedAt: Math.floor(Date.now() / 1000),
    });

    try {
      this.proofStore.promoteStagedProofs(distributorKey, nextEpoch);
    } catch (err) {
      // Hard-to-recover path: tx confirmed but file promotion failed. Log
      // loudly — next startup will NOT re-promote (staging wiped) but a
      // human operator can re-run the publisher against current state
      // because aggregateSnapshots is deterministic.
      logger.error('promoteStagedProofs failed AFTER successful publish_root', err, {
        distributor: distributorKey,
        epoch: nextEpoch,
        signature,
      });
      throw err;
    }

    this.snapshotStore.markSnapshotsPublished(
      distributorKey,
      pending.coveredSnapshotEpochs,
      nextEpoch,
    );

    logger.info('publish_root submitted', {
      distributor: distributorKey,
      epoch: nextEpoch,
      merkleRoot: rootHex,
      maxTotalClaim,
      signature,
    });
  }

  /**
   * Reads `distributor.ot_mint` from on-chain account data.
   * Layout (see architecture §2.2):
   *   8  bytes: account discriminator (arlex — sha256("account:MerkleDistributor")[..8])
   *   32 bytes: ot_mint          ← we want this
   *
   * INFO-R2-1: validate the discriminator before trusting the byte offset.
   * If the PDA is wrong or the account was re-initialised with a different
   * type, we'd otherwise submit publish_root with 32 bytes of arbitrary
   * data as `ot_mint`. The on-chain `has_one = ot_mint` check would still
   * reject it with `InvalidOtMint`, but we'd spam the chain with failing
   * txs and retry storms. Fail fast here instead.
   */
  private async loadDistributorOtMint(distributor: PublicKey): Promise<PublicKey | null> {
    const info = await this.conn.getAccountInfo(distributor, 'confirmed');
    if (!info || info.data.length < 8 + 32) return null;

    const actual = info.data.subarray(0, 8);
    if (!Buffer.from(actual).equals(MERKLE_DISTRIBUTOR_DISCRIMINATOR)) {
      logger.warn('loadDistributorOtMint: account discriminator mismatch', {
        distributor: distributor.toBase58(),
        expected: MERKLE_DISTRIBUTOR_DISCRIMINATOR.toString('hex'),
        actual: Buffer.from(actual).toString('hex'),
      });
      return null;
    }
    return new PublicKey(info.data.subarray(8, 8 + 32));
  }

  /** Build + sign + submit a publish_root transaction with retry. */
  private async submitPublishRoot(
    otMint: PublicKey,
    distributor: PublicKey,
    root: Uint8Array,
    maxTotalClaim: bigint,
  ): Promise<string> {
    const [configPda] = findYdConfigPda(this.cfg.ydProgramId);

    const ix = buildPublishRootInstruction({
      programId: this.cfg.ydProgramId,
      publishAuthority: this.signer.publicKey,
      configPda,
      distributor,
      otMint,
      merkleRoot: root,
      maxTotalClaim,
    });

    // Retry with exponential backoff for transient RPC/network errors.
    const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < delays.length) {
      try {
        const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
        const tx = new Transaction({
          feePayer: this.signer.publicKey,
          blockhash,
          lastValidBlockHeight,
        });
        tx.add(ix);

        await this.signer.signTransaction(tx);

        const sig = await this.conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        await this.conn.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        return sig;
      } catch (err) {
        lastErr = err;
        logger.warn('publish_root submit failed, retrying', {
          attempt: attempt + 1,
          delayMs: delays[attempt]!,
        });
        await new Promise(r => setTimeout(r, delays[attempt]!));
        attempt += 1;
      }
    }

    throw new Error(
      `publish_root exhausted retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
}

/**
 * Builds the publish_root instruction byte-for-byte per Arlex/Anchor conventions.
 *
 * Instruction data layout:
 *   [discriminator (8) | merkle_root (32) | max_total_claim (u64 LE)]
 *
 * Discriminator = sha256("global:publish_root")[..8] — matches the arlex-derive
 * program macro, which mirrors Anchor's naming.
 *
 * Accounts (order — must match contract's PublishRoot accounts struct):
 *   0: publish_authority (signer, readonly)
 *   1: config PDA (readonly)
 *   2: ot_mint (readonly)
 *   3: distributor PDA (writable)
 */
export interface BuildPublishRootParams {
  programId: PublicKey;
  publishAuthority: PublicKey;
  configPda: PublicKey;
  distributor: PublicKey;
  otMint: PublicKey;
  merkleRoot: Uint8Array;
  maxTotalClaim: bigint;
}

export function buildPublishRootInstruction(p: BuildPublishRootParams): TransactionInstruction {
  if (p.merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${p.merkleRoot.length}`);
  }

  const disc = createHash('sha256').update('global:publish_root').digest().subarray(0, 8);

  const data = Buffer.alloc(8 + 32 + 8);
  disc.copy(data, 0);
  Buffer.from(p.merkleRoot).copy(data, 8);
  data.writeBigUInt64LE(p.maxTotalClaim, 8 + 32);

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.publishAuthority, isSigner: true, isWritable: false },
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.otMint, isSigner: false, isWritable: false },
      { pubkey: p.distributor, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
