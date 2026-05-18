import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { BuiltTree, LeafMap, Snapshot } from './types.js';

/**
 * Per-deposit snapshot aggregation + canonical SHA-256 merkle tree.
 *
 * Must remain byte-for-byte compatible with the on-chain verifier in
 * `contracts/yield-distribution/src/merkle.rs`:
 *
 *   leaf   = sha256(claimant_pubkey_bytes || cumulative_amount_le_bytes)
 *   parent = sha256(min(left, right) || max(left, right))   [canonical, lower first]
 *
 * "lower-first" means byte-level unsigned comparison of 32-byte hashes.
 */

/**
 * Aggregate all snapshots into per-holder cumulative amounts.
 *
 * For each snapshot i, each eligible holder h receives:
 *   share_i(h) = floor(deposit_amount_i * balance_i(h) / total_eligible_i)
 *
 * The remainder (deposit_amount_i - Σ share) is added to the SPRK OT Treasury
 * leaf (matching contract spec: residual yield becomes protocol revenue).
 *
 * NOTE on gross vs net: `snap.depositAmount` is the NET amount that actually
 * landed in the reward vault (= gross - protocol_fee). The on-chain
 * `MerkleDistributor.total_funded` accumulates NET across fund events. The
 * invariant `Σ snap.depositAmount == distributor.total_funded` must therefore
 * hold; see `event-watcher.ts` for how NET is computed from the event body.
 */
export function aggregateSnapshots(
  snapshots: Snapshot[],
  sprkOtTreasury: PublicKey,
): LeafMap {
  const cumulative: LeafMap = new Map();
  let totalAllocated = 0n;
  let totalFunded = 0n;

  for (const snap of snapshots) {
    totalFunded += snap.depositAmount;

    if (snap.totalEligible === 0n) {
      // No eligible holder at this snapshot — 100% of the deposit goes to SPRK Treasury.
      const key = sprkOtTreasury.toBase58();
      cumulative.set(key, (cumulative.get(key) ?? 0n) + snap.depositAmount);
      totalAllocated += snap.depositAmount;
      continue;
    }

    let snapAllocated = 0n;
    for (const b of snap.balances) {
      if (b.eligible !== 1) continue;
      // Integer math matching on-chain u64 mul_div.
      const share = (snap.depositAmount * b.balance) / snap.totalEligible;
      if (share === 0n) continue;
      cumulative.set(b.holder, (cumulative.get(b.holder) ?? 0n) + share);
      snapAllocated += share;
    }

    // Per-snapshot rounding remainder → SPRK Treasury.
    const snapRemainder = snap.depositAmount - snapAllocated;
    if (snapRemainder > 0n) {
      const key = sprkOtTreasury.toBase58();
      cumulative.set(key, (cumulative.get(key) ?? 0n) + snapRemainder);
    }
    totalAllocated += snapAllocated + snapRemainder;
  }

  // Invariant check — per-snapshot allocation must fully account for total_funded.
  if (totalAllocated !== totalFunded) {
    throw new Error(
      `aggregateSnapshots invariant violated: allocated=${totalAllocated} totalFunded=${totalFunded}`,
    );
  }

  return cumulative;
}

/** Computes leaf = sha256(pubkey_bytes || cumulative_le_bytes). */
export function computeLeaf(holder: string, cumulativeAmount: bigint): Uint8Array {
  const pk = new PublicKey(holder).toBytes();
  const leBytes = u64ToLeBytes(cumulativeAmount);
  const h = createHash('sha256');
  h.update(pk);
  h.update(leBytes);
  return h.digest();
}

/**
 * Encodes a u64 (non-negative bigint < 2^64) as 8 little-endian bytes.
 * Throws on negative input or overflow.
 */
export function u64ToLeBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error(`u64ToLeBytes: negative ${v}`);
  if (v >= 1n << 64n) throw new Error(`u64ToLeBytes: overflow ${v}`);
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Canonical parent = sha256(min(a,b) || max(a,b)) by byte-level unsigned compare.
 */
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const h = createHash('sha256');
  h.update(lo);
  h.update(hi);
  return h.digest();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  // Explicit -1/+1 return avoids any sign-subtraction footgun in mixed-type
  // comparators; byte difference is always 0–255 but style is clearer here.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Build a binary merkle tree from per-holder leaves with canonical sibling
 * ordering (lower-hash-first). Returns root + proof-paths.
 *
 * Structure:
 *   - Leaves are sorted by holder pubkey bytes (deterministic order).
 *   - If a level has odd count, the last node is duplicated — common pattern
 *     that matches the on-chain verifier because the duplicate's hash equals
 *     itself, so `hashPair(x, x)` is well-defined regardless of ordering.
 *   - Proofs are the sibling chain from leaf index up to root.
 */
export function buildTree(leaves: LeafMap): BuiltTree {
  if (leaves.size === 0) {
    // Empty tree: define root = zeroed hash, no proofs. Matches `EMPTY_ROOT`
    // constant in contract when no holder ever qualified.
    return { root: new Uint8Array(32), proofs: new Map() };
  }

  // 1. Deterministic holder ordering — sort by pubkey bytes.
  const entries = Array.from(leaves.entries()).map(([holder, amount]) => ({
    holder,
    amount,
    pubkeyBytes: new PublicKey(holder).toBytes(),
  }));
  entries.sort((x, y) => compareBytes(x.pubkeyBytes, y.pubkeyBytes));

  // 2. Leaf layer.
  const leafHashes: Uint8Array[] = entries.map(e => computeLeaf(e.holder, e.amount));

  if (leafHashes.length === 1) {
    // Single leaf — root equals leaf, no proof needed.
    return {
      root: leafHashes[0]!,
      proofs: new Map([[entries[0]!.holder, []]]),
    };
  }

  // 3. Store level by level so we can walk up per-leaf for proof construction.
  const levels: Uint8Array[][] = [leafHashes];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i]!;
      const right = i + 1 < prev.length ? prev[i + 1]! : prev[i]!; // duplicate last on odd
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }

  const root = levels[levels.length - 1]![0]!;

  // 4. Per-leaf proof: for each level, the sibling at (index XOR 1), walking up.
  const proofs = new Map<string, Uint8Array[]>();
  for (let i = 0; i < entries.length; i++) {
    const path: Uint8Array[] = [];
    let idx = i;
    for (let level = 0; level < levels.length - 1; level++) {
      const layer = levels[level]!;
      const siblingIdx = idx ^ 1;
      const sibling = siblingIdx < layer.length ? layer[siblingIdx]! : layer[idx]!; // self-dup
      path.push(sibling);
      idx = idx >> 1;
    }
    proofs.set(entries[i]!.holder, path);
  }

  return { root, proofs };
}

/**
 * Locally verify a proof against a root — mirrors the on-chain verifier.
 * Used in tests + defensive double-check before submitting on-chain.
 */
export function verifyProof(
  holder: string,
  cumulativeAmount: bigint,
  proof: Uint8Array[],
  root: Uint8Array,
): boolean {
  let current = computeLeaf(holder, cumulativeAmount);
  for (const sibling of proof) {
    current = hashPair(current, sibling);
  }
  return compareBytes(current, root) === 0;
}
