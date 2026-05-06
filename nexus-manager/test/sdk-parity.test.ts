/**
 * R2 Phase 4 — SDK Parity Tests for nexus-manager
 *
 * Characterization tests that lock in byte-equivalence between the bot-local
 * Nexus tx builders and the SDK versions before refactoring.
 *
 * Category 1.2.1: DEX::nexus_swap builder parity
 * Category 1.2.2: DEX::nexus_add_liquidity builder parity
 * Category 1.2.3: DEX::nexus_remove_liquidity builder parity
 *
 * Each test:
 *   1. Builds an instruction via the bot-local builder
 *   2. Builds the same instruction via the SDK builder
 *   3. Asserts programId, keys array structure, and data bytes are identical
 */

import { describe, it, expect } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  buildNexusSwapIx as buildNexusSwapIxLocal,
} from '../src/tx-builders/nexus-swap.js';
import {
  buildNexusAddLiquidityIx as buildNexusAddLiquidityIxLocal,
} from '../src/tx-builders/nexus-add-liquidity.js';
import {
  buildNexusRemoveLiquidityIx as buildNexusRemoveLiquidityIxLocal,
} from '../src/tx-builders/nexus-remove-liquidity.js';

// Import SDK versions
import {
  buildNexusSwapIx as buildNexusSwapIxSdk,
  buildNexusAddLiquidityIx as buildNexusAddLiquidityIxSdk,
  buildNexusRemoveLiquidityIx as buildNexusRemoveLiquidityIxSdk,
} from '@areal/sdk/tx';

// Test fixture: known public keys
function pkFromByte(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

const DEX_PROGRAM_ID = pkFromByte(0x01);
const MANAGER = pkFromByte(0x02);
const DEX_CONFIG = pkFromByte(0x03);
const LIQUIDITY_NEXUS = pkFromByte(0x04);
const POOL_STATE = pkFromByte(0x05);
const NEXUS_USDC_ATA = pkFromByte(0x06);
const NEXUS_RWT_ATA = pkFromByte(0x07);
const VAULT_A = pkFromByte(0x08);
const VAULT_B = pkFromByte(0x09);
const AREAL_FEE_ACCOUNT = pkFromByte(0x0a);

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

describe('nexus-manager SDK Parity Tests', () => {
  describe('DEX::nexus_swap builder parity (B-T1)', () => {
    it('buildNexusSwapIx local and SDK produce identical TransactionInstructions (A->B)', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
        },
        aToB: true,
        amountIn: 100_000_000n,
        minAmountOut: 50_000_000n,
      };

      const localIx = buildNexusSwapIxLocal(args);
      const sdkIx = buildNexusSwapIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusSwapIx A->B');
    });

    it('buildNexusSwapIx local and SDK produce identical TransactionInstructions (B->A)', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
        },
        aToB: false,
        amountIn: 200_000_000n,
        minAmountOut: 100_000_000n,
      };

      const localIx = buildNexusSwapIxLocal(args);
      const sdkIx = buildNexusSwapIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusSwapIx B->A');
    });

    it('handles large amounts', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
        },
        aToB: true,
        amountIn: 9_223_372_036_854_775_000n, // Near u64::MAX
        minAmountOut: 1n,
      };

      const localIx = buildNexusSwapIxLocal(args);
      const sdkIx = buildNexusSwapIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusSwapIx with large amounts');
    });
  });

  describe('DEX::nexus_add_liquidity builder parity (B-T2)', () => {
    it('buildNexusAddLiquidityIx local and SDK produce identical TransactionInstructions', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE, // Mock lpPosition
        },
        amountA: 50_000_000n,
        amountB: 50_000_000n,
        minShares: 10_000n,
      };

      const localIx = buildNexusAddLiquidityIxLocal(args);
      const sdkIx = buildNexusAddLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusAddLiquidityIx');
    });

    it('handles asymmetric liquidity additions', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE,
        },
        amountA: 100_000_000n,
        amountB: 10_000n,
        minShares: 100n,
      };

      const localIx = buildNexusAddLiquidityIxLocal(args);
      const sdkIx = buildNexusAddLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusAddLiquidityIx asymmetric');
    });

    it('handles single-sided liquidity additions', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE,
        },
        amountA: 100_000_000n,
        amountB: 0n,
        minShares: 1n,
      };

      const localIx = buildNexusAddLiquidityIxLocal(args);
      const sdkIx = buildNexusAddLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusAddLiquidityIx single-sided');
    });
  });

  describe('DEX::nexus_remove_liquidity builder parity (B-T3)', () => {
    it('buildNexusRemoveLiquidityIx local and SDK produce identical TransactionInstructions', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE,
        },
        sharesToBurn: 50_000n,
      };

      const localIx = buildNexusRemoveLiquidityIxLocal(args);
      const sdkIx = buildNexusRemoveLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusRemoveLiquidityIx');
    });

    it('handles high-precision LP removals', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE,
        },
        sharesToBurn: 1n,
      };

      const localIx = buildNexusRemoveLiquidityIxLocal(args);
      const sdkIx = buildNexusRemoveLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusRemoveLiquidityIx high-precision');
    });

    it('handles large LP token burns', () => {
      const args = {
        ctx: {
          dexProgramId: DEX_PROGRAM_ID,
          manager: MANAGER,
          dexConfig: DEX_CONFIG,
          liquidityNexus: LIQUIDITY_NEXUS,
          nexusUsdcAta: NEXUS_USDC_ATA,
          nexusRwtAta: NEXUS_RWT_ATA,
          arealFeeAccount: AREAL_FEE_ACCOUNT,
        },
        pool: {
          dexProgramId: DEX_PROGRAM_ID,
          pool: POOL_STATE,
          vaultA: VAULT_A,
          vaultB: VAULT_B,
          lpPosition: POOL_STATE,
        },
        sharesToBurn: 340_282_366_920_938_463_463_374_607_431_768_211_455n, // u128::MAX
      };

      const localIx = buildNexusRemoveLiquidityIxLocal(args);
      const sdkIx = buildNexusRemoveLiquidityIxSdk(args);

      assertIxEqual(localIx, sdkIx, 'buildNexusRemoveLiquidityIx large LP burn');
    });
  });
});
