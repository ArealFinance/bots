import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

import { CheckpointStore } from '../src/checkpoint.js';
import { proofFileToArgs, wrapClaimTx } from '../src/claim-builders.js';
import {
  buildDexCompoundIx,
  buildOtTreasuryClaimIx,
  buildRwtClaimYieldIx,
  DEX_COMPOUND_YIELD_DISCRIMINATOR,
  OT_CLAIM_YD_FOR_TREASURY_DISCRIMINATOR,
  RWT_CLAIM_YIELD_DISCRIMINATOR,
} from '@areal/sdk/tx';
import { parseRpcEndpoints } from '../src/config.js';
import { decideClaim, SingleFlightLock } from '../src/crank.js';
import {
  findClaimStatusPda,
  findMerkleDistributorPda,
  findOtTreasuryPda,
  findRwtVaultPda,
} from '@areal/sdk/pda';

// Adapter shims that preserve the legacy single-PublicKey return shape used
// throughout this test. SDK now returns [PublicKey, number] tuples; we destructure.
const deriveRwtVaultPda = (programId: PublicKey): PublicKey =>
  findRwtVaultPda(programId)[0];
const deriveDistributorPda = (otMint: PublicKey, programId: PublicKey): PublicKey =>
  findMerkleDistributorPda(otMint, programId)[0];
const deriveOtTreasuryPda = (otMint: PublicKey, programId: PublicKey): PublicKey =>
  findOtTreasuryPda(otMint, programId)[0];
const deriveClaimStatusPda = (args: {
  distributor: PublicKey;
  claimant: PublicKey;
  ydProgramId: PublicKey;
}): PublicKey =>
  findClaimStatusPda(args.distributor, args.claimant, args.ydProgramId)[0];
import { decodeProofNodes, parseProofJson, ProofFetcher } from '../src/proof-fetcher.js';

const YD_PROGRAM = new PublicKey('YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF');
const RWT_ENGINE = new PublicKey('RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL');
const DEX_PROGRAM = new PublicKey('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
const OT_PROGRAM = new PublicKey('oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL');
const OT_MINT = new PublicKey('11111111111111111111111111111112');
const POOL = new PublicKey('11111111111111111111111111111113');

describe('claim discriminators (SDK)', () => {
  it('rwt::claim_yield matches sha256("global:claim_yield")[..8]', () => {
    const expected = require('node:crypto')
      .createHash('sha256')
      .update('global:claim_yield')
      .digest()
      .subarray(0, 8) as Buffer;
    expect(RWT_CLAIM_YIELD_DISCRIMINATOR().equals(expected)).toBe(true);
  });

  it('dex::compound_yield matches sha256("global:compound_yield")[..8]', () => {
    const expected = require('node:crypto')
      .createHash('sha256')
      .update('global:compound_yield')
      .digest()
      .subarray(0, 8) as Buffer;
    expect(DEX_COMPOUND_YIELD_DISCRIMINATOR().equals(expected)).toBe(true);
  });

  it('ot::claim_yd_for_treasury matches sha256("global:claim_yd_for_treasury")[..8]', () => {
    const expected = require('node:crypto')
      .createHash('sha256')
      .update('global:claim_yd_for_treasury')
      .digest()
      .subarray(0, 8) as Buffer;
    expect(OT_CLAIM_YD_FOR_TREASURY_DISCRIMINATOR().equals(expected)).toBe(true);
  });
});

describe('claim ix builders', () => {
  it('buildRwtClaimYieldIx lays out 14 accounts in handler order', () => {
    const crank = Keypair.generate().publicKey;
    const rwtVault = deriveRwtVaultPda(RWT_ENGINE);
    const distributor = deriveDistributorPda(OT_MINT, YD_PROGRAM);
    const ix = buildRwtClaimYieldIx({
      rwtEngineProgramId: RWT_ENGINE,
      ydProgramId: YD_PROGRAM,
      crank,
      rwtVault,
      distConfig: Keypair.generate().publicKey,
      rwtClaimAta: Keypair.generate().publicKey,
      liquidityDest: Keypair.generate().publicKey,
      protocolRevenueDest: Keypair.generate().publicKey,
      ydConfig: Keypair.generate().publicKey,
      otMint: OT_MINT,
      ydDistributor: distributor,
      ydClaimStatus: deriveClaimStatusPda({
        distributor,
        claimant: rwtVault,
        ydProgramId: YD_PROGRAM,
      }),
      ydRewardVault: Keypair.generate().publicKey,
      cumulativeAmount: 1_000_000_000n,
      proof: [Buffer.alloc(32, 0xaa)],
    });
    expect(ix.programId.equals(RWT_ENGINE)).toBe(true);
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[0]!.pubkey.equals(crank)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(rwtVault)).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(OT_MINT)).toBe(true);
    expect(ix.data.subarray(0, 8).equals(RWT_CLAIM_YIELD_DISCRIMINATOR())).toBe(true);
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(ix.data.readUInt32LE(16)).toBe(1);
  });

  it('buildDexCompoundIx lays out 11 accounts in handler order', () => {
    const ix = buildDexCompoundIx({
      dexProgramId: DEX_PROGRAM,
      ydProgramId: YD_PROGRAM,
      crank: Keypair.generate().publicKey,
      poolState: POOL,
      targetVault: Keypair.generate().publicKey,
      ydConfig: Keypair.generate().publicKey,
      otMint: OT_MINT,
      ydDistributor: deriveDistributorPda(OT_MINT, YD_PROGRAM),
      ydClaimStatus: Keypair.generate().publicKey,
      ydRewardVault: Keypair.generate().publicKey,
      cumulativeAmount: 42n,
      proof: [],
    });
    expect(ix.programId.equals(DEX_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[1]!.pubkey.equals(POOL)).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
    expect(ix.data.subarray(0, 8).equals(DEX_COMPOUND_YIELD_DISCRIMINATOR())).toBe(true);
    expect(ix.data.readUInt32LE(16)).toBe(0);
  });

  it('buildOtTreasuryClaimIx lays out 12 accounts and supports cross-project mints', () => {
    const otMint = OT_MINT;
    const ydOtMint = Keypair.generate().publicKey;
    const otTreasury = deriveOtTreasuryPda(otMint, OT_PROGRAM);
    const ix = buildOtTreasuryClaimIx({
      otProgramId: OT_PROGRAM,
      ydProgramId: YD_PROGRAM,
      crank: Keypair.generate().publicKey,
      otMint,
      otTreasury,
      treasuryRwtAta: Keypair.generate().publicKey,
      ydConfig: Keypair.generate().publicKey,
      ydOtMint,
      ydDistributor: deriveDistributorPda(ydOtMint, YD_PROGRAM),
      ydClaimStatus: Keypair.generate().publicKey,
      ydRewardVault: Keypair.generate().publicKey,
      cumulativeAmount: 999n,
      proof: [],
    });
    expect(ix.programId.equals(OT_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(12);
    expect(ix.keys[1]!.pubkey.equals(otMint)).toBe(true);
    expect(ix.keys[5]!.pubkey.equals(ydOtMint)).toBe(true);
    expect(ix.data.subarray(0, 8).equals(OT_CLAIM_YD_FOR_TREASURY_DISCRIMINATOR())).toBe(true);
  });
});

describe('wrapClaimTx (compute budget)', () => {
  it('prepends two ComputeBudget ixs before the claim ix', () => {
    const claim = buildDexCompoundIx({
      dexProgramId: DEX_PROGRAM,
      ydProgramId: YD_PROGRAM,
      crank: Keypair.generate().publicKey,
      poolState: POOL,
      targetVault: POOL,
      ydConfig: POOL,
      otMint: OT_MINT,
      ydDistributor: POOL,
      ydClaimStatus: POOL,
      ydRewardVault: POOL,
      cumulativeAmount: 1n,
      proof: [],
    });
    const tx = wrapClaimTx({
      ix: claim,
      computeUnitLimit: 150_000,
      computeUnitPriceMicroLamports: 5_000,
    });
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions[0]!.programId.toBase58()).toBe(
      'ComputeBudget111111111111111111111111111111',
    );
    expect(tx.instructions[1]!.programId.toBase58()).toBe(
      'ComputeBudget111111111111111111111111111111',
    );
    expect(tx.instructions[2]!.programId.equals(DEX_PROGRAM)).toBe(true);
  });
});

describe('SingleFlightLock', () => {
  it('blocks duplicate keys until release', () => {
    const lock = new SingleFlightLock();
    expect(lock.acquire('vault:OT-A')).toBe(true);
    expect(lock.acquire('vault:OT-A')).toBe(false);
    lock.release('vault:OT-A');
    expect(lock.acquire('vault:OT-A')).toBe(true);
  });
});

describe('CheckpointStore', () => {
  let dbPath: string;
  let store: CheckpointStore;
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `claim-test-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* noop */
    }
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* noop */
    }
  });

  it('isNewer returns true on missing rows and false on equal/older epochs', () => {
    expect(store.isNewer('vault', 'OT-A', 5n)).toBe(true);
    store.upsert('vault', 'OT-A', 5n, null);
    expect(store.isNewer('vault', 'OT-A', 5n)).toBe(false);
    expect(store.isNewer('vault', 'OT-A', 6n)).toBe(true);
  });

  it('separate kinds are independent', () => {
    store.upsert('vault', 'X', 10n, null);
    expect(store.isNewer('pool', 'X', 5n)).toBe(true);
    expect(store.isNewer('treasury', 'X', 5n)).toBe(true);
  });
});

describe('decideClaim (D9 epoch gating)', () => {
  let store: CheckpointStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `decide-test-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });
  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* noop */
    }
  });

  it('skips when no proof file', () => {
    expect(
      decideClaim({ proof: null, checkpoint: store, kind: 'vault', key: 'OT-A' }),
    ).toMatchObject({ kind: 'skip', reason: 'no_proof' });
  });

  it('skips when proof epoch is not greater than checkpoint', () => {
    store.upsert('vault', 'OT-A', 7n, null);
    const proof = {
      claimant: 'X',
      distributor: 'D',
      epoch: 7,
      cumulativeAmount: '100',
      proof: [],
    };
    expect(
      decideClaim({ proof, checkpoint: store, kind: 'vault', key: 'OT-A' }),
    ).toMatchObject({ kind: 'skip', reason: 'epoch_stale' });
  });

  it('sends when proof epoch > checkpoint', () => {
    store.upsert('vault', 'OT-A', 5n, null);
    const proof = {
      claimant: 'X',
      distributor: 'D',
      epoch: 6,
      cumulativeAmount: '100',
      proof: [],
    };
    const decision = decideClaim({ proof, checkpoint: store, kind: 'vault', key: 'OT-A' });
    expect(decision.kind).toBe('send');
    if (decision.kind === 'send') {
      expect(decision.epoch).toBe(6n);
      expect(decision.cumulativeAmount).toBe(100n);
    }
  });
});

describe('ProofFetcher (filesystem)', () => {
  let proofDir: string;

  beforeEach(() => {
    proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofs-'));
  });
  afterEach(() => {
    fs.rmSync(proofDir, { recursive: true, force: true });
  });

  it('reads + parses a proof file from disk', async () => {
    const distributor = 'DISTABCDEFGHIJK';
    const claimant = 'CLAIM12345';
    fs.mkdirSync(path.join(proofDir, distributor));
    fs.writeFileSync(
      path.join(proofDir, distributor, `${claimant}.json`),
      JSON.stringify({
        claimant,
        distributor,
        epoch: 3,
        cumulativeAmount: '12345678',
        proof: ['0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32)],
      }),
    );
    const fetcher = new ProofFetcher({ kind: 'fs', baseDir: proofDir });
    const file = await fetcher.fetch(distributor, claimant);
    expect(file).not.toBeNull();
    expect(file!.epoch).toBe(3);
    expect(file!.cumulativeAmount).toBe('12345678');
    expect(file!.proof).toHaveLength(2);
  });

  it('returns null when the file does not exist', async () => {
    const fetcher = new ProofFetcher({ kind: 'fs', baseDir: proofDir });
    expect(await fetcher.fetch('no-such-distributor', 'no-such-claimant')).toBeNull();
  });
});

describe('parseProofJson', () => {
  it('accepts cumulative_amount as both string and number', () => {
    const a = parseProofJson(
      JSON.stringify({
        claimant: 'X',
        distributor: 'D',
        epoch: 1,
        cumulative_amount: '1000',
        proof: [],
      }),
    );
    expect(a.cumulativeAmount).toBe('1000');

    const b = parseProofJson(
      JSON.stringify({
        claimant: 'X',
        distributor: 'D',
        epoch: 1,
        cumulativeAmount: 999,
        proof: [],
      }),
    );
    expect(b.cumulativeAmount).toBe('999');
  });

  it('throws on missing fields', () => {
    expect(() =>
      parseProofJson(JSON.stringify({ epoch: 1, proof: [] })),
    ).toThrow();
  });
});

describe('decodeProofNodes', () => {
  it('decodes 32-byte hex with or without 0x prefix', () => {
    const nodes = decodeProofNodes(['0x' + 'ab'.repeat(32), 'cd'.repeat(32)]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.length).toBe(32);
    expect(nodes[0]!.every(b => b === 0xab)).toBe(true);
    expect(nodes[1]!.every(b => b === 0xcd)).toBe(true);
  });

  it('throws on wrong-length hex', () => {
    expect(() => decodeProofNodes(['ab'])).toThrow();
  });
});

describe('proofFileToArgs', () => {
  it('round-trips a proof file into (cumulativeAmount, proof[])', () => {
    const file = {
      claimant: 'X',
      distributor: 'D',
      epoch: 1,
      cumulativeAmount: '500000',
      proof: ['ab'.repeat(32), 'cd'.repeat(32)],
    };
    const args = proofFileToArgs(file);
    expect(args.cumulativeAmount).toBe(500_000n);
    expect(args.proof).toHaveLength(2);
  });
});

describe('parseRpcEndpoints (R29 integration)', () => {
  it('parses a single tuple with all fields', () => {
    const eps = parseRpcEndpoints('https://primary|wss://primary|100');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.url).toBe('https://primary');
    expect(eps[0]!.wsUrl).toBe('wss://primary');
    expect(eps[0]!.weight).toBe(100);
    expect(eps[0]!.failureCount).toBe(0);
  });

  it('parses comma-separated multi-endpoint list with optional ws/weight', () => {
    const eps = parseRpcEndpoints(
      'https://a|wss://a|100, https://b|wss://b|50, https://c',
    );
    expect(eps).toHaveLength(3);
    expect(eps[2]!.url).toBe('https://c');
    expect(eps[2]!.wsUrl).toBeUndefined();
    expect(eps[2]!.weight).toBe(1);
  });

  it('rejects empty input', () => {
    expect(() => parseRpcEndpoints('')).toThrow();
    expect(() => parseRpcEndpoints('   ')).toThrow();
  });

  it('rejects malformed weights', () => {
    expect(() => parseRpcEndpoints('https://a|wss://a|abc')).toThrow();
    expect(() => parseRpcEndpoints('https://a|wss://a|0')).toThrow();
  });
});

describe('CheckpointStore reconcile state (R31 integration)', () => {
  let dbPath: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `yield-claim-rec-${Date.now()}-${Math.random()}.db`);
    store = new CheckpointStore(dbPath);
  });

  afterEach(() => {
    try { store.close(); } catch { /* noop */ }
    try { fs.unlinkSync(dbPath); } catch { /* noop */ }
  });

  it('returns null for unseen programs (cold-start safety branch)', () => {
    expect(store.getLastSeenSlot('YD_PROG')).toBeNull();
  });

  it('round-trips highest-seen slot (monotonic upsert)', () => {
    store.setLastSeenSlot('YD_PROG', 1_000);
    expect(store.getLastSeenSlot('YD_PROG')).toBe(1_000);
    store.setLastSeenSlot('YD_PROG', 1_500);
    expect(store.getLastSeenSlot('YD_PROG')).toBe(1_500);
    store.setLastSeenSlot('YD_PROG', 800);
    expect(store.getLastSeenSlot('YD_PROG')).toBe(1_500);
  });
});
