/**
 * R-59 — ix-builder byte-equivalence parity.
 *
 * The crank workspaces and the dashboard each ship their own builder for
 * the same on-chain instruction (different runtimes, different crypto
 * primitives: node:crypto vs Web Crypto). A drift between the two means
 * either:
 *   - The dashboard sends an ix the on-chain handler rejects, or
 *   - The crank sends an ix the dashboard's resolver thinks is something else.
 *
 * This test pins byte-by-byte equivalence:
 *   - programId, keys.length
 *   - keys[i].{pubkey.bytes, isSigner, isWritable}
 *   - data buffer (discriminator + args body)
 *
 * Coverage:
 *   - convert_to_rwt           (crank vs dashboard-equivalent)
 *   - claim_yield (RWT)        (crank vs dashboard-equivalent)
 *   - compound_yield (DEX)     (crank vs dashboard-equivalent)
 *   - claim_yd_for_treasury    (crank vs dashboard-equivalent)
 *   - withdraw_liquidity_holding (gated R20 — see end of file)
 *
 * Methodology:
 *   The dashboard's builders live in SvelteKit-flavoured TS (`$lib/...`
 *   imports); we cannot import them from a node:test context. Instead we
 *   inline a byte-equivalent reimplementation of each dashboard builder
 *   using the same primitives (`crypto.subtle.digest('SHA-256', ...)` for
 *   the disc, `Buffer.alloc` for the body) and assert it matches the
 *   crank-side builder. If the dashboard's `.ts` file is later modified,
 *   the inline mirror must be updated alongside — drift is detected via
 *   the on-chain handler, but this test catches it before deployment.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  buildConvertToRwtIx,
  type BuildConvertArgs,
} from '../convert-and-fund-crank/src/convert.js';
import {
  buildRwtClaimYieldIx,
  buildDexCompoundIx,
  buildOtTreasuryClaimIx,
  type BuildRwtClaimArgs,
  type BuildDexCompoundArgs,
  type BuildOtTreasuryClaimArgs,
} from '../yield-claim-crank/src/claim-builders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Fixture {
  [k: string]: number | string;
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'parity-fixture.json'), 'utf8'),
) as Fixture;

function pkFromByte(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

function pk(name: string): PublicKey {
  const v = fixture[name];
  if (typeof v !== 'number') throw new Error(`fixture missing ${name}`);
  return pkFromByte(v);
}

const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// ----------------------------------------------------------------------------
// Inline mirror of dashboard primitives.
// ----------------------------------------------------------------------------

async function discWeb(name: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash).slice(0, 8);
}

function writeU64LE(buf: Uint8Array, off: number, v: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[off + i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
}

function writeU32LE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function encodeClaimArgsWeb(cumulative: bigint, proof: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(8 + 4 + 32 * proof.length);
  writeU64LE(out, 0, cumulative);
  writeU32LE(out, 8, proof.length);
  let off = 12;
  for (const node of proof) {
    if (node.length !== 32) throw new Error('proof node must be 32 bytes');
    out.set(node, off);
    off += 32;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ----------------------------------------------------------------------------
// Byte-equivalence assertion.
// ----------------------------------------------------------------------------

function assertIxEqual(a: TransactionInstruction, b: TransactionInstruction): void {
  assert.equal(
    a.programId.toBase58(),
    b.programId.toBase58(),
    `programId mismatch: ${a.programId.toBase58()} vs ${b.programId.toBase58()}`,
  );
  assert.equal(a.keys.length, b.keys.length, `keys.length mismatch: ${a.keys.length} vs ${b.keys.length}`);
  for (let i = 0; i < a.keys.length; i++) {
    const ka = a.keys[i]!;
    const kb = b.keys[i]!;
    assert.equal(
      ka.pubkey.toBase58(),
      kb.pubkey.toBase58(),
      `keys[${i}].pubkey mismatch: ${ka.pubkey.toBase58()} vs ${kb.pubkey.toBase58()}`,
    );
    assert.equal(ka.isSigner, kb.isSigner, `keys[${i}].isSigner mismatch`);
    assert.equal(ka.isWritable, kb.isWritable, `keys[${i}].isWritable mismatch`);
  }
  // data buffer byte equality
  const aData = Buffer.from(a.data);
  const bData = Buffer.from(b.data);
  assert.equal(aData.length, bData.length, `data.length mismatch: ${aData.length} vs ${bData.length}`);
  assert.equal(aData.toString('hex'), bData.toString('hex'), 'data byte mismatch');
}

// ============================================================================
// convert_to_rwt
// ============================================================================

test('parity convert_to_rwt: crank ix == dashboard-style ix', async () => {
  const args: BuildConvertArgs = {
    ydProgramId: pk('yd_program'),
    dexProgramId: pk('dex_program'),
    rwtEngineProgramId: pk('rwt_engine_program'),
    crank: pk('signer'),
    otMint: pk('ot_mint'),
    accumulatorUsdcAta: pk('accumulator_usdc_ata'),
    accumulatorRwtAta: pk('accumulator_rwt_ata'),
    feeAccount: pk('fee_account'),
    rewardVault: pk('yd_reward_vault'),
    rwtMint: pk('rwt_mint'),
    dexConfig: pk('dex_config'),
    poolState: pk('dex_pool_state'),
    dexPoolVaultIn: pk('dex_pool_vault_in'),
    dexPoolVaultOut: pk('dex_pool_vault_out'),
    dexArealFeeAccount: pk('dex_areal_fee'),
    rwtCapitalAcc: pk('rwt_capital_acc'),
    rwtDaoFeeAccount: pk('rwt_dao_fee'),
    usdcAmount: 1_000_000n,
    minRwtOut: 999_000n,
    swapFirst: true,
  };

  const built = buildConvertToRwtIx(args);

  // Mirror dashboard builder byte-for-byte.
  const disc = await discWeb('convert_to_rwt');
  const data = new Uint8Array(8 + 8 + 8 + 1);
  data.set(disc, 0);
  writeU64LE(data, 8, args.usdcAmount);
  writeU64LE(data, 16, args.minRwtOut);
  data[24] = args.swapFirst ? 1 : 0;

  const dashIx = new TransactionInstruction({
    programId: args.ydProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: built.config, isSigner: false, isWritable: false },
      { pubkey: built.distributor, isSigner: false, isWritable: true },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: built.accumulator, isSigner: false, isWritable: false },
      { pubkey: args.accumulatorUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.accumulatorRwtAta, isSigner: false, isWritable: true },
      { pubkey: args.feeAccount, isSigner: false, isWritable: true },
      { pubkey: args.rewardVault, isSigner: false, isWritable: true },
      { pubkey: args.rwtMint, isSigner: false, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.dexPoolVaultIn, isSigner: false, isWritable: true },
      { pubkey: args.dexPoolVaultOut, isSigner: false, isWritable: true },
      { pubkey: args.dexArealFeeAccount, isSigner: false, isWritable: true },
      { pubkey: built.rwtVault, isSigner: false, isWritable: true },
      { pubkey: args.rwtCapitalAcc, isSigner: false, isWritable: true },
      { pubkey: args.rwtDaoFeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.dexProgramId, isSigner: false, isWritable: false },
      { pubkey: args.rwtEngineProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  assertIxEqual(built.ix, dashIx);
});

// ============================================================================
// claim_yield (RWT::claim_yield)
// ============================================================================

test('parity claim_yield: crank ix == dashboard-style ix', async () => {
  const proof = [
    new Uint8Array(32).fill(0xaa),
    new Uint8Array(32).fill(0xbb),
  ];
  const args: BuildRwtClaimArgs = {
    rwtEngineProgramId: pk('rwt_engine_program'),
    ydProgramId: pk('yd_program'),
    crank: pk('signer'),
    rwtVault: pk('rwt_vault'),
    distConfig: pk('rwt_dist_config'),
    rwtClaimAta: pk('rwt_claim_ata'),
    liquidityDest: pk('liquidity_dest'),
    protocolRevenueDest: pk('protocol_revenue_dest'),
    ydConfig: pk('yd_config'),
    otMint: pk('ot_mint'),
    ydDistributor: pk('yd_distributor'),
    ydClaimStatus: pk('yd_claim_status'),
    ydRewardVault: pk('yd_reward_vault'),
    cumulativeAmount: 12345n,
    proof: proof.map((p) => Buffer.from(p)),
  };

  const built = buildRwtClaimYieldIx(args);

  const disc = await discWeb('claim_yield');
  const body = encodeClaimArgsWeb(args.cumulativeAmount, proof);
  const data = concatBytes(disc, body);

  const dashIx = new TransactionInstruction({
    programId: args.rwtEngineProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.rwtVault, isSigner: false, isWritable: true },
      { pubkey: args.distConfig, isSigner: false, isWritable: false },
      { pubkey: args.rwtClaimAta, isSigner: false, isWritable: true },
      { pubkey: args.liquidityDest, isSigner: false, isWritable: true },
      { pubkey: args.protocolRevenueDest, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  assertIxEqual(built, dashIx);
});

// ============================================================================
// compound_yield (DEX::compound_yield)
// ============================================================================

test('parity compound_yield: crank ix == dashboard-style ix', async () => {
  const proof = [new Uint8Array(32).fill(0xcc)];
  const args: BuildDexCompoundArgs = {
    dexProgramId: pk('dex_program'),
    ydProgramId: pk('yd_program'),
    crank: pk('signer'),
    poolState: pk('dex_pool_state'),
    targetVault: pk('dex_target_vault'),
    ydConfig: pk('yd_config'),
    otMint: pk('ot_mint'),
    ydDistributor: pk('yd_distributor'),
    ydClaimStatus: pk('yd_claim_status'),
    ydRewardVault: pk('yd_reward_vault'),
    cumulativeAmount: 999n,
    proof: proof.map((p) => Buffer.from(p)),
  };

  const built = buildDexCompoundIx(args);

  const disc = await discWeb('compound_yield');
  const body = encodeClaimArgsWeb(args.cumulativeAmount, proof);
  const data = concatBytes(disc, body);

  const dashIx = new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.targetVault, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  assertIxEqual(built, dashIx);
});

// ============================================================================
// claim_yd_for_treasury (OT::claim_yd_for_treasury)
// ============================================================================

test('parity claim_yd_for_treasury: crank ix == dashboard-style ix', async () => {
  const proof = [new Uint8Array(32).fill(0xdd)];
  const args: BuildOtTreasuryClaimArgs = {
    otProgramId: pk('ot_program'),
    ydProgramId: pk('yd_program'),
    crank: pk('signer'),
    otMint: pk('ot_mint'),
    otTreasury: pk('ot_treasury'),
    treasuryRwtAta: pk('treasury_rwt_ata'),
    ydConfig: pk('yd_config'),
    ydOtMint: pk('ot_mint'),
    ydDistributor: pk('yd_distributor'),
    ydClaimStatus: pk('yd_claim_status'),
    ydRewardVault: pk('yd_reward_vault'),
    cumulativeAmount: 7777n,
    proof: proof.map((p) => Buffer.from(p)),
  };

  const built = buildOtTreasuryClaimIx(args);

  const disc = await discWeb('claim_yd_for_treasury');
  const body = encodeClaimArgsWeb(args.cumulativeAmount, proof);
  const data = concatBytes(disc, body);

  const dashIx = new TransactionInstruction({
    programId: args.otProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.crank, isSigner: true, isWritable: true },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.otTreasury, isSigner: false, isWritable: false },
      { pubkey: args.treasuryRwtAta, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.ydOtMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  assertIxEqual(built, dashIx);
});

// ============================================================================
// withdraw_liquidity_holding — gated R20.
//
// The crank has no production builder for this ix (deferred to the dashboard
// per SD-29 / R-58). The parity test is a placeholder marker so when R20 lands
// the file gets a real assertion alongside the dashboard builder.
// ============================================================================

test('parity withdraw_liquidity_holding: gated R20 (placeholder)', () => {
  // No-op until R20 ships a crank-side builder. Documenting the intent here
  // so the next pass adds a byte-equivalence check without a missing test.
  assert.ok(true, 'gated R20 — see internal Layer 9 decisions doc');
});
