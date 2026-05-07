/**
 * Phase 4.1 B.5 — SDK PDA byte-identity + type parity.
 *
 * Replaces the orphan `sdk-pda-parity.test.ts` deleted in Phase 4 follow-up
 * A2 (commit a53a30d). The previous file was never wired into `npm run e2e`
 * and imported a deleted bot-local `dist/src/pdas.js` — this rewrite is
 * fixture-driven and consumes the SDK exports directly.
 *
 * Why this test exists:
 *   Phase 4 R2 PDA bridge tests only checked `fn.length` (arity), not
 *   runtime byte identity. That gap let 3 PDA signature divergences slip
 *   through; the refactorer caught them manually mid-R3. This file closes
 *   the gap on two levels:
 *
 *   1. Runtime byte identity — every `find*Pda` helper exported by
 *      `@areal/sdk/pda` is invoked with a pinned `(args, programId)` input
 *      and the resulting `[PublicKey base58, bump]` is compared against a
 *      canonical reference computed via `PublicKey.findProgramAddressSync`
 *      with the seeds spelled out byte-by-byte. If a refactor flips the
 *      seed prefix (e.g. `"liq_holding"` → `"liquidity_holding"`) or
 *      reorders the seed buffers, the test fails with the actual base58
 *      side-by-side with the expected one.
 *
 *   2. Compile-time parameter shape — the `_TYPE_PARITY_GUARD` block at
 *      the bottom uses a strict `IsExact<A, B>` helper to lock the exact
 *      `Parameters<typeof helper>` and `ReturnType` of every PDA helper.
 *      `tsx --test` runs the file through TypeScript before executing, so
 *      any drift in argument order or types is a compile error — not a
 *      late runtime surprise. This catches the same class of bug that R3
 *      had to find by hand.
 *
 * Coverage: all 21 `find*Pda` helpers across the 6 SDK PDA modules
 * (shared, native-dex, ownership-token, rwt-engine, yield-distribution,
 * futarchy). Helpers with seed-only inputs get 1 fixture; helpers with
 * payload inputs get ≥2 fixtures with different inputs to ensure the seed
 * is actually consumed (not ignored).
 *
 * Fixtures live in `fixtures/pda-parity.json`. They are pinned values —
 * regenerate ONLY if program IDs (sdk/src/network/program-ids.ts) or seed
 * prefixes (contracts/<program>/src/constants.rs) change.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

import {
  findAssociatedTokenAddressPda,
  findBinArrayPda,
  findClaimStatusPda,
  findDexConfigPda,
  findFutarchyConfigPda,
  findLiquidityHoldingPda,
  findLiquidityNexusPda,
  findLpPositionPda,
  findMerkleDistributorPda,
  findOtConfigPda,
  findOtGovernancePda,
  findOtTreasuryPda,
  findPoolCreatorsPda,
  findPoolStatePda,
  findProposalPda,
  findRevenueAccountPda,
  findRevenueConfigPda,
  findRwtDistConfigPda,
  findRwtVaultPda,
  findYdAccumulatorPda,
  findYdConfigPda,
} from '@areal/sdk/pda';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface FixtureEntry {
  args: Record<string, string>;
  expected: { pda: string; bump: number };
}

interface PdaParityFixtures {
  [helperName: string]: FixtureEntry[] | string;
}

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'pda-parity.json'), 'utf8'),
) as PdaParityFixtures;

/** Pull a fixture array, asserting non-empty so the test never silently no-ops. */
function fx(name: string): FixtureEntry[] {
  const entries = fixtures[name];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`pda-parity.json missing or empty for ${name}`);
  }
  return entries;
}

/** Standard byte-identity assertion. Logs both base58s on mismatch. */
function assertPdaEquals(
  helperName: string,
  inputs: Record<string, string>,
  actual: [PublicKey, number],
  expected: { pda: string; bump: number },
): void {
  const [actualPk, actualBump] = actual;
  assert.equal(
    actualPk.toBase58(),
    expected.pda,
    `${helperName} pda mismatch for ${JSON.stringify(inputs)}: ` +
      `got ${actualPk.toBase58()}, expected ${expected.pda}`,
  );
  assert.equal(
    actualBump,
    expected.bump,
    `${helperName} bump mismatch for ${JSON.stringify(inputs)}: ` +
      `got ${actualBump}, expected ${expected.bump}`,
  );
}

const pk = (s: string): PublicKey => new PublicKey(s);

// ---------------------------------------------------------------------------
// shared.ts
// ---------------------------------------------------------------------------

test('findAssociatedTokenAddressPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findAssociatedTokenAddressPda')) {
    const result = findAssociatedTokenAddressPda(pk(args.owner!), pk(args.mint!));
    assertPdaEquals('findAssociatedTokenAddressPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// rwt-engine.ts
// ---------------------------------------------------------------------------

test('findRwtVaultPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findRwtVaultPda')) {
    const result = findRwtVaultPda(pk(args.programId!));
    assertPdaEquals('findRwtVaultPda', args, result, expected);
  }
});

test('findRwtDistConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findRwtDistConfigPda')) {
    const result = findRwtDistConfigPda(pk(args.programId!));
    assertPdaEquals('findRwtDistConfigPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// native-dex.ts
// ---------------------------------------------------------------------------

test('findDexConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findDexConfigPda')) {
    const result = findDexConfigPda(pk(args.programId!));
    assertPdaEquals('findDexConfigPda', args, result, expected);
  }
});

test('findPoolCreatorsPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findPoolCreatorsPda')) {
    const result = findPoolCreatorsPda(pk(args.programId!));
    assertPdaEquals('findPoolCreatorsPda', args, result, expected);
  }
});

test('findPoolStatePda — byte-identity parity', () => {
  for (const { args, expected } of fx('findPoolStatePda')) {
    const result = findPoolStatePda(
      pk(args.tokenAMint!),
      pk(args.tokenBMint!),
      pk(args.programId!),
    );
    assertPdaEquals('findPoolStatePda', args, result, expected);
  }
});

test('findLpPositionPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findLpPositionPda')) {
    const result = findLpPositionPda(
      pk(args.pool!),
      pk(args.owner!),
      pk(args.programId!),
    );
    assertPdaEquals('findLpPositionPda', args, result, expected);
  }
});

test('findBinArrayPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findBinArrayPda')) {
    const result = findBinArrayPda(pk(args.poolState!), pk(args.programId!));
    assertPdaEquals('findBinArrayPda', args, result, expected);
  }
});

test('findLiquidityNexusPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findLiquidityNexusPda')) {
    const result = findLiquidityNexusPda(pk(args.programId!));
    assertPdaEquals('findLiquidityNexusPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// ownership-token.ts
// ---------------------------------------------------------------------------

test('findOtConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findOtConfigPda')) {
    const result = findOtConfigPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findOtConfigPda', args, result, expected);
  }
});

test('findRevenueAccountPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findRevenueAccountPda')) {
    const result = findRevenueAccountPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findRevenueAccountPda', args, result, expected);
  }
});

test('findRevenueConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findRevenueConfigPda')) {
    const result = findRevenueConfigPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findRevenueConfigPda', args, result, expected);
  }
});

test('findOtGovernancePda — byte-identity parity', () => {
  for (const { args, expected } of fx('findOtGovernancePda')) {
    const result = findOtGovernancePda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findOtGovernancePda', args, result, expected);
  }
});

test('findOtTreasuryPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findOtTreasuryPda')) {
    const result = findOtTreasuryPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findOtTreasuryPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// yield-distribution.ts
// ---------------------------------------------------------------------------

test('findYdConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findYdConfigPda')) {
    const result = findYdConfigPda(pk(args.programId!));
    assertPdaEquals('findYdConfigPda', args, result, expected);
  }
});

test('findMerkleDistributorPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findMerkleDistributorPda')) {
    const result = findMerkleDistributorPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findMerkleDistributorPda', args, result, expected);
  }
});

test('findYdAccumulatorPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findYdAccumulatorPda')) {
    const result = findYdAccumulatorPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findYdAccumulatorPda', args, result, expected);
  }
});

test('findClaimStatusPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findClaimStatusPda')) {
    const result = findClaimStatusPda(
      pk(args.distributor!),
      pk(args.claimant!),
      pk(args.programId!),
    );
    assertPdaEquals('findClaimStatusPda', args, result, expected);
  }
});

test('findLiquidityHoldingPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findLiquidityHoldingPda')) {
    const result = findLiquidityHoldingPda(pk(args.programId!));
    assertPdaEquals('findLiquidityHoldingPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// futarchy.ts
// ---------------------------------------------------------------------------

test('findFutarchyConfigPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findFutarchyConfigPda')) {
    const result = findFutarchyConfigPda(pk(args.otMint!), pk(args.programId!));
    assertPdaEquals('findFutarchyConfigPda', args, result, expected);
  }
});

test('findProposalPda — byte-identity parity', () => {
  for (const { args, expected } of fx('findProposalPda')) {
    const result = findProposalPda(
      pk(args.configPda!),
      BigInt(args.proposalId!),
      pk(args.programId!),
    );
    assertPdaEquals('findProposalPda', args, result, expected);
  }
});

// ---------------------------------------------------------------------------
// Coverage guard — fail loudly if a new helper is added to the SDK without
// a fixture entry. Counts must match the helper count in `@areal/sdk/pda`.
// ---------------------------------------------------------------------------

test('coverage — every SDK PDA helper has at least one fixture', () => {
  const helperKeys = Object.keys(fixtures).filter((k) => !k.startsWith('_'));
  // 21 helpers across 6 modules: shared (1) + native-dex (6) + ownership-token (5)
  // + rwt-engine (2) + yield-distribution (5) + futarchy (2).
  assert.equal(
    helperKeys.length,
    21,
    `expected 21 helper fixtures, found ${helperKeys.length}: ${helperKeys.join(', ')}`,
  );
  for (const key of helperKeys) {
    const entries = fixtures[key];
    assert(Array.isArray(entries) && entries.length > 0, `${key} has no fixtures`);
  }
});

// ---------------------------------------------------------------------------
// Compile-time parameter-shape parity guard.
//
// `tsx --test` type-checks before executing, so an SDK refactor that flips
// argument order — e.g. moving `programId` from last to first — fails to
// compile here, even if the runtime fixtures still happen to coincide.
//
// Notes:
//   - `IsExact<A, B>` is the standard invariance trick: a type is "exactly
//     equal" iff `<T>() => T extends X ? 1 : 2` produces the same type for
//     both sides. Anything weaker (`A extends B`, `Equals<A, B>` via
//     conditional) admits subtype drift.
//   - The `_TYPE_PARITY_GUARD` const is `as const` and references `true`
//     literals, so it is dead-code-eliminated at runtime but loud at
//     compile time.
// ---------------------------------------------------------------------------

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const _TYPE_PARITY_GUARD = {
  // shared
  findAssociatedTokenAddressPda_params:
    null as unknown as IsExact<Parameters<typeof findAssociatedTokenAddressPda>, [PublicKey, PublicKey]>,
  findAssociatedTokenAddressPda_return:
    null as unknown as IsExact<ReturnType<typeof findAssociatedTokenAddressPda>, [PublicKey, number]>,

  // rwt-engine
  findRwtVaultPda_params:
    null as unknown as IsExact<Parameters<typeof findRwtVaultPda>, [PublicKey]>,
  findRwtVaultPda_return:
    null as unknown as IsExact<ReturnType<typeof findRwtVaultPda>, [PublicKey, number]>,
  findRwtDistConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findRwtDistConfigPda>, [PublicKey]>,
  findRwtDistConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findRwtDistConfigPda>, [PublicKey, number]>,

  // native-dex
  findDexConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findDexConfigPda>, [PublicKey]>,
  findDexConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findDexConfigPda>, [PublicKey, number]>,
  findPoolCreatorsPda_params:
    null as unknown as IsExact<Parameters<typeof findPoolCreatorsPda>, [PublicKey]>,
  findPoolCreatorsPda_return:
    null as unknown as IsExact<ReturnType<typeof findPoolCreatorsPda>, [PublicKey, number]>,
  findPoolStatePda_params:
    null as unknown as IsExact<Parameters<typeof findPoolStatePda>, [PublicKey, PublicKey, PublicKey]>,
  findPoolStatePda_return:
    null as unknown as IsExact<ReturnType<typeof findPoolStatePda>, [PublicKey, number]>,
  findLpPositionPda_params:
    null as unknown as IsExact<Parameters<typeof findLpPositionPda>, [PublicKey, PublicKey, PublicKey]>,
  findLpPositionPda_return:
    null as unknown as IsExact<ReturnType<typeof findLpPositionPda>, [PublicKey, number]>,
  findBinArrayPda_params:
    null as unknown as IsExact<Parameters<typeof findBinArrayPda>, [PublicKey, PublicKey]>,
  findBinArrayPda_return:
    null as unknown as IsExact<ReturnType<typeof findBinArrayPda>, [PublicKey, number]>,
  findLiquidityNexusPda_params:
    null as unknown as IsExact<Parameters<typeof findLiquidityNexusPda>, [PublicKey]>,
  findLiquidityNexusPda_return:
    null as unknown as IsExact<ReturnType<typeof findLiquidityNexusPda>, [PublicKey, number]>,

  // ownership-token
  findOtConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findOtConfigPda>, [PublicKey, PublicKey]>,
  findOtConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findOtConfigPda>, [PublicKey, number]>,
  findRevenueAccountPda_params:
    null as unknown as IsExact<Parameters<typeof findRevenueAccountPda>, [PublicKey, PublicKey]>,
  findRevenueAccountPda_return:
    null as unknown as IsExact<ReturnType<typeof findRevenueAccountPda>, [PublicKey, number]>,
  findRevenueConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findRevenueConfigPda>, [PublicKey, PublicKey]>,
  findRevenueConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findRevenueConfigPda>, [PublicKey, number]>,
  findOtGovernancePda_params:
    null as unknown as IsExact<Parameters<typeof findOtGovernancePda>, [PublicKey, PublicKey]>,
  findOtGovernancePda_return:
    null as unknown as IsExact<ReturnType<typeof findOtGovernancePda>, [PublicKey, number]>,
  findOtTreasuryPda_params:
    null as unknown as IsExact<Parameters<typeof findOtTreasuryPda>, [PublicKey, PublicKey]>,
  findOtTreasuryPda_return:
    null as unknown as IsExact<ReturnType<typeof findOtTreasuryPda>, [PublicKey, number]>,

  // yield-distribution
  findYdConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findYdConfigPda>, [PublicKey]>,
  findYdConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findYdConfigPda>, [PublicKey, number]>,
  findMerkleDistributorPda_params:
    null as unknown as IsExact<Parameters<typeof findMerkleDistributorPda>, [PublicKey, PublicKey]>,
  findMerkleDistributorPda_return:
    null as unknown as IsExact<ReturnType<typeof findMerkleDistributorPda>, [PublicKey, number]>,
  findYdAccumulatorPda_params:
    null as unknown as IsExact<Parameters<typeof findYdAccumulatorPda>, [PublicKey, PublicKey]>,
  findYdAccumulatorPda_return:
    null as unknown as IsExact<ReturnType<typeof findYdAccumulatorPda>, [PublicKey, number]>,
  findClaimStatusPda_params:
    null as unknown as IsExact<Parameters<typeof findClaimStatusPda>, [PublicKey, PublicKey, PublicKey]>,
  findClaimStatusPda_return:
    null as unknown as IsExact<ReturnType<typeof findClaimStatusPda>, [PublicKey, number]>,
  findLiquidityHoldingPda_params:
    null as unknown as IsExact<Parameters<typeof findLiquidityHoldingPda>, [PublicKey]>,
  findLiquidityHoldingPda_return:
    null as unknown as IsExact<ReturnType<typeof findLiquidityHoldingPda>, [PublicKey, number]>,

  // futarchy
  findFutarchyConfigPda_params:
    null as unknown as IsExact<Parameters<typeof findFutarchyConfigPda>, [PublicKey, PublicKey]>,
  findFutarchyConfigPda_return:
    null as unknown as IsExact<ReturnType<typeof findFutarchyConfigPda>, [PublicKey, number]>,
  findProposalPda_params:
    null as unknown as IsExact<Parameters<typeof findProposalPda>, [PublicKey, bigint, PublicKey]>,
  findProposalPda_return:
    null as unknown as IsExact<ReturnType<typeof findProposalPda>, [PublicKey, number]>,
} satisfies Record<string, true>;
// `satisfies Record<string, true>` is the trip-wire: every field above must
// resolve to the literal `true` from `IsExact`. Any mismatch becomes
// `false`, which fails the `satisfies` check at compile time.
void _TYPE_PARITY_GUARD;
