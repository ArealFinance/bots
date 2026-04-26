/**
 * Publisher loop idempotency test.
 *
 * Focus: `runOnce()` must NOT submit a duplicate publish_root when nothing
 * has changed since the last publish. Without this guard every cycle would
 * spam the chain with identical roots (wasted SOL + polluted epoch counter).
 *
 * We stub:
 *  - SnapshotStore          — in-memory fakes (deterministic, no SQLite)
 *  - KmsSigner              — random keypair + partialSign (real ed25519)
 *  - Connection             — mocked getAccountInfo + sendRawTransaction
 *  - ProofStore             — swap atomic-write to a noop
 *
 * Behavior asserted:
 *   1. Empty store → no submit.
 *   2. One fresh snapshot → exactly 1 submit.
 *   3. Second runOnce with same snapshot → 0 additional submits (idempotency).
 *   4. Self-verify fires before submit (verifyProof path is exercised by
 *      buildTree internally; we just assert submit still happens).
 *
 * @see Layer 7 tester review §"Missing Tests" H2
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Publisher } from '../src/publisher.js';

// Must match MERKLE_DISTRIBUTOR_DISCRIMINATOR in publisher.ts (INFO-R2-1 fix).
const MERKLE_DISTRIBUTOR_DISCRIMINATOR = createHash('sha256')
  .update('account:MerkleDistributor')
  .digest()
  .subarray(0, 8);
import type { BotConfig } from '../src/config.js';
import type { KmsSigner } from '../src/kms-signer.js';
import type { ProofStore } from '../src/proof-store.js';
import type { Snapshot, PublishRecord } from '../src/types.js';

class FakeStore {
  private snapshots: Snapshot[] = [];
  private publishes: PublishRecord[] = [];
  markCalls: Array<{ distributor: string; epochs: number[]; pubEpoch: number }> = [];

  add(s: Snapshot) {
    this.snapshots.push(s);
  }

  getActiveDistributors(): string[] {
    return Array.from(new Set(this.snapshots.map(s => s.distributor)));
  }

  getAllSnapshots(distributor: string): Snapshot[] {
    return this.snapshots.filter(s => s.distributor === distributor);
  }

  getLastPublish(distributor: string): PublishRecord | null {
    const subset = this.publishes.filter(p => p.distributor === distributor);
    if (subset.length === 0) return null;
    return subset.reduce((acc, x) => (x.epoch > acc.epoch ? x : acc));
  }

  recordPublish(rec: PublishRecord): void {
    this.publishes.push(rec);
  }

  markSnapshotsPublished(distributor: string, coveredEpochs: number[], publishEpoch: number): void {
    this.markCalls.push({ distributor, epochs: coveredEpochs, pubEpoch: publishEpoch });
  }
}

function fakeConfig(signerPubkey: PublicKey, arlOt: PublicKey): BotConfig {
  return {
    network: 'devnet',
    rpcUrl: 'http://x',
    rpcWsUrl: 'ws://x',
    archivalRpcUrl: 'http://x',
    archivalRpcUrl2: null,
    ydProgramId: Keypair.generate().publicKey,
    otProgramId: Keypair.generate().publicKey,
    dexProgramId: null,
    minHoldingOtLamports: 100_000_000n,
    arlOtTreasury: arlOt,
    publisherPubkey: signerPubkey,
    publishIntervalMs: 600_000,
    kmsProvider: 'local',
    kmsKeyId: '',
    awsRegion: '',
    excludedHolders: [],
    dbPath: '',
    proofDir: '',
    coldStartLookbackSlots: 432_000n,
    logLevel: 'warn',
  };
}

function fakeSigner(): KmsSigner {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx: Transaction): Promise<Transaction> {
      tx.partialSign(kp);
      return tx;
    },
    async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
      tx.sign([kp]);
      return tx;
    },
    async signRaw(_message: Uint8Array): Promise<Uint8Array> {
      // Return a deterministic 64-byte stub — tests don't verify signatures.
      return new Uint8Array(64);
    },
  };
}

function fakeConnection(distributorPda: PublicKey, otMint: PublicKey, sendMock: (raw: Uint8Array) => Promise<string>) {
  // Layout per Publisher.loadDistributorOtMint: 8 discriminator bytes + 32 ot_mint.
  // Discriminator must match MERKLE_DISTRIBUTOR_DISCRIMINATOR (INFO-R2-1 fix).
  const data = Buffer.alloc(40);
  MERKLE_DISTRIBUTOR_DISCRIMINATOR.copy(data, 0);
  otMint.toBuffer().copy(data, 8);

  // Blockhash must be a real base58-decodable 32-byte value because
  // Transaction.serialize() will base58-decode it. Use a random pubkey as
  // a throwaway 32-byte blob.
  const blockhash = Keypair.generate().publicKey.toBase58();

  return {
    async getAccountInfo(pk: PublicKey, _commitment?: string) {
      if (pk.equals(distributorPda)) {
        return { data, executable: false, lamports: 1, owner: Keypair.generate().publicKey, rentEpoch: 0 };
      }
      return null;
    },
    async getLatestBlockhash(_c?: string) {
      return { blockhash, lastValidBlockHeight: 1 };
    },
    async sendRawTransaction(raw: Uint8Array) {
      return sendMock(raw);
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  } as any;
}

function fakeProofStore(): ProofStore {
  return {
    async writeProofs() {
      /* noop */
    },
    async writeProofsToStaging() {
      /* noop */
    },
    promoteStagedProofs() {
      /* noop */
    },
    sweepStaleStaging() {
      /* noop */
    },
  } as unknown as ProofStore;
}

function snap(distributor: string, depositEpoch: number, amount: bigint, holder: string): Snapshot {
  return {
    distributor,
    depositEpoch,
    depositAmount: amount,
    totalFundedAtEvent: amount * BigInt(depositEpoch + 1),
    slot: 100 + depositEpoch,
    fundTs: 1_700_000_000 + depositEpoch,
    txSignature: `sig-${depositEpoch}`,
    totalEligible: 1000n,
    eventKind: 'DistributorFunded',
    balances: [{ holder, balance: 1000n, eligible: 1 }],
  };
}

describe('Publisher.runOnce', () => {
  let signer: KmsSigner;
  let cfg: BotConfig;
  let store: FakeStore;
  let sendCount = 0;

  beforeEach(() => {
    sendCount = 0;
    signer = fakeSigner();
    cfg = fakeConfig(signer.publicKey, Keypair.generate().publicKey);
    store = new FakeStore();
  });

  it('submits zero tx when no active distributors', async () => {
    const conn = fakeConnection(Keypair.generate().publicKey, Keypair.generate().publicKey, async () => {
      sendCount += 1;
      return 'sig-unexpected';
    });
    const pub = new Publisher(cfg, conn, signer, store as any, fakeProofStore());
    await pub.runOnce();
    expect(sendCount).toBe(0);
  });

  it('submits exactly 1 tx on first runOnce with fresh snapshots', async () => {
    // Use a real PDA derivation so the Publisher's internal findProgramAddressSync
    // from its own code path works — but since Publisher derives nothing for the
    // distributor (uses the key from store.getActiveDistributors), we just
    // pick a real base58 pubkey as the distributor identity.
    const distKp = Keypair.generate();
    const otMint = Keypair.generate().publicKey;
    const holder = Keypair.generate().publicKey.toBase58();

    store.add(snap(distKp.publicKey.toBase58(), 0, 1_000_000_000n, holder));

    const conn = fakeConnection(distKp.publicKey, otMint, async () => {
      sendCount += 1;
      return `sig-${sendCount}`;
    });
    const pub = new Publisher(cfg, conn, signer, store as any, fakeProofStore());
    await pub.runOnce();
    expect(sendCount).toBe(1);

    const last = store.getLastPublish(distKp.publicKey.toBase58());
    expect(last).not.toBeNull();
    expect(last!.epoch).toBe(1);
    expect(last!.maxTotalClaim).toBe(1_000_000_000n);
  });

  it('idempotent: second runOnce with unchanged snapshots submits 0 additional tx', async () => {
    const distKp = Keypair.generate();
    const otMint = Keypair.generate().publicKey;
    const holder = Keypair.generate().publicKey.toBase58();

    store.add(snap(distKp.publicKey.toBase58(), 0, 1_000_000_000n, holder));

    const conn = fakeConnection(distKp.publicKey, otMint, async () => {
      sendCount += 1;
      return `sig-${sendCount}`;
    });
    const pub = new Publisher(cfg, conn, signer, store as any, fakeProofStore());

    await pub.runOnce();
    expect(sendCount).toBe(1);
    const epochAfterFirst = store.getLastPublish(distKp.publicKey.toBase58())!.epoch;

    // Same snapshots, nothing new — second pass must skip.
    await pub.runOnce();
    expect(sendCount).toBe(1); // unchanged

    const after = store.getLastPublish(distKp.publicKey.toBase58())!;
    expect(after.epoch).toBe(epochAfterFirst); // no new publish record
  });

  it('adding a new snapshot triggers a new publish_root with incremented epoch', async () => {
    const distKp = Keypair.generate();
    const otMint = Keypair.generate().publicKey;
    const holder = Keypair.generate().publicKey.toBase58();

    const distKey = distKp.publicKey.toBase58();
    store.add(snap(distKey, 0, 1_000_000_000n, holder));

    const conn = fakeConnection(distKp.publicKey, otMint, async () => {
      sendCount += 1;
      return `sig-${sendCount}`;
    });
    const pub = new Publisher(cfg, conn, signer, store as any, fakeProofStore());

    await pub.runOnce();
    expect(sendCount).toBe(1);
    expect(store.getLastPublish(distKey)!.epoch).toBe(1);

    // Now add a second snapshot → different cumulative → different root → submits again.
    store.add(snap(distKey, 1, 500_000_000n, holder));
    await pub.runOnce();
    expect(sendCount).toBe(2);
    expect(store.getLastPublish(distKey)!.epoch).toBe(2);
  });
});
