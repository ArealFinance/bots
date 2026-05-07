/**
 * Phase 22.5 / I1 — startup PDA self-derivation check.
 *
 * Tests cover the pure `verifyPdaDerivation(config)` function — no I/O,
 * no env loading. Mismatches are returned as a structured list; main()
 * is responsible for fail-fast on a non-empty list.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  findDexConfigPda,
  findRwtVaultPda,
  findYdConfigPda,
  findOtGovernancePda,
  findFutarchyConfigPda,
  findMerkleDistributorPda,
  NATIVE_DEX_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
} from '@areal/sdk';

import { verifyPdaDerivation, type Config } from '../src/index.js';
import type { ContractName } from '../src/checks.js';

// ---------- Fixture: a config that is canonical end-to-end ----------

// Random "expected authority" pubkey — not load-bearing for these tests.
const expectedAuthority = new PublicKey(
  'GqdNwn9LkV9rCpyXxSXukpAhnAZqFoUe2hi6BkN1Mt7y',
);

// A real-shaped OT mint pubkey (any valid 32-byte address; the value is
// irrelevant — what matters is that the per-OT PDAs are derived from it).
const otMint = new PublicKey('So11111111111111111111111111111111111111112');

function expectedAuthorities(): Record<ContractName, PublicKey> {
  return {
    ot_governance: expectedAuthority,
    futarchy_config: expectedAuthority,
    rwt_vault: expectedAuthority,
    dex_config: expectedAuthority,
    yd_distribution_config: expectedAuthority,
  };
}

/** Build a config whose 6 PDAs are all derived from the canonical seeds. */
function canonicalConfig(opts: { withOtMint: boolean }): Config {
  const [dexConfig] = findDexConfigPda(NATIVE_DEX_PROGRAM_ID);
  const [rwtVault] = findRwtVaultPda(RWT_ENGINE_PROGRAM_ID);
  const [ydDistributionConfig] = findYdConfigPda(YIELD_DISTRIBUTION_PROGRAM_ID);
  const [otGovernance] = findOtGovernancePda(otMint, OWNERSHIP_TOKEN_PROGRAM_ID);
  const [futarchyConfig] = findFutarchyConfigPda(otMint, FUTARCHY_PROGRAM_ID);
  const [ydMerkleDistributor] = findMerkleDistributorPda(
    otMint,
    YIELD_DISTRIBUTION_PROGRAM_ID,
  );
  return {
    rpcUrl: 'http://localhost:8899',
    metricsPort: 9201,
    pollIntervalMs: 60_000,
    dexConfig,
    rwtVault,
    ydDistributionConfig,
    otGovernance,
    futarchyConfig,
    ydMerkleDistributor,
    expectedAuthorities: expectedAuthorities(),
    otMint: opts.withOtMint ? otMint : undefined,
  };
}

// ---------- Tests ----------

describe('verifyPdaDerivation', () => {
  it('returns [] when all 6 PDAs match SDK self-derivation (with OT_MINT)', () => {
    const config = canonicalConfig({ withOtMint: true });
    expect(verifyPdaDerivation(config)).toEqual([]);
  });

  it('returns [] when 3 singleton PDAs match (without OT_MINT) — per-OT skipped', () => {
    const config = canonicalConfig({ withOtMint: false });
    // Even if the per-OT PDAs are wrong, they aren't validated when
    // OT_MINT is absent. Pollute them to prove the skip:
    config.otGovernance = new PublicKey(
      '11111111111111111111111111111112',
    );
    expect(verifyPdaDerivation(config)).toEqual([]);
  });

  it('flags PDA_DEX_CONFIG mismatch with full provenance', () => {
    const config = canonicalConfig({ withOtMint: true });
    const wrong = new PublicKey('11111111111111111111111111111112');
    config.dexConfig = wrong;
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_DEX_CONFIG');
    expect(result[0]?.envValue).toBe(wrong.toBase58());
    expect(result[0]?.derived).toBe(
      findDexConfigPda(NATIVE_DEX_PROGRAM_ID)[0].toBase58(),
    );
    expect(result[0]?.helper).toMatch(/findDexConfigPda/);
  });

  it('flags PDA_RWT_VAULT mismatch', () => {
    const config = canonicalConfig({ withOtMint: false });
    config.rwtVault = new PublicKey('11111111111111111111111111111113');
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_RWT_VAULT');
  });

  it('flags PDA_YD_DISTRIBUTION_CONFIG mismatch', () => {
    const config = canonicalConfig({ withOtMint: false });
    config.ydDistributionConfig = new PublicKey(
      '11111111111111111111111111111114',
    );
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_YD_DISTRIBUTION_CONFIG');
  });

  it('flags PDA_OT_GOVERNANCE mismatch when OT_MINT is set', () => {
    const config = canonicalConfig({ withOtMint: true });
    config.otGovernance = new PublicKey('11111111111111111111111111111115');
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_OT_GOVERNANCE');
  });

  it('flags PDA_FUTARCHY_CONFIG mismatch when OT_MINT is set', () => {
    const config = canonicalConfig({ withOtMint: true });
    config.futarchyConfig = new PublicKey('11111111111111111111111111111116');
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_FUTARCHY_CONFIG');
  });

  it('flags PDA_YD_MERKLE_DISTRIBUTOR mismatch when OT_MINT is set', () => {
    const config = canonicalConfig({ withOtMint: true });
    config.ydMerkleDistributor = new PublicKey(
      '11111111111111111111111111111117',
    );
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.envVar).toBe('PDA_YD_MERKLE_DISTRIBUTOR');
  });

  it('reports ALL mismatches at once (not first-fail)', () => {
    const config = canonicalConfig({ withOtMint: true });
    config.dexConfig = new PublicKey('11111111111111111111111111111112');
    config.rwtVault = new PublicKey('11111111111111111111111111111113');
    config.otGovernance = new PublicKey('11111111111111111111111111111115');
    const result = verifyPdaDerivation(config);
    expect(result).toHaveLength(3);
    const envVars = result.map((r) => r.envVar).sort();
    expect(envVars).toEqual([
      'PDA_DEX_CONFIG',
      'PDA_OT_GOVERNANCE',
      'PDA_RWT_VAULT',
    ]);
  });

  // Defense against a subtle regression: an operator with a different OT
  // mint must NOT have their per-OT PDAs marked invalid just because the
  // PDAs derived from the "default" OT mint disagree. The test asserts
  // that swapping OT_MINT swaps the canonical PDAs.
  it('per-OT PDAs are validated against the OT_MINT actually pinned', () => {
    const altMint = new PublicKey(
      'GqdNwn9LkV9rCpyXxSXukpAhnAZqFoUe2hi6BkN1Mt7y',
    );
    const [altOtGov] = findOtGovernancePda(altMint, OWNERSHIP_TOKEN_PROGRAM_ID);
    const [altFutarchy] = findFutarchyConfigPda(altMint, FUTARCHY_PROGRAM_ID);
    const [altMerkle] = findMerkleDistributorPda(
      altMint,
      YIELD_DISTRIBUTION_PROGRAM_ID,
    );
    const config = canonicalConfig({ withOtMint: false });
    config.otMint = altMint;
    config.otGovernance = altOtGov;
    config.futarchyConfig = altFutarchy;
    config.ydMerkleDistributor = altMerkle;
    expect(verifyPdaDerivation(config)).toEqual([]);
  });
});
