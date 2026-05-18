import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  aggregateSnapshots,
  buildTree,
  computeLeaf,
  u64ToLeBytes,
  verifyProof,
} from '../src/tree-builder.js';
import type { Snapshot } from '../src/types.js';

/** Helper to make a snapshot with simple {holder → balance} map. */
function snap(
  distributor: string,
  depositEpoch: number,
  depositAmount: bigint,
  balances: Array<{ holder: string; balance: bigint; eligible?: 0 | 1 }>,
  totalFundedAtEvent?: bigint,
): Snapshot {
  const totalEligible = balances
    .filter(b => (b.eligible ?? 1) === 1)
    .reduce((s, b) => s + b.balance, 0n);
  return {
    distributor,
    depositEpoch,
    depositAmount,
    totalFundedAtEvent: totalFundedAtEvent ?? depositAmount,
    slot: 1000 + depositEpoch,
    fundTs: 1_700_000_000 + depositEpoch,
    txSignature: `sig-${distributor}-${depositEpoch}`,
    totalEligible,
    eventKind: 'DistributorFunded',
    balances: balances.map(b => ({ holder: b.holder, balance: b.balance, eligible: b.eligible ?? 1 })),
  };
}

describe('u64ToLeBytes', () => {
  it('encodes 0 as eight zeros', () => {
    expect(Array.from(u64ToLeBytes(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('encodes 1 in little-endian', () => {
    expect(Array.from(u64ToLeBytes(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('encodes max u64', () => {
    const max = (1n << 64n) - 1n;
    expect(Array.from(u64ToLeBytes(max))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });

  it('throws on negative input', () => {
    expect(() => u64ToLeBytes(-1n)).toThrow();
  });

  it('throws on overflow', () => {
    expect(() => u64ToLeBytes(1n << 64n)).toThrow();
  });
});

describe('computeLeaf', () => {
  it('produces a deterministic 32-byte digest', () => {
    const kp = Keypair.generate();
    const a = computeLeaf(kp.publicKey.toBase58(), 1000n);
    const b = computeLeaf(kp.publicKey.toBase58(), 1000n);
    expect(a.length).toBe(32);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('changes with different cumulative amounts', () => {
    const kp = Keypair.generate();
    const a = computeLeaf(kp.publicKey.toBase58(), 1000n);
    const b = computeLeaf(kp.publicKey.toBase58(), 1001n);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });
});

describe('aggregateSnapshots — Alice→Bob fairness', () => {
  // Per architecture spec §6.10 fairness scenario.
  // T0: Alice is the only holder; deposit = 1000.
  // T1: Bob is the only holder; deposit = 500.
  // Expected cumulative:
  //   Alice = 1000 (from snap 1) + 0 (absent from snap 2) = 1000
  //   Bob   = 0    (absent from snap 1) + 500 (from snap 2) = 500
  // Naive current-balance snapshot would give Bob ~1000 — caught by this test.

  const distributor = Keypair.generate().publicKey.toBase58();
  const arlTreasury = Keypair.generate().publicKey;
  const alice = Keypair.generate().publicKey.toBase58();
  const bob = Keypair.generate().publicKey.toBase58();

  it('allocates each deposit only to holders present at that snapshot', () => {
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 1000n, [{ holder: alice, balance: 100n }]),
      snap(distributor, 1, 500n, [{ holder: bob, balance: 100n }]),
    ];

    const cumulative = aggregateSnapshots(snapshots, arlTreasury);

    expect(cumulative.get(alice)).toBe(1000n);
    expect(cumulative.get(bob)).toBe(500n);
    // Total must equal sum of all deposits.
    const total = [...cumulative.values()].reduce((s, x) => s + x, 0n);
    expect(total).toBe(1500n);
  });

  it('proportionally splits when both holders are eligible at snap 2', () => {
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 1000n, [{ holder: alice, balance: 100n }]),
      snap(distributor, 1, 500n, [
        { holder: alice, balance: 100n },
        { holder: bob, balance: 100n },
      ]),
    ];

    const cumulative = aggregateSnapshots(snapshots, arlTreasury);

    // Alice: 1000 (sole owner snap 1) + 250 (50% of 500 in snap 2) = 1250
    // Bob:   0   (absent snap 1)     + 250 (50% of 500 in snap 2) = 250
    expect(cumulative.get(alice)).toBe(1250n);
    expect(cumulative.get(bob)).toBe(250n);
    const total = [...cumulative.values()].reduce((s, x) => s + x, 0n);
    expect(total).toBe(1500n);
  });

  it('routes 100% to SPRK Treasury when no eligible holders at snapshot', () => {
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 1000n, []), // no holders at all
    ];

    const cumulative = aggregateSnapshots(snapshots, arlTreasury);
    expect(cumulative.get(arlTreasury.toBase58())).toBe(1000n);
  });

  it('routes non-eligible balance share to SPRK Treasury', () => {
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 1000n, [
        { holder: alice, balance: 100n, eligible: 1 },
        { holder: bob, balance: 100n, eligible: 0 }, // below threshold
      ]),
    ];

    const cumulative = aggregateSnapshots(snapshots, arlTreasury);
    // total_eligible = 100 (only Alice). Alice gets 1000 * 100 / 100 = 1000.
    expect(cumulative.get(alice)).toBe(1000n);
    expect(cumulative.get(bob)).toBeUndefined();
  });

  it('moves rounding remainder to SPRK Treasury', () => {
    // deposit=10, two holders each holding 1 OT → share = 10*1/2 = 5 each → no remainder.
    // Make remainder appear: deposit=10, three holders 1 each → share = 10*1/3 = 3 each → 1 remainder.
    const c = Keypair.generate().publicKey.toBase58();
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 10n, [
        { holder: alice, balance: 1n },
        { holder: bob, balance: 1n },
        { holder: c, balance: 1n },
      ]),
    ];
    const cumulative = aggregateSnapshots(snapshots, arlTreasury);
    expect(cumulative.get(alice)).toBe(3n);
    expect(cumulative.get(bob)).toBe(3n);
    expect(cumulative.get(c)).toBe(3n);
    expect(cumulative.get(arlTreasury.toBase58())).toBe(1n);
    const total = [...cumulative.values()].reduce((s, x) => s + x, 0n);
    expect(total).toBe(10n);
  });
});

describe('buildTree + verifyProof', () => {
  const distributor = Keypair.generate().publicKey.toBase58();
  const arlTreasury = Keypair.generate().publicKey;

  it('produces single-leaf tree with empty proof', () => {
    const alice = Keypair.generate().publicKey.toBase58();
    const leaves = new Map([[alice, 1000n]]);
    const { root, proofs } = buildTree(leaves);
    expect(root.length).toBe(32);
    expect(proofs.get(alice)).toEqual([]);
    expect(verifyProof(alice, 1000n, [], root)).toBe(true);
  });

  it('verifies proofs for all holders in a multi-leaf tree', () => {
    const holders = Array.from({ length: 7 }, () => Keypair.generate().publicKey.toBase58());
    const leaves = new Map(holders.map((h, i) => [h, BigInt(100 * (i + 1))]));
    const { root, proofs } = buildTree(leaves);
    for (const [holder, amount] of leaves) {
      const proof = proofs.get(holder)!;
      expect(verifyProof(holder, amount, proof, root)).toBe(true);
    }
  });

  it('rejects a proof with wrong cumulative amount', () => {
    const holders = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    const leaves = new Map(holders.map((h, i) => [h, BigInt(100 * (i + 1))]));
    const { root, proofs } = buildTree(leaves);
    const target = holders[0]!;
    const proof = proofs.get(target)!;
    expect(verifyProof(target, leaves.get(target)! + 1n, proof, root)).toBe(false);
  });

  it('rejects a proof for a different claimant', () => {
    const holders = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    const leaves = new Map(holders.map((h, i) => [h, BigInt(100 * (i + 1))]));
    const { root, proofs } = buildTree(leaves);
    const a = holders[0]!;
    const b = holders[1]!;
    const proofForA = proofs.get(a)!;
    expect(verifyProof(b, leaves.get(b)!, proofForA, root)).toBe(false);
  });

  // CRIT-1 regression — snapshots must use NET amount (gross - fee), and the
  // resulting Σ depositAmount must equal the authoritative totalFundedAtEvent
  // of the most recent snapshot. This is what `publish_root` will compare
  // against on-chain; any drift = InvalidMaxClaim revert.
  it('sum(depositAmount) equals last snapshot totalFundedAtEvent when fees are non-zero', () => {
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    // Simulate two fund events with a 0.2% protocol fee:
    //   event 1: gross=1000, fee=2, net=998, totalFunded_after=998
    //   event 2: gross= 500, fee=1, net=499, totalFunded_after=1497
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 998n, [{ holder: alice, balance: 100n }], 998n),
      snap(distributor, 1, 499n, [{ holder: bob, balance: 100n }], 1497n),
    ];
    const cumulative = aggregateSnapshots(snapshots, arlTreasury);
    const total = [...cumulative.values()].reduce((s, x) => s + x, 0n);

    // Σ net shares must equal Σ depositAmount (= sum of nets).
    expect(total).toBe(998n + 499n);
    // And Σ nets must equal the chain-authoritative total_funded after the
    // second event — the publisher uses this as max_total_claim.
    const maxTotalFunded = snapshots.reduce(
      (s, x) => (x.totalFundedAtEvent > s ? x.totalFundedAtEvent : s),
      0n,
    );
    expect(total).toBe(maxTotalFunded);
    expect(maxTotalFunded).toBe(1497n);
  });

  it('end-to-end Alice→Bob fairness — aggregate then build tree', () => {
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const snapshots: Snapshot[] = [
      snap(distributor, 0, 1000n, [{ holder: alice, balance: 100n }]),
      snap(distributor, 1, 500n, [{ holder: bob, balance: 100n }]),
    ];
    const cumulative = aggregateSnapshots(snapshots, arlTreasury);
    const { root, proofs } = buildTree(cumulative);

    // Alice's proof must verify her exact cumulative; Bob's likewise.
    expect(verifyProof(alice, 1000n, proofs.get(alice)!, root)).toBe(true);
    expect(verifyProof(bob, 500n, proofs.get(bob)!, root)).toBe(true);

    // Bob cannot use Alice's proof to claim 1000.
    expect(verifyProof(bob, 1000n, proofs.get(alice)!, root)).toBe(false);
  });
});
