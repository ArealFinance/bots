import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProofSource } from './config.js';
import type { ProofFile } from './types.js';
import { logger } from './logger.js';

/**
 * Read a Merkle proof file emitted by the merkle-publisher proof store.
 *
 * Path convention (mirrors `bots/merkle-publisher/src/proof-store.ts`):
 *   <PROOF_DIR>/<distributor_pda>/<claimant_pda>.json
 *   GET <PROOF_BASE_URL>/<distributor_pda>/<claimant_pda>.json
 *
 * Returns `null` if the file does not exist (claimant has nothing to claim
 * yet — happens on cold-start and after fully drained streams).
 */
export class ProofFetcher {
  constructor(private readonly source: ProofSource) {}

  async fetch(distributor: string, claimant: string): Promise<ProofFile | null> {
    if (this.source.kind === 'fs') {
      const file = path.join(this.source.baseDir, distributor, `${claimant}.json`);
      if (!fs.existsSync(file)) return null;
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        return parseProofJson(raw);
      } catch (err) {
        logger.warn('proof file unreadable', { file, err: String(err) });
        return null;
      }
    } else {
      // HTTP
      const url = `${this.source.baseUrl.replace(/\/+$/, '')}/${distributor}/${claimant}.json`;
      try {
        const resp = await fetch(url);
        if (resp.status === 404) return null;
        if (!resp.ok) {
          logger.warn('proof HTTP fetch non-ok', { url, status: resp.status });
          return null;
        }
        const raw = await resp.text();
        return parseProofJson(raw);
      } catch (err) {
        logger.warn('proof HTTP fetch failed', { url, err: String(err) });
        return null;
      }
    }
  }
}

/**
 * Parse + validate proof JSON. Pure function for unit tests.
 *
 * Accepts proof nodes either with or without `0x` prefix. Throws on malformed
 * input — caller should treat thrown errors the same as missing-file.
 */
export function parseProofJson(raw: string): ProofFile {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  if (typeof obj.claimant !== 'string') throw new Error('proof: missing/invalid claimant');
  if (typeof obj.distributor !== 'string') throw new Error('proof: missing/invalid distributor');
  if (typeof obj.epoch !== 'number') throw new Error('proof: missing/invalid epoch');
  // cumulative_amount may serialize as either string (the right call for u64)
  // or number (legacy publishers); accept both.
  let cumulativeAmount: string;
  if (typeof obj.cumulativeAmount === 'string') {
    cumulativeAmount = obj.cumulativeAmount;
  } else if (typeof obj.cumulative_amount === 'string') {
    cumulativeAmount = obj.cumulative_amount as string;
  } else if (typeof obj.cumulativeAmount === 'number') {
    cumulativeAmount = String(obj.cumulativeAmount);
  } else if (typeof obj.cumulative_amount === 'number') {
    cumulativeAmount = String(obj.cumulative_amount);
  } else {
    throw new Error('proof: missing/invalid cumulative_amount');
  }
  if (!Array.isArray(obj.proof)) throw new Error('proof: missing/invalid proof array');

  const proof = (obj.proof as unknown[]).map((node, i) => {
    if (typeof node !== 'string') throw new Error(`proof[${i}]: not a string`);
    return node;
  });

  return {
    claimant: obj.claimant,
    distributor: obj.distributor,
    epoch: obj.epoch,
    cumulativeAmount,
    proof,
  };
}

/**
 * Convert the JSON proof's hex strings into `[u8; 32]` byte arrays for the
 * `cpi_yd_claim` data layout.
 */
export function decodeProofNodes(proof: string[]): Buffer[] {
  return proof.map((s, i) => {
    const hex = s.startsWith('0x') ? s.slice(2) : s;
    if (hex.length !== 64) {
      throw new Error(`proof[${i}]: expected 32-byte hex, got ${hex.length / 2} bytes`);
    }
    return Buffer.from(hex, 'hex');
  });
}
