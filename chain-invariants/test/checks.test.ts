/**
 * Phase 22 unit tests for chain-invariants checks.ts.
 *
 * `Connection` is mocked via plain objects with `vi.fn()` methods. We
 * never spin up a real RPC.
 */

import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  parseMerkleDistributor,
  MERKLEDISTRIBUTOR_DISCRIMINATOR,
  DISTRIBUTIONCONFIG_DISCRIMINATOR,
} from '@areal/sdk/yield-distribution';
import { RWTVAULT_DISCRIMINATOR } from '@areal/sdk/rwt-engine';
import { OTGOVERNANCE_DISCRIMINATOR } from '@areal/sdk/ownership-token';
import { FUTARCHYCONFIG_DISCRIMINATOR } from '@areal/sdk/futarchy';
import { DEXCONFIG_DISCRIMINATOR } from '@areal/sdk/native-dex';
import {
  OWNERSHIP_TOKEN_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  NATIVE_DEX_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
} from '@areal/sdk';

import {
  fetchLastTxAge,
  checkMerkleRootAge,
  checkNavAge,
  checkAuthorities,
  checkRwtSupply,
  CONTRACT_NAMES,
  authorityOutcomeToMetricValue,
} from '../src/checks.js';
import type { CheckContext, ContractName } from '../src/checks.js';

// ---------- Test fixtures ----------

const NOW = 1_700_000_000;

const distributorPda = new PublicKey('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK');
const rwtVaultPda = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
const otGovernancePda = new PublicKey('11111111111111111111111111111112');
const futarchyConfigPda = new PublicKey('11111111111111111111111111111113');
const dexConfigPda = new PublicKey('11111111111111111111111111111114');
const ydDistributionConfigPda = new PublicKey('11111111111111111111111111111115');

const rwtMint = new PublicKey('So11111111111111111111111111111111111111112');

// Random "expected" pubkeys per Q5.
const expectedAuthority = new PublicKey('GqdNwn9LkV9rCpyXxSXukpAhnAZqFoUe2hi6BkN1Mt7y');
const wrongAuthority = new PublicKey('5UrM9csUEDBeBqMZTuuZyHRNhbRW4vQ1MUcuYUWYzv8r');

// ---------- Synthetic account-data builders ----------

function buildRwtVaultBuffer(opts: {
  totalRwtSupply: bigint;
  navBookValue: bigint;
  authority: PublicKey;
  mint: PublicKey;
}): Buffer {
  // Layout (matches sdk RwtVault):
  //   8   discriminator
  //   16  total_invested_capital  (u128)
  //   8   total_rwt_supply        (u64)
  //   8   nav_book_value          (u64)
  //   32  capital_accumulator_ata
  //   32  rwt_mint
  //   32  authority
  //   32  pending_authority
  //   1   has_pending
  //   32  manager
  //   32  pause_authority
  //   1   mint_paused
  //   32  areal_fee_destination
  //   1   bump
  // total = 8 + 16 + 8 + 8 + 32*7 + 1*3 = 267
  const buf = Buffer.alloc(267);
  Buffer.from(RWTVAULT_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(0n, 8); // tic low
  buf.writeBigUInt64LE(0n, 16); // tic high
  buf.writeBigUInt64LE(opts.totalRwtSupply, 24);
  buf.writeBigUInt64LE(opts.navBookValue, 32);
  // capital_accumulator_ata @ 40 — leave zero
  // rwt_mint @ 72
  Buffer.from(opts.mint.toBytes()).copy(buf, 72);
  // authority @ 104
  Buffer.from(opts.authority.toBytes()).copy(buf, 104);
  // pending_authority @ 136 zero, has_pending @ 168 = 0
  // manager @ 169 zero, pause_authority @ 201 zero, mint_paused @ 233 = 0
  // areal_fee_destination @ 234 zero, bump @ 266 = 0
  return buf;
}

function buildMerkleDistributorBuffer(opts: { epoch: bigint }): Buffer {
  // Layout:
  //  8  discriminator
  //  32 ot_mint
  //  32 reward_vault
  //  32 accumulator
  //  32 merkle_root
  //  8  max_total_claim
  //  8  total_claimed
  //  8  total_funded
  //  8  locked_vested
  //  8  last_fund_ts
  //  8  vesting_period_secs
  //  8  epoch
  //  1  is_active
  //  1  bump
  // total = 8 + 32*4 + 8*7 + 1*2 = 194
  const buf = Buffer.alloc(194);
  Buffer.from(MERKLEDISTRIBUTOR_DISCRIMINATOR).copy(buf, 0);
  // epoch lives at offset 8 + 32*4 + 8*6 = 184
  buf.writeBigUInt64LE(opts.epoch, 184);
  return buf;
}

function buildOtGovernanceBuffer(authority: PublicKey): Buffer {
  // OtGovernance: 8 disc + 32 ot_mint + 32 authority + 32 pending + 1 has_pending + 1 is_active + 1 bump = 107
  const buf = Buffer.alloc(107);
  Buffer.from(OTGOVERNANCE_DISCRIMINATOR).copy(buf, 0);
  // ot_mint @ 8 zero
  Buffer.from(authority.toBytes()).copy(buf, 40);
  return buf;
}

function buildFutarchyConfigBuffer(authority: PublicKey): Buffer {
  // FutarchyConfig: 8 disc + 32 ot_mint + 32 authority + 32 pending + 1 has_pending + 8 next_proposal_id + 1 is_active + 1 bump = 115
  const buf = Buffer.alloc(115);
  Buffer.from(FUTARCHYCONFIG_DISCRIMINATOR).copy(buf, 0);
  Buffer.from(authority.toBytes()).copy(buf, 40);
  return buf;
}

function buildDexConfigBuffer(authority: PublicKey): Buffer {
  // DexConfig: 8 disc + 32 authority + 32 pending + 1 has_pending + 32 pause + 2 base_fee + 2 lp_fee + 32 areal_fee + 32 rebalancer + 1 is_active + 1 bump = 175
  const buf = Buffer.alloc(175);
  Buffer.from(DEXCONFIG_DISCRIMINATOR).copy(buf, 0);
  Buffer.from(authority.toBytes()).copy(buf, 8);
  return buf;
}

function buildDistributionConfigBuffer(authority: PublicKey): Buffer {
  // DistributionConfig: 8 disc + 32 authority + 32 pending + 1 has_pending + 32 publish + 2 protocol_fee + 8 min_dist + 32 areal_fee + 1 is_active + 1 bump = 149
  const buf = Buffer.alloc(149);
  Buffer.from(DISTRIBUTIONCONFIG_DISCRIMINATOR).copy(buf, 0);
  Buffer.from(authority.toBytes()).copy(buf, 8);
  return buf;
}

// ---------- Mock connection helpers ----------

function makeConnection(impls: {
  getSignaturesForAddress?: (
    pda: PublicKey,
    opts: { limit: number },
  ) => Promise<Array<{ signature: string; slot: number; blockTime: number | null }>>;
  getBlockTime?: (slot: number) => Promise<number | null>;
  getAccountInfo?: (pda: PublicKey) => Promise<{ data: Buffer; owner: PublicKey } | null>;
  getTokenSupply?: (
    mint: PublicKey,
  ) => Promise<{ value: { amount: string; decimals: number; uiAmount: number; uiAmountString: string } }>;
} = {}): { connection: ReturnType<typeof asConnection>; ctx: CheckContext } {
  const conn = {
    getSignaturesForAddress: vi.fn(impls.getSignaturesForAddress ?? (async () => [])),
    getBlockTime: vi.fn(impls.getBlockTime ?? (async () => null)),
    getAccountInfo: vi.fn(impls.getAccountInfo ?? (async () => null)),
    getTokenSupply:
      vi.fn(
        impls.getTokenSupply ??
          (async () => ({
            value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
          })),
      ),
  };
  return {
    connection: asConnection(conn),
    ctx: {
      connection: asConnection(conn),
      nowSec: () => NOW,
    },
  };
}

// Type-erase to satisfy CheckContext.connection without depending on the
// full Connection class API.
function asConnection(c: unknown): import('@solana/web3.js').Connection {
  return c as import('@solana/web3.js').Connection;
}

// ---------- Tests: fetchLastTxAge ----------

describe('fetchLastTxAge', () => {
  it('returns ageSeconds when the signature has a blockTime', async () => {
    const conn = asConnection({
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValue([{ signature: 'abc', slot: 100, blockTime: NOW - 1000 }]),
      getBlockTime: vi.fn().mockResolvedValue(null),
    });
    const out = await fetchLastTxAge(conn, distributorPda, NOW);
    expect(out).toEqual({ ageSeconds: 1000, signature: 'abc' });
  });

  it('falls back to getBlockTime when sig.blockTime is null', async () => {
    const getBlockTime = vi.fn().mockResolvedValue(NOW - 500);
    const conn = asConnection({
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValue([{ signature: 'def', slot: 42, blockTime: null }]),
      getBlockTime,
    });
    const out = await fetchLastTxAge(conn, distributorPda, NOW);
    expect(out).toEqual({ ageSeconds: 500, signature: 'def' });
    expect(getBlockTime).toHaveBeenCalledWith(42);
  });

  it('throws no_signatures when the RPC returns an empty array', async () => {
    const conn = asConnection({
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    });
    await expect(fetchLastTxAge(conn, distributorPda, NOW)).rejects.toThrow('no_signatures');
  });

  it('throws no_block_time when both sig.blockTime and getBlockTime return null', async () => {
    const conn = asConnection({
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValue([{ signature: 'xyz', slot: 1, blockTime: null }]),
      getBlockTime: vi.fn().mockResolvedValue(null),
    });
    await expect(fetchLastTxAge(conn, distributorPda, NOW)).rejects.toThrow('no_block_time');
  });
});

// ---------- Tests: checkMerkleRootAge ----------

describe('checkMerkleRootAge', () => {
  it('returns ok with age + epoch + lastSignature on the happy path', async () => {
    const distributorBuf = buildMerkleDistributorBuffer({ epoch: 7n });
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [
        { signature: 'sig1', slot: 100, blockTime: NOW - 3600 },
      ],
      getAccountInfo: async () => ({
        data: distributorBuf,
        owner: YIELD_DISTRIBUTION_PROGRAM_ID,
      }),
    });
    const out = await checkMerkleRootAge(ctx, { distributorPda });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.distributorPubkey).toBe(distributorPda.toBase58());
      expect(out.value.ageSeconds).toBe(3600);
      expect(out.value.epoch).toBe(7n);
      expect(out.value.lastSignature).toBe('sig1');
    }
  });

  it('returns ok:false when signatures are empty', async () => {
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [],
    });
    const out = await checkMerkleRootAge(ctx, { distributorPda });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/no_signatures/);
  });

  it('returns ok:false when account info is missing', async () => {
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [
        { signature: 'sigZ', slot: 1, blockTime: NOW - 1 },
      ],
      getAccountInfo: async () => null,
    });
    const out = await checkMerkleRootAge(ctx, { distributorPda });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/distributor_account_missing/);
  });

  // I2 — defense-in-depth: distributor PDA exists and bytes decode, but
  // is owned by a foreign program. Must fail before the SDK decoder runs.
  it('returns ok:false (wrong_owner) when distributor PDA is owned by a foreign program', async () => {
    const distributorBuf = buildMerkleDistributorBuffer({ epoch: 7n });
    const foreignProgram = new PublicKey(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [
        { signature: 'sig1', slot: 100, blockTime: NOW - 3600 },
      ],
      getAccountInfo: async () => ({ data: distributorBuf, owner: foreignProgram }),
    });
    const out = await checkMerkleRootAge(ctx, { distributorPda });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/distributor_wrong_owner/);
      expect(out.error).toContain(foreignProgram.toBase58());
    }
  });
});

// ---------- Tests: checkNavAge ----------

describe('checkNavAge', () => {
  it('returns ok with age + nav fields on the happy path', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 1_000_000n,
      navBookValue: 5_500_000n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [
        { signature: 'navSig', slot: 200, blockTime: NOW - 7200 },
      ],
      getAccountInfo: async () => ({
        data: vaultBuf,
        owner: RWT_ENGINE_PROGRAM_ID,
      }),
    });
    const out = await checkNavAge(ctx, { rwtVaultPda });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.ageSeconds).toBe(7200);
      expect(out.value.navBookValue).toBe(5_500_000n);
      expect(out.value.totalRwtSupply).toBe(1_000_000n);
    }
  });

  // I2 — defense-in-depth: vault PDA exists with valid bytes but owned by
  // a foreign program. Owner check fires before parseRwtVault.
  it('returns ok:false (wrong_owner) when vault PDA is owned by a foreign program', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 1_000_000n,
      navBookValue: 5_500_000n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const foreignProgram = new PublicKey(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    const { ctx } = makeConnection({
      getSignaturesForAddress: async () => [
        { signature: 'navSig', slot: 200, blockTime: NOW - 7200 },
      ],
      getAccountInfo: async () => ({ data: vaultBuf, owner: foreignProgram }),
    });
    const out = await checkNavAge(ctx, { rwtVaultPda });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/vault_wrong_owner/);
      expect(out.error).toContain(foreignProgram.toBase58());
    }
  });
});

// ---------- Tests: checkAuthorities ----------

describe('checkAuthorities', () => {
  function expectedMap(): Record<ContractName, PublicKey> {
    const m: Record<ContractName, PublicKey> = {
      ot_governance: expectedAuthority,
      futarchy_config: expectedAuthority,
      rwt_vault: expectedAuthority,
      dex_config: expectedAuthority,
      yd_distribution_config: expectedAuthority,
    };
    return m;
  }

  // Helper: a fetcher that returns the canonical happy-path account for
  // each PDA (correct owner program ID, correct discriminator, expected
  // authority). Tests override individual entries to simulate fault
  // conditions without re-stating the full mapping.
  function makeHappyFetcher(
    overrides: Partial<Record<ContractName, () => Promise<{ data: Buffer; owner: PublicKey } | null> | { data: Buffer; owner: PublicKey } | null>> = {},
  ) {
    return async (pda: PublicKey): Promise<{ data: Buffer; owner: PublicKey } | null> => {
      // Support both sync and async overrides; both common in test fixtures.
      const resolveOverride = async (name: ContractName) => {
        const o = overrides[name];
        if (o === undefined) return undefined;
        const r = o();
        return r instanceof Promise ? await r : r;
      };
      if (pda.equals(otGovernancePda)) {
        const o = await resolveOverride('ot_governance');
        if (o !== undefined) return o;
        return {
          data: buildOtGovernanceBuffer(expectedAuthority),
          owner: OWNERSHIP_TOKEN_PROGRAM_ID,
        };
      }
      if (pda.equals(futarchyConfigPda)) {
        const o = await resolveOverride('futarchy_config');
        if (o !== undefined) return o;
        return {
          data: buildFutarchyConfigBuffer(expectedAuthority),
          owner: FUTARCHY_PROGRAM_ID,
        };
      }
      if (pda.equals(rwtVaultPda)) {
        const o = await resolveOverride('rwt_vault');
        if (o !== undefined) return o;
        return {
          data: buildRwtVaultBuffer({
            totalRwtSupply: 0n,
            navBookValue: 0n,
            authority: expectedAuthority,
            mint: rwtMint,
          }),
          owner: RWT_ENGINE_PROGRAM_ID,
        };
      }
      if (pda.equals(dexConfigPda)) {
        const o = await resolveOverride('dex_config');
        if (o !== undefined) return o;
        return {
          data: buildDexConfigBuffer(expectedAuthority),
          owner: NATIVE_DEX_PROGRAM_ID,
        };
      }
      if (pda.equals(ydDistributionConfigPda)) {
        const o = await resolveOverride('yd_distribution_config');
        if (o !== undefined) return o;
        return {
          data: buildDistributionConfigBuffer(expectedAuthority),
          owner: YIELD_DISTRIBUTION_PROGRAM_ID,
        };
      }
      return null;
    };
  }

  function defaultArgs() {
    return {
      otGovernancePda,
      futarchyConfigPda,
      rwtVaultPda,
      dexConfigPda,
      ydDistributionConfigPda,
      expected: expectedMap(),
    };
  }

  it('returns 5 results, all match=true with outcome=match on happy path', async () => {
    const { ctx } = makeConnection({ getAccountInfo: makeHappyFetcher() });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toHaveLength(5);
      for (const r of out.value) {
        expect(r.match).toBe(true);
        expect(r.outcome).toBe('match');
        expect(r.actual).toBe(expectedAuthority.toBase58());
      }
      expect(out.value.map((r) => r.contract).sort()).toEqual([...CONTRACT_NAMES].sort());
    }
  });

  it('flags outcome=drift when a single contract has the wrong authority', async () => {
    const { ctx } = makeConnection({
      getAccountInfo: makeHappyFetcher({
        rwt_vault: () => ({
          data: buildRwtVaultBuffer({
            totalRwtSupply: 0n,
            navBookValue: 0n,
            authority: wrongAuthority,
            mint: rwtMint,
          }),
          owner: RWT_ENGINE_PROGRAM_ID,
        }),
      }),
    });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const drifted = out.value.filter((r) => !r.match);
      expect(drifted).toHaveLength(1);
      expect(drifted[0]?.contract).toBe('rwt_vault');
      expect(drifted[0]?.outcome).toBe('drift');
      expect(drifted[0]?.actual).toBe(wrongAuthority.toBase58());
    }
  });

  it('reports outcome=rpc_error when getAccountInfo throws (other 4 still reported)', async () => {
    const { ctx } = makeConnection({
      getAccountInfo: makeHappyFetcher({
        ot_governance: () => {
          throw new Error('rpc_blackhole');
        },
      }),
    });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toHaveLength(5);
      const failed = out.value.find((r) => r.contract === 'ot_governance');
      expect(failed?.match).toBe(false);
      expect(failed?.outcome).toBe('rpc_error');
      expect(failed?.actual).toContain('<rpc_error');
      expect(failed?.actual).toContain('rpc_blackhole');
      // The other 4 contracts still report a real authority and match.
      const ok = out.value.filter((r) => r.contract !== 'ot_governance');
      for (const r of ok) {
        expect(r.match).toBe(true);
        expect(r.outcome).toBe('match');
      }
    }
  });

  it('reports outcome=account_not_found when getAccountInfo returns null', async () => {
    const { ctx } = makeConnection({
      getAccountInfo: makeHappyFetcher({
        ot_governance: () => null,
      }),
    });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const missing = out.value.find((r) => r.contract === 'ot_governance');
      expect(missing?.match).toBe(false);
      expect(missing?.outcome).toBe('account_not_found');
      expect(missing?.actual).toBe('<account_not_found>');
    }
  });

  // I2 — defense-in-depth: account exists at PDA but is owned by a foreign
  // program. SDK discriminator validation might still pass on a colliding
  // 8-byte prefix; explicit owner check catches account substitution.
  it('reports outcome=wrong_owner when account exists but is owned by a foreign program', async () => {
    const foreignProgram = new PublicKey(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    const { ctx } = makeConnection({
      getAccountInfo: makeHappyFetcher({
        dex_config: () => ({
          // Bytes still decode as a valid DexConfig, but the owner is wrong.
          data: buildDexConfigBuffer(expectedAuthority),
          owner: foreignProgram,
        }),
      }),
    });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const wrong = out.value.find((r) => r.contract === 'dex_config');
      expect(wrong?.match).toBe(false);
      expect(wrong?.outcome).toBe('wrong_owner');
      expect(wrong?.actual).toContain('<wrong_owner');
      expect(wrong?.actual).toContain(foreignProgram.toBase58());
      // The other 4 contracts still match cleanly.
      const ok = out.value.filter((r) => r.contract !== 'dex_config');
      for (const r of ok) {
        expect(r.match).toBe(true);
        expect(r.outcome).toBe('match');
      }
    }
  });

  // M1+W1 — decode error path. Owner is correct but bytes are malformed
  // (e.g., truncated buffer or wrong discriminator). Must surface as
  // outcome=decode_error → metric=0 (drift), NOT rpc_error → metric=-1.
  it('reports outcome=decode_error when account is owner-correct but bytes are malformed', async () => {
    // Build a buffer that is too short to satisfy the SDK's account layout.
    // The SDK's discriminator check or struct decoder will throw.
    const malformed = Buffer.alloc(4); // way under any account size
    const { ctx } = makeConnection({
      getAccountInfo: makeHappyFetcher({
        futarchy_config: () => ({
          data: malformed,
          owner: FUTARCHY_PROGRAM_ID,
        }),
      }),
    });
    const out = await checkAuthorities(ctx, defaultArgs());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const failed = out.value.find((r) => r.contract === 'futarchy_config');
      expect(failed?.match).toBe(false);
      expect(failed?.outcome).toBe('decode_error');
      expect(failed?.actual).toContain('<decode_error');
    }
  });
});

// ---------- Tests: authorityOutcomeToMetricValue (M1+W1 mapping contract) ----------

describe('authorityOutcomeToMetricValue', () => {
  it('maps match → 1', () => {
    expect(authorityOutcomeToMetricValue('match')).toBe(1);
  });

  it('maps drift, decode_error, account_not_found, wrong_owner → 0 (must fire AuthorityDrift)', () => {
    expect(authorityOutcomeToMetricValue('drift')).toBe(0);
    expect(authorityOutcomeToMetricValue('decode_error')).toBe(0);
    expect(authorityOutcomeToMetricValue('account_not_found')).toBe(0);
    expect(authorityOutcomeToMetricValue('wrong_owner')).toBe(0);
  });

  it('maps rpc_error → -1 (must NOT fire AuthorityDrift)', () => {
    expect(authorityOutcomeToMetricValue('rpc_error')).toBe(-1);
  });
});

// ---------- Tests: checkRwtSupply ----------

describe('checkRwtSupply', () => {
  it('returns drift=0 when tracked equals mint actual', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 1_000_000n,
      navBookValue: 0n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const { ctx } = makeConnection({
      getAccountInfo: async () => ({ data: vaultBuf, owner: RWT_ENGINE_PROGRAM_ID }),
      getTokenSupply: async () => ({
        value: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
      }),
    });
    const out = await checkRwtSupply(ctx, { rwtVaultPda });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.trackedSupply).toBe(1_000_000n);
      expect(out.value.mintActualSupply).toBe(1_000_000n);
      expect(out.value.drift).toBe(0n);
    }
  });

  it('returns positive drift when mint > tracked', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 1_000_000n,
      navBookValue: 0n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const { ctx } = makeConnection({
      getAccountInfo: async () => ({ data: vaultBuf, owner: RWT_ENGINE_PROGRAM_ID }),
      getTokenSupply: async () => ({
        value: { amount: '1500000', decimals: 6, uiAmount: 1.5, uiAmountString: '1.5' },
      }),
    });
    const out = await checkRwtSupply(ctx, { rwtVaultPda });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.drift).toBe(500_000n);
  });

  it('returns positive drift (abs) when tracked > mint', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 2_000_000n,
      navBookValue: 0n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const { ctx } = makeConnection({
      getAccountInfo: async () => ({ data: vaultBuf, owner: RWT_ENGINE_PROGRAM_ID }),
      getTokenSupply: async () => ({
        value: { amount: '500000', decimals: 6, uiAmount: 0.5, uiAmountString: '0.5' },
      }),
    });
    const out = await checkRwtSupply(ctx, { rwtVaultPda });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.drift).toBe(1_500_000n);
  });

  it('returns ok:false when vault account missing', async () => {
    const { ctx } = makeConnection({
      getAccountInfo: async () => null,
    });
    const out = await checkRwtSupply(ctx, { rwtVaultPda });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/vault_account_missing/);
  });

  // I2 — defense-in-depth: vault PDA exists with valid bytes but owned by
  // a foreign program. Owner check fires before parseRwtVault, so we never
  // even reach the getTokenSupply call.
  it('returns ok:false (wrong_owner) when vault PDA is owned by a foreign program', async () => {
    const vaultBuf = buildRwtVaultBuffer({
      totalRwtSupply: 1_000_000n,
      navBookValue: 0n,
      authority: expectedAuthority,
      mint: rwtMint,
    });
    const foreignProgram = new PublicKey(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    let tokenSupplyCalled = false;
    const { ctx } = makeConnection({
      getAccountInfo: async () => ({ data: vaultBuf, owner: foreignProgram }),
      getTokenSupply: async () => {
        tokenSupplyCalled = true;
        return {
          value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
        };
      },
    });
    const out = await checkRwtSupply(ctx, { rwtVaultPda });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/vault_wrong_owner/);
      expect(out.error).toContain(foreignProgram.toBase58());
    }
    // Owner check must short-circuit before the SPL mint supply RPC call.
    expect(tokenSupplyCalled).toBe(false);
  });
});

// ---------- Sanity: discriminator round-trip ----------

describe('test fixture sanity', () => {
  it('buildMerkleDistributorBuffer round-trips through parseMerkleDistributor', () => {
    const buf = buildMerkleDistributorBuffer({ epoch: 42n });
    const parsed = parseMerkleDistributor(buf);
    expect(parsed.epoch).toBe(42n);
  });
});
