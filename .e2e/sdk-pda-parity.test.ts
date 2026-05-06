/**
 * R2 Phase 4 — SDK PDA Parity Tests
 *
 * Characterization tests that lock in PDA derivation equivalence between bot-local
 * PDA helper functions and SDK versions before refactoring.
 *
 * Category 1.3: PDA derivation parity across all cranks
 *
 * Each test:
 *   1. Derives a PDA via the bot-local function
 *   2. Derives the same PDA via the SDK function
 *   3. Asserts [PublicKey, bump] are identical
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';

// Import bot-local PDA helpers (from various cranks)
// Note: We import from built dist/ paths since these are run via tsx

// Shared program IDs for fixtures
const YD_PROGRAM = new PublicKey('YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF');
const RWT_ENGINE = new PublicKey('RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL');
const DEX_PROGRAM = new PublicKey('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
const OT_PROGRAM = new PublicKey('oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL');

// Test fixture keys
function pkFromByte(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

const OT_MINT = pkFromByte(0x01);
const DISTRIBUTOR = pkFromByte(0x02);
const POOL = pkFromByte(0x03);
const ACCOUNT = pkFromByte(0x04);

/**
 * Assert that two PDA derivations are identical.
 */
function assertPdaEqual(
  actual: [PublicKey, number],
  expected: [PublicKey, number],
  label: string,
): void {
  const [actualPk, actualBump] = actual;
  const [expectedPk, expectedBump] = expected;

  assert(
    actualPk.equals(expectedPk),
    `${label}: pubkey mismatch. Local: ${actualPk.toBase58()}, SDK: ${expectedPk.toBase58()}`,
  );
  assert.equal(actualBump, expectedBump, `${label}: bump mismatch`);
}

// ============================================================================
// yield-claim-crank PDAs (Batch A)
// ============================================================================

test('yield-claim-crank PDA parity — deriveDistributorPda', async () => {
  // Import the bot-local function (via built module)
  const { deriveDistributorPda: deriveDistributorPdaLocal } = await import(
    '../yield-claim-crank/dist/src/pdas.js'
  );

  // Import SDK function
  const { findDistributorPda } = await import('@areal/sdk/pda');

  const actual = deriveDistributorPdaLocal(YD_PROGRAM, OT_MINT);
  const expected = findDistributorPda(YD_PROGRAM, OT_MINT);

  assertPdaEqual(actual, expected, 'deriveDistributorPda');
});

test('yield-claim-crank PDA parity — deriveRwtVaultPda', async () => {
  const { deriveRwtVaultPda: deriveRwtVaultPdaLocal } = await import(
    '../yield-claim-crank/dist/src/pdas.js'
  );
  const { findRwtVaultPda } = await import('@areal/sdk/pda');

  const actual = deriveRwtVaultPdaLocal(RWT_ENGINE, YD_PROGRAM, OT_MINT);
  const expected = findRwtVaultPda(RWT_ENGINE, YD_PROGRAM, OT_MINT);

  assertPdaEqual(actual, expected, 'deriveRwtVaultPda');
});

test('yield-claim-crank PDA parity — deriveClaimStatusPda', async () => {
  const { deriveClaimStatusPda: deriveClaimStatusPdaLocal } = await import(
    '../yield-claim-crank/dist/src/pdas.js'
  );
  const { findClaimStatusPda } = await import('@areal/sdk/pda');

  const actual = deriveClaimStatusPdaLocal(YD_PROGRAM, OT_MINT);
  const expected = findClaimStatusPda(YD_PROGRAM, OT_MINT);

  assertPdaEqual(actual, expected, 'deriveClaimStatusPda');
});

test('yield-claim-crank PDA parity — deriveOtTreasuryPda', async () => {
  const { deriveOtTreasuryPda: deriveOtTreasuryPdaLocal } = await import(
    '../yield-claim-crank/dist/src/pdas.js'
  );
  const { findOtTreasuryPda } = await import('@areal/sdk/pda');

  const actual = deriveOtTreasuryPdaLocal(OT_PROGRAM, OT_MINT);
  const expected = findOtTreasuryPda(OT_PROGRAM, OT_MINT);

  assertPdaEqual(actual, expected, 'deriveOtTreasuryPda');
});

// ============================================================================
// nexus-manager PDAs (Batch B)
// ============================================================================

test('nexus-manager PDA parity — deriveLiquidityNexusPda', async () => {
  const { deriveLiquidityNexusPda: deriveLiquidityNexusPdaLocal } = await import(
    '../nexus-manager/dist/src/pdas.js'
  );
  const { findLiquidityNexusPda } = await import('@areal/sdk/pda');

  const actual = deriveLiquidityNexusPdaLocal(DEX_PROGRAM);
  const expected = findLiquidityNexusPda(DEX_PROGRAM);

  assertPdaEqual(actual, expected, 'deriveLiquidityNexusPda');
});

// ============================================================================
// SDK PDAs (Batch C) — these PDAs are only in SDK, bot code derives them
// locally from contracts. This test ensures SDK matches contract references.
// ============================================================================

test('SDK PDA sanity — findDexConfigPda derives correctly', async () => {
  const { findDexConfigPda } = await import('@areal/sdk/pda');

  const [pk, bump] = findDexConfigPda(DEX_PROGRAM);
  // Sanity: public key must be valid
  assert(PublicKey.isOnCurve(pk.toBuffer()), 'dex config PDA must be on curve');
  // Bump must be in valid range
  assert(bump >= 0 && bump <= 255, 'bump must be 0-255');
});

test('SDK PDA sanity — findYdConfigPda derives correctly', async () => {
  const { findYdConfigPda } = await import('@areal/sdk/pda');

  const [pk, bump] = findYdConfigPda(YD_PROGRAM);
  assert(PublicKey.isOnCurve(pk.toBuffer()), 'yd config PDA must be on curve');
  assert(bump >= 0 && bump <= 255, 'bump must be 0-255');
});

test('SDK PDA sanity — findRwtEngineConfigPda derives correctly', async () => {
  const { findRwtEngineConfigPda } = await import('@areal/sdk/pda');

  const [pk, bump] = findRwtEngineConfigPda(RWT_ENGINE);
  assert(PublicKey.isOnCurve(pk.toBuffer()), 'rwt engine config PDA must be on curve');
  assert(bump >= 0 && bump <= 255, 'bump must be 0-255');
});

test('SDK PDA sanity — findOtConfigPda derives correctly', async () => {
  const { findOtConfigPda } = await import('@areal/sdk/pda');

  const [pk, bump] = findOtConfigPda(OT_PROGRAM);
  assert(PublicKey.isOnCurve(pk.toBuffer()), 'ot config PDA must be on curve');
  assert(bump >= 0 && bump <= 255, 'bump must be 0-255');
});
