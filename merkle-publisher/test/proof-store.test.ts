/**
 * ProofStore atomic write tests.
 *
 * Claim UIs poll the <proofDir>/<distributor>/<holder>.json files during
 * normal operation; a partial/corrupt file must NEVER be observable by a
 * reader, even if the publisher process crashes mid-write.
 *
 * The implementation uses a `*.tmp` + `rename` pattern. We simulate a crash
 * by stubbing `fs.renameSync` to throw AFTER a successful `writeFileSync` —
 * then verify the real file does not exist.
 *
 * @see plan/layer-07-review-tester.md §"Missing Tests" H4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProofStore } from '../src/proof-store.js';
import type { LeafMap } from '../src/types.js';
import { Keypair } from '@solana/web3.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proof-store-test-'));
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('ProofStore', () => {
  let dir: string;
  let store: ProofStore;

  beforeEach(() => {
    dir = mkTempDir();
    store = new ProofStore(dir);
  });

  afterEach(() => {
    cleanup(dir);
    vi.restoreAllMocks();
  });

  it('writes per-holder proof + manifest atomically (happy path)', async () => {
    const dist = Keypair.generate().publicKey.toBase58();
    const holder = Keypair.generate().publicKey.toBase58();
    const leafMap: LeafMap = new Map([[holder, 123n]]);
    const proofs = new Map<string, Uint8Array[]>([[holder, []]]);
    const root = new Uint8Array(32).fill(0xAB);

    await store.writeProofs(dist, 1, root, leafMap, proofs);

    const holderPath = path.join(dir, dist, `${holder}.json`);
    const indexPath = path.join(dir, dist, '_index.json');
    expect(fs.existsSync(holderPath)).toBe(true);
    expect(fs.existsSync(indexPath)).toBe(true);

    // No stray .tmp files.
    const entries = fs.readdirSync(path.join(dir, dist));
    expect(entries.filter(f => f.endsWith('.tmp'))).toHaveLength(0);

    const holderContent = JSON.parse(fs.readFileSync(holderPath, 'utf-8'));
    expect(holderContent.distributor).toBe(dist);
    expect(holderContent.epoch).toBe(1);
    expect(holderContent.cumulativeAmount).toBe('123');
    expect(holderContent.merkleRoot).toBe('ab'.repeat(32));
  });

  it('consumer never sees a partial JSON when rename fails mid-write', async () => {
    // We simulate a crash by making the target filename unrenameable.
    // Approach: create a DIRECTORY at the target path before writeProofs runs.
    // fs.renameSync(tmp → dir) will throw EISDIR / ENOTEMPTY, mimicking a
    // mid-write failure. This avoids vi.spyOn limitations on ESM fs exports.
    const dist = Keypair.generate().publicKey.toBase58();
    const holder = Keypair.generate().publicKey.toBase58();
    const leafMap: LeafMap = new Map([[holder, 456n]]);
    const proofs = new Map<string, Uint8Array[]>([[holder, []]]);
    const root = new Uint8Array(32).fill(0xEE);

    const distDirPath = path.join(dir, dist);
    fs.mkdirSync(distDirPath, { recursive: true });
    const holderTargetPath = path.join(distDirPath, `${holder}.json`);
    // Put a non-empty directory at the target so rename of tmp->target fails.
    fs.mkdirSync(holderTargetPath);
    fs.writeFileSync(path.join(holderTargetPath, 'block.txt'), 'block');

    await expect(store.writeProofs(dist, 2, root, leafMap, proofs)).rejects.toBeDefined();

    // Target path is still the blocking directory — it was never replaced
    // with a partial JSON file.
    expect(fs.statSync(holderTargetPath).isDirectory()).toBe(true);
    // The _index.json manifest must also not exist (write of per-holder
    // file failed first, so we never got to manifest).
    expect(fs.existsSync(path.join(distDirPath, '_index.json'))).toBe(false);
  });

  it('overwrites prior epoch file atomically on re-publish', async () => {
    const dist = Keypair.generate().publicKey.toBase58();
    const holder = Keypair.generate().publicKey.toBase58();
    const root1 = new Uint8Array(32).fill(0x11);
    const root2 = new Uint8Array(32).fill(0x22);

    await store.writeProofs(dist, 1, root1, new Map([[holder, 100n]]), new Map([[holder, []]]));
    await store.writeProofs(dist, 2, root2, new Map([[holder, 200n]]), new Map([[holder, []]]));

    const holderPath = path.join(dir, dist, `${holder}.json`);
    const content = JSON.parse(fs.readFileSync(holderPath, 'utf-8'));
    expect(content.epoch).toBe(2);
    expect(content.cumulativeAmount).toBe('200');
    expect(content.merkleRoot).toBe('22'.repeat(32));
  });

  it('handles multi-holder write (writes every leaf exactly once)', async () => {
    const dist = Keypair.generate().publicKey.toBase58();
    const h1 = Keypair.generate().publicKey.toBase58();
    const h2 = Keypair.generate().publicKey.toBase58();
    const h3 = Keypair.generate().publicKey.toBase58();
    const root = new Uint8Array(32).fill(0x77);

    await store.writeProofs(
      dist,
      3,
      root,
      new Map([[h1, 1n], [h2, 2n], [h3, 3n]]),
      new Map([[h1, []], [h2, []], [h3, []]]),
    );

    const files = fs.readdirSync(path.join(dir, dist));
    // 3 holder files + _index.json
    expect(files.sort()).toEqual([`${h1}.json`, `${h2}.json`, `${h3}.json`, '_index.json'].sort());

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, dist, '_index.json'), 'utf-8'));
    expect(manifest.leafCount).toBe(3);
    expect(manifest.epoch).toBe(3);
  });
});
