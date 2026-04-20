import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HolderProof, LeafMap } from './types.js';
import type { KmsSigner } from './kms-signer.js';
import { logger } from './logger.js';

/**
 * File-based proof storage.
 *
 * Layout (production — served by claim UIs):
 *   <proofDir>/<distributor>/<holder>.json     — per-holder proof (claim-UI consumer)
 *   <proofDir>/<distributor>/_index.json       — manifest: root, epoch, leaf count, signerPubkey
 *   <proofDir>/<distributor>/_index.sig        — raw 64-byte ed25519 signature of _index.json bytes
 *
 * Layout (staging — isolated per-epoch until tx confirms):
 *   <proofDir>/_staging/<distributor>/<epoch>/<holder>.json
 *   <proofDir>/_staging/<distributor>/<epoch>/_index.json
 *   <proofDir>/_staging/<distributor>/<epoch>/_index.sig
 *
 * Rationale: claim UIs fetch `<distributor>/<wallet>.json` over plain HTTP —
 * simple static hosting (S3, IPFS pin, nginx) works without any API server.
 *
 * Atomicity: write to `*.tmp`, then rename. Partial files are never visible.
 *
 * Two-phase sequencing (NEW-M-3):
 *   1. `writeProofsToStaging(distributor, epoch, ...)` — writes the full new
 *      epoch into an isolated staging dir. Production dir is untouched.
 *   2. After the on-chain `publish_root` tx confirms, call
 *      `promoteStagedProofs(distributor, epoch)` — copies staged files over
 *      the production directory via atomic per-file rename. If tx fails,
 *      staging sits harmlessly on disk and will be swept at next startup.
 *   3. `sweepStaleStaging(isEpochPublished)` at bootstrap deletes any staging
 *      epochs whose publish never completed (not in `publishes` table).
 *
 * Why this matters: if proofs were written in a single step BEFORE tx confirm,
 * a tx failure would leave the production dir advertising `epoch = N+1`
 * while the chain still holds `epoch = N`. Claim UIs would hand holders
 * invalid proofs for the full retry cycle (up to 10 min).
 *
 * Integrity (M-4): the manifest is signed with the same KMS key that signs
 * `publish_root`. Claim UIs can verify the signature against the
 * chain-authoritative publish_authority before trusting any per-holder file.
 */
export class ProofStore {
  private readonly stagingRootDir: string;

  constructor(
    private readonly rootDir: string,
    private readonly signer: KmsSigner | null = null,
  ) {
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    this.stagingRootDir = path.join(rootDir, '_staging');
    if (!fs.existsSync(this.stagingRootDir)) {
      fs.mkdirSync(this.stagingRootDir, { recursive: true });
    }
  }

  private distDir(distributor: string): string {
    return path.join(this.rootDir, distributor);
  }

  private stagingDistDir(distributor: string): string {
    return path.join(this.stagingRootDir, distributor);
  }

  private stagingEpochDir(distributor: string, epoch: number): string {
    return path.join(this.stagingDistDir(distributor), String(epoch));
  }

  /**
   * Phase 1 (NEW-M-3): write the full new epoch into an isolated staging
   * directory. The production `<distributor>/` directory is left alone —
   * existing proofs stay valid for the chain's current root while we submit
   * the new one.
   *
   * Legacy alias `writeProofs` remains for callers that don't need staging.
   */
  async writeProofsToStaging(
    distributor: string,
    epoch: number,
    root: Uint8Array,
    leafMap: LeafMap,
    proofs: Map<string, Uint8Array[]>,
  ): Promise<void> {
    const dir = this.stagingEpochDir(distributor, epoch);
    // Fresh dir — clean any prior failed staging for this epoch.
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });

    await this.writeProofsInto(dir, distributor, epoch, root, leafMap, proofs);
  }

  /**
   * Phase 2 (NEW-M-3): promote a staged epoch to production. Copies each
   * staged file to the production dir via atomic per-file rename, then
   * removes the staging dir. Safe to call multiple times (idempotent).
   *
   * Called AFTER the corresponding `publish_root` tx is confirmed on-chain.
   */
  promoteStagedProofs(distributor: string, epoch: number): void {
    const stagedDir = this.stagingEpochDir(distributor, epoch);
    if (!fs.existsSync(stagedDir)) {
      logger.warn('promoteStagedProofs: staging dir missing (already promoted?)', {
        distributor,
        epoch,
      });
      return;
    }
    const prodDir = this.distDir(distributor);
    if (!fs.existsSync(prodDir)) fs.mkdirSync(prodDir, { recursive: true });

    const entries = fs.readdirSync(stagedDir);
    for (const name of entries) {
      const from = path.join(stagedDir, name);
      const to = path.join(prodDir, name);
      // rename is atomic within the same filesystem. If a previous holder
      // file exists, rename replaces it atomically. This preserves the
      // "readers never see a partial file" invariant throughout the promote.
      fs.renameSync(from, to);
    }

    // Remove the now-empty staging epoch dir.
    try {
      fs.rmdirSync(stagedDir);
    } catch {
      // Not fatal — best-effort cleanup.
      fs.rmSync(stagedDir, { recursive: true, force: true });
    }
    logger.info('proofs promoted to production', { distributor, epoch });
  }

  /**
   * NEW-M-3 bootstrap hook: delete any staging directories whose publish
   * never completed. `isEpochPublished` is invoked per (distributor, epoch)
   * and must return `true` iff a matching row exists in `publishes` (i.e.
   * the publish_root tx actually confirmed).
   *
   * Call at startup, BEFORE any new publish runs, to avoid leaking pending
   * epochs from crashes of prior runs.
   */
  sweepStaleStaging(isEpochPublished: (distributor: string, epoch: number) => boolean): void {
    if (!fs.existsSync(this.stagingRootDir)) return;
    const distributors = fs.readdirSync(this.stagingRootDir);
    let deleted = 0;
    for (const dist of distributors) {
      const distDir = path.join(this.stagingRootDir, dist);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(distDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const epochs = fs.readdirSync(distDir);
      for (const epStr of epochs) {
        const ep = Number(epStr);
        if (!Number.isFinite(ep) || ep < 0) continue;
        if (!isEpochPublished(dist, ep)) {
          const epochDir = path.join(distDir, epStr);
          fs.rmSync(epochDir, { recursive: true, force: true });
          deleted += 1;
          logger.info('sweepStaleStaging: removed un-published staging', {
            distributor: dist,
            epoch: ep,
          });
        }
      }
      // Best-effort: remove the distributor subdir if empty.
      try {
        const remaining = fs.readdirSync(distDir);
        if (remaining.length === 0) fs.rmdirSync(distDir);
      } catch {
        /* ignore */
      }
    }
    if (deleted > 0) {
      logger.info('sweepStaleStaging complete', { deletedEpochs: deleted });
    }
  }

  /**
   * Legacy write-direct-to-production API. Retained for backward compatibility
   * (and for tests that don't need two-phase behavior). Prefer the
   * staging → promote pair for any path that submits an on-chain tx.
   */
  async writeProofs(
    distributor: string,
    epoch: number,
    root: Uint8Array,
    leafMap: LeafMap,
    proofs: Map<string, Uint8Array[]>,
  ): Promise<void> {
    const dir = this.distDir(distributor);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await this.writeProofsInto(dir, distributor, epoch, root, leafMap, proofs);
  }

  /** Shared implementation for both staging and direct writes. */
  private async writeProofsInto(
    dir: string,
    distributor: string,
    epoch: number,
    root: Uint8Array,
    leafMap: LeafMap,
    proofs: Map<string, Uint8Array[]>,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const merkleRootHex = Buffer.from(root).toString('hex');
    let count = 0;

    for (const [holder, cumulativeAmount] of leafMap.entries()) {
      const proof = proofs.get(holder) ?? [];
      const out: HolderProof = {
        distributor,
        epoch,
        holder,
        cumulativeAmount: cumulativeAmount.toString(),
        proof: proof.map(p => Buffer.from(p).toString('hex')),
        merkleRoot: merkleRootHex,
        publishedAt: now,
      };
      this.atomicWrite(path.join(dir, `${holder}.json`), JSON.stringify(out, null, 2));
      count += 1;
    }

    const manifest: Record<string, unknown> = {
      distributor,
      epoch,
      merkleRoot: merkleRootHex,
      leafCount: count,
      publishedAt: now,
    };
    if (this.signer) {
      manifest.signerPubkey = this.signer.publicKey.toBase58();
    }
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestPath = path.join(dir, '_index.json');
    this.atomicWrite(manifestPath, manifestJson);

    // M-4: sign manifest bytes with the KMS key. Signature is raw 64-byte
    // ed25519 — claim UIs can verify via nacl.sign.detached.verify.
    if (this.signer) {
      try {
        const signature = await this.signer.signRaw(Buffer.from(manifestJson, 'utf-8'));
        this.atomicWriteBinary(path.join(dir, '_index.sig'), Buffer.from(signature));
      } catch (err) {
        logger.error('failed to sign _index.json — claim UIs will not trust it', err, {
          distributor,
          epoch,
        });
        throw err;
      }
    }

    logger.info('proofs written', {
      distributor,
      epoch,
      count,
      signed: this.signer !== null,
      dir,
    });
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, filePath);
  }

  private atomicWriteBinary(filePath: string, content: Buffer): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, filePath);
  }
}
