/**
 * R2 Phase 4 — SDK Parity Tests for yield-claim-crank
 *
 * Characterization tests that lock in byte-equivalence between the bot-local
 * claim builders and the SDK versions before refactoring.
 *
 * Category 1.1: RWT::claim_yield builder parity
 * Category 1.2: DEX::compound_yield builder parity
 * Category 1.3: OT::claim_yd_for_treasury builder parity
 *
 * Each test:
 *   1. Builds an instruction via the bot-local builder
 *   2. Builds the same instruction via the SDK builder
 *   3. Asserts programId, keys array structure, and data bytes are identical
 */

import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import {
  buildDexCompoundIx as buildDexCompoundIxLocal,
  buildOtTreasuryClaimIx as buildOtTreasuryClaimIxLocal,
  buildRwtClaimYieldIx as buildRwtClaimYieldIxLocal,
} from '../src/claim-builders.js';

// Import SDK versions
import {
  buildRwtClaimYieldIx as buildRwtClaimYieldIxSdk,
  buildOtTreasuryClaimIx as buildOtTreasuryClaimIxSdk,
  buildDexCompoundIx as buildDexCompoundIxSdk,
} from '@areal/sdk/tx';

const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Test fixture: known public keys (for reproducible testing)
function pkFromByte(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

const YD_PROGRAM = pkFromByte(0x01);
const RWT_ENGINE = pkFromByte(0x02);
const DEX_PROGRAM = pkFromByte(0x03);
const OT_PROGRAM = pkFromByte(0x04);
const CRANK = pkFromByte(0x05);
const RWT_VAULT = pkFromByte(0x06);
const DIST_CONFIG = pkFromByte(0x07);
const RWT_CLAIM_ATA = pkFromByte(0x08);
const LIQUIDITY_DEST = pkFromByte(0x09);
const PROTOCOL_REVENUE_DEST = pkFromByte(0x0a);
const YD_CONFIG = pkFromByte(0x0b);
const OT_MINT = pkFromByte(0x0c);
const YD_DISTRIBUTOR = pkFromByte(0x0d);
const YD_CLAIM_STATUS = pkFromByte(0x0e);
const YD_REWARD_VAULT = pkFromByte(0x0f);
const DEX_POOL_STATE = pkFromByte(0x10);
const DEX_TARGET_VAULT = pkFromByte(0x11);
const OT_TREASURY = pkFromByte(0x12);
const TREASURY_RWT_ATA = pkFromByte(0x13);
const YD_OT_MINT = pkFromByte(0x14);

/**
 * Assert that two TransactionInstructions are byte-equivalent.
 */
function assertIxEqual(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  label: string,
): void {
  // Program ID must match
  expect(actual.programId.equals(expected.programId), `${label}: programId mismatch`).toBe(true);

  // Keys array length must match
  expect(actual.keys.length, `${label}: keys.length mismatch`).toBe(expected.keys.length);

  // Each key must match (pubkey, isSigner, isWritable)
  for (let i = 0; i < actual.keys.length; i++) {
    const keyA = actual.keys[i]!;
    const keyB = expected.keys[i]!;
    expect(
      keyA.pubkey.equals(keyB.pubkey),
      `${label}: keys[${i}].pubkey mismatch`,
    ).toBe(true);
    expect(keyA.isSigner, `${label}: keys[${i}].isSigner mismatch`).toBe(keyB.isSigner);
    expect(keyA.isWritable, `${label}: keys[${i}].isWritable mismatch`).toBe(keyB.isWritable);
  }

  // Data buffer must match byte-for-byte
  const dataA = Buffer.from(actual.data);
  const dataB = Buffer.from(expected.data);
  expect(dataA.length, `${label}: data.length mismatch`).toBe(dataB.length);
  expect(dataA.toString('hex'), `${label}: data bytes mismatch`).toBe(dataB.toString('hex'));
}

describe('yield-claim-crank SDK Parity Tests', () => {
  describe('RWT::claim_yield builder parity (B-T1)', () => {
    it('buildRwtClaimYieldIx local and SDK produce identical TransactionInstructions', () => {
      const proof = [Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)];
      const args = {
        rwtEngineProgramId: RWT_ENGINE,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        rwtVault: RWT_VAULT,
        distConfig: DIST_CONFIG,
        rwtClaimAta: RWT_CLAIM_ATA,
        liquidityDest: LIQUIDITY_DEST,
        protocolRevenueDest: PROTOCOL_REVENUE_DEST,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 12345n,
        proof,
      };

      const localIx = buildRwtClaimYieldIxLocal(args);
      const sdkIx = buildRwtClaimYieldIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildRwtClaimYieldIx');
    });

    it('handles empty proof array', () => {
      const args = {
        rwtEngineProgramId: RWT_ENGINE,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        rwtVault: RWT_VAULT,
        distConfig: DIST_CONFIG,
        rwtClaimAta: RWT_CLAIM_ATA,
        liquidityDest: LIQUIDITY_DEST,
        protocolRevenueDest: PROTOCOL_REVENUE_DEST,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 0n,
        proof: [],
      };

      const localIx = buildRwtClaimYieldIxLocal(args);
      const sdkIx = buildRwtClaimYieldIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildRwtClaimYieldIx with empty proof');
    });

    it('handles large proof arrays', () => {
      const proof = Array.from({ length: 10 }, (_, i) => Buffer.alloc(32, i));
      const args = {
        rwtEngineProgramId: RWT_ENGINE,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        rwtVault: RWT_VAULT,
        distConfig: DIST_CONFIG,
        rwtClaimAta: RWT_CLAIM_ATA,
        liquidityDest: LIQUIDITY_DEST,
        protocolRevenueDest: PROTOCOL_REVENUE_DEST,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 999_999_999_999n,
        proof,
      };

      const localIx = buildRwtClaimYieldIxLocal(args);
      const sdkIx = buildRwtClaimYieldIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildRwtClaimYieldIx with large proof');
    });
  });

  describe('DEX::compound_yield builder parity (B-T2)', () => {
    it('buildDexCompoundIx local and SDK produce identical TransactionInstructions', () => {
      const proof = [Buffer.alloc(32, 0xcc)];
      const args = {
        dexProgramId: DEX_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        poolState: DEX_POOL_STATE,
        targetVault: DEX_TARGET_VAULT,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 999n,
        proof,
      };

      const localIx = buildDexCompoundIxLocal(args);
      const sdkIx = buildDexCompoundIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildDexCompoundIx');
    });

    it('handles empty proof array', () => {
      const args = {
        dexProgramId: DEX_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        poolState: DEX_POOL_STATE,
        targetVault: DEX_TARGET_VAULT,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 0n,
        proof: [],
      };

      const localIx = buildDexCompoundIxLocal(args);
      const sdkIx = buildDexCompoundIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildDexCompoundIx with empty proof');
    });

    it('handles large amounts and proof arrays', () => {
      const proof = Array.from({ length: 7 }, (_, i) => Buffer.alloc(32, i + 0x30));
      const args = {
        dexProgramId: DEX_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        poolState: DEX_POOL_STATE,
        targetVault: DEX_TARGET_VAULT,
        ydConfig: YD_CONFIG,
        otMint: OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 123_456_789_012_345n,
        proof,
      };

      const localIx = buildDexCompoundIxLocal(args);
      const sdkIx = buildDexCompoundIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildDexCompoundIx with large proof');
    });
  });

  describe('OT::claim_yd_for_treasury builder parity (B-T3)', () => {
    it('buildOtTreasuryClaimIx local and SDK produce identical TransactionInstructions', () => {
      const proof = [Buffer.alloc(32, 0xdd), Buffer.alloc(32, 0xee), Buffer.alloc(32, 0xff)];
      const args = {
        otProgramId: OT_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        otMint: OT_MINT,
        otTreasury: OT_TREASURY,
        treasuryRwtAta: TREASURY_RWT_ATA,
        ydConfig: YD_CONFIG,
        ydOtMint: YD_OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 55555n,
        proof,
      };

      const localIx = buildOtTreasuryClaimIxLocal(args);
      const sdkIx = buildOtTreasuryClaimIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildOtTreasuryClaimIx');
    });

    it('handles empty proof array', () => {
      const args = {
        otProgramId: OT_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        otMint: OT_MINT,
        otTreasury: OT_TREASURY,
        treasuryRwtAta: TREASURY_RWT_ATA,
        ydConfig: YD_CONFIG,
        ydOtMint: YD_OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 0n,
        proof: [],
      };

      const localIx = buildOtTreasuryClaimIxLocal(args);
      const sdkIx = buildOtTreasuryClaimIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildOtTreasuryClaimIx with empty proof');
    });

    it('handles complex proof trees', () => {
      const proof = Array.from({ length: 12 }, (_, i) => Buffer.alloc(32, (i * 11) % 256));
      const args = {
        otProgramId: OT_PROGRAM,
        ydProgramId: YD_PROGRAM,
        crank: CRANK,
        otMint: OT_MINT,
        otTreasury: OT_TREASURY,
        treasuryRwtAta: TREASURY_RWT_ATA,
        ydConfig: YD_CONFIG,
        ydOtMint: YD_OT_MINT,
        ydDistributor: YD_DISTRIBUTOR,
        ydClaimStatus: YD_CLAIM_STATUS,
        ydRewardVault: YD_REWARD_VAULT,
        cumulativeAmount: 777_888_999n,
        proof,
      };

      const localIx = buildOtTreasuryClaimIxLocal(args);
      const sdkIx = buildOtTreasuryClaimIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildOtTreasuryClaimIx with complex proof');
    });
  });
});
