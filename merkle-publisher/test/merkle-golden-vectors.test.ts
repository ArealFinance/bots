/**
 * Golden vectors — byte-for-byte compatibility between bot TS merkle and
 * on-chain Rust merkle.rs. Any drift here (e.g. hash algo change, endianness
 * flip, leaf layout refactor) will silently cause holders' proofs to fail
 * verification on-chain for multi-leaf trees. Single-leaf E2E catches nothing
 * because leaf == root. These vectors pin exact hex outputs.
 *
 * Fixture generation: test/fixtures/merkle-vectors.json was produced by a
 * one-time script using the same conventions as tree-builder.ts. If a spec
 * change requires re-generation, the fixture MUST also be updated in the
 * Rust-side test (cross-language check) and this test MUST still pass.
 *
 * @see Layer 7 tester review §"Missing Tests" C5
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildTree, computeLeaf } from '../src/tree-builder.js';
import type { LeafMap } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures/merkle-vectors.json');

interface LeafCase {
  claimant: string;
  cumulativeAmount: string;
  leafHex: string;
}

interface TreeCase {
  description: string;
  entries: Array<{ claimant: string; cumulativeAmount: string }>;
  rootHex: string;
  leafOrderHex: string[];
}

interface Fixture {
  note: string;
  cases: LeafCase[];
  trees: TreeCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('merkle golden vectors — leaf hashes', () => {
  for (const c of fixture.cases) {
    it(`computeLeaf(${c.claimant.slice(0, 8)}…, ${c.cumulativeAmount}) matches pinned hex`, () => {
      const leaf = computeLeaf(c.claimant, BigInt(c.cumulativeAmount));
      expect(toHex(leaf)).toBe(c.leafHex);
      expect(leaf.length).toBe(32);
    });
  }
});

describe('merkle golden vectors — tree roots', () => {
  for (const t of fixture.trees) {
    it(`buildTree produces pinned root for "${t.description}"`, () => {
      const leafMap: LeafMap = new Map(
        t.entries.map(e => [e.claimant, BigInt(e.cumulativeAmount)] as const),
      );
      const { root } = buildTree(leafMap);
      expect(toHex(root)).toBe(t.rootHex);
    });
  }

  it('sorts leaves deterministically regardless of input map insertion order', () => {
    // Reverse the entries of one of the golden trees. Sorted order is by
    // pubkey bytes inside buildTree — so the resulting root must be identical.
    const t = fixture.trees.find(x => x.entries.length >= 3);
    if (!t) return;
    const reversed: LeafMap = new Map(
      [...t.entries].reverse().map(e => [e.claimant, BigInt(e.cumulativeAmount)] as const),
    );
    const { root } = buildTree(reversed);
    expect(toHex(root)).toBe(t.rootHex);
  });
});
