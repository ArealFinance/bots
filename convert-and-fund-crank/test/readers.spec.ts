import { describe, expect, it, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  DEX_CONFIG_FEE_DEST_OFFSET_FROM_BODY,
  DISTRIBUTOR_REWARD_VAULT_OFFSET_FROM_BODY,
  NAV_OFFSET_FROM_BODY,
  RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY,
  RWT_VAULT_BODY_SIZE,
  RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY,
  YD_CONFIG_FEE_DEST_OFFSET_FROM_BODY,
  fetchDexArealFeeDestination,
  fetchDistributorRewardVault,
  fetchNav,
  fetchPoolAccountList,
  fetchRwtVaultAccounts,
  fetchTokenAmount,
  fetchYdArealFeeDestination,
  resolveUsdcSide,
} from '../src/readers.js';
import type { PoolSnapshot } from '../src/types.js';

/**
 * M-1 — pin the on-chain layout offsets for `RwtVault.nav_book_value` and
 * sibling fields read by convert-and-fund-crank. The contract has matching
 * `const _: () = assert!(core::mem::size_of::<RwtVault>() == 259)` so we
 * detect drift on the bot side at unit-test time.
 */

const PUB = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
const ZERO_DISC = Buffer.alloc(8);

function mockConn(data: Buffer): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue({ data, executable: false, lamports: 0, owner: PUB(0xff) }),
  } as unknown as Connection;
}

function mockMissingConn(): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(null),
  } as unknown as Connection;
}

describe('fetchNav (RwtVault layout)', () => {
  it('NAV_OFFSET_FROM_BODY is 24 (pinned)', () => {
    expect(NAV_OFFSET_FROM_BODY).toBe(24);
  });

  it('RWT_VAULT_BODY_SIZE is 259 (pinned, matches contract size_of assertion)', () => {
    expect(RWT_VAULT_BODY_SIZE).toBe(259);
  });

  it('reads u64 LE at body offset 24 (8 disc + 24)', async () => {
    const body = Buffer.alloc(RWT_VAULT_BODY_SIZE);
    body.writeBigUInt64LE(123456789n, NAV_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const nav = await fetchNav(mockConn(data), PUB(1));
    expect(nav).toBe(123456789n);
  });

  it('returns null for missing account', async () => {
    const nav = await fetchNav(mockMissingConn(), PUB(1));
    expect(nav).toBeNull();
  });

  it('returns null for short data', async () => {
    const data = Buffer.concat([ZERO_DISC, Buffer.alloc(20)]);
    const nav = await fetchNav(mockConn(data), PUB(1));
    expect(nav).toBeNull();
  });

  it('parses nav_book_value=0 correctly (not null)', async () => {
    const body = Buffer.alloc(RWT_VAULT_BODY_SIZE);
    body.writeBigUInt64LE(0n, NAV_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const nav = await fetchNav(mockConn(data), PUB(1));
    expect(nav).toBe(0n);
  });
});

describe('fetchRwtVaultAccounts (capital + areal-fee offsets)', () => {
  it('RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY = 32', () => {
    expect(RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY).toBe(32);
  });

  it('RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY = 226', () => {
    expect(RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY).toBe(226);
  });

  it('reads both pubkeys from body offsets (matches state.rs comments)', async () => {
    const body = Buffer.alloc(RWT_VAULT_BODY_SIZE);
    PUB(0x42).toBuffer().copy(body, RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY);
    PUB(0x99).toBuffer().copy(body, RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const out = await fetchRwtVaultAccounts(mockConn(data), PUB(1));
    expect(out).not.toBeNull();
    expect(out!.capitalAccumulatorAta.equals(PUB(0x42))).toBe(true);
    expect(out!.arealFeeDestination.equals(PUB(0x99))).toBe(true);
  });
});

describe('fetchDistributorRewardVault', () => {
  it('reward_vault offset from body is 64', () => {
    expect(DISTRIBUTOR_REWARD_VAULT_OFFSET_FROM_BODY).toBe(64);
  });

  it('reads pubkey at body offset 64', async () => {
    const body = Buffer.alloc(160);
    PUB(0xab).toBuffer().copy(body, DISTRIBUTOR_REWARD_VAULT_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const out = await fetchDistributorRewardVault(mockConn(data), PUB(1));
    expect(out!.equals(PUB(0xab))).toBe(true);
  });
});

describe('fetchYdArealFeeDestination', () => {
  it('YD config fee_dest offset from body is 32', () => {
    expect(YD_CONFIG_FEE_DEST_OFFSET_FROM_BODY).toBe(32);
  });

  it('reads pubkey at body offset 32', async () => {
    const body = Buffer.alloc(96);
    PUB(0x77).toBuffer().copy(body, YD_CONFIG_FEE_DEST_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const out = await fetchYdArealFeeDestination(mockConn(data), PUB(1));
    expect(out!.equals(PUB(0x77))).toBe(true);
  });
});

describe('fetchDexArealFeeDestination', () => {
  it('DEX config fee_dest offset from body is 32', () => {
    expect(DEX_CONFIG_FEE_DEST_OFFSET_FROM_BODY).toBe(32);
  });

  it('reads pubkey at body offset 32', async () => {
    const body = Buffer.alloc(96);
    PUB(0x33).toBuffer().copy(body, DEX_CONFIG_FEE_DEST_OFFSET_FROM_BODY);
    const data = Buffer.concat([ZERO_DISC, body]);
    const out = await fetchDexArealFeeDestination(mockConn(data), PUB(1));
    expect(out!.equals(PUB(0x33))).toBe(true);
  });
});

describe('fetchPoolAccountList', () => {
  it('reads vaultA at body offset 96 and vaultB at body offset 128', async () => {
    const body = Buffer.alloc(180);
    PUB(0xa1).toBuffer().copy(body, 96);
    PUB(0xb2).toBuffer().copy(body, 128);
    const data = Buffer.concat([ZERO_DISC, body]);
    const out = await fetchPoolAccountList(mockConn(data), PUB(1));
    expect(out!.vaultA.equals(PUB(0xa1))).toBe(true);
    expect(out!.vaultB.equals(PUB(0xb2))).toBe(true);
  });
});

describe('fetchTokenAmount (SPL Token Account amount @ 64..72 LE)', () => {
  // R-T1 (tester closure): pin happy / missing / wrong-owner branches.

  it('happy path: reads amount u64 LE at offset 64', async () => {
    const data = Buffer.alloc(165); // SPL Token Account size
    data.writeBigUInt64LE(987_654_321n, 64);
    const conn = mockConn(data);
    const out = await fetchTokenAmount(conn, PUB(1));
    expect(out).toBe(987_654_321n);
  });

  it('missing account: returns 0n (per spec — uninitialized ATA reads as zero balance)', async () => {
    const conn = mockMissingConn();
    const out = await fetchTokenAmount(conn, PUB(1));
    expect(out).toBe(0n);
  });

  it('wrong-owner / unexpected length: throws to surface schema drift', async () => {
    // R-T1 pins the throw — a too-short data buffer means the account wasn't
    // an SPL Token Account in the first place; silently returning 0 would
    // mask a real wiring bug.
    const data = Buffer.alloc(40); // too small
    const conn = mockConn(data);
    await expect(fetchTokenAmount(conn, PUB(1))).rejects.toThrow(/unexpected length/);
  });
});

describe('resolveUsdcSide', () => {
  const usdc = PUB(0x01);
  const rwt = PUB(0x02);
  const vaultA = PUB(0xa1);
  const vaultB = PUB(0xb2);

  it('returns vaultA as USDC side when tokenA == USDC', () => {
    const pool: PoolSnapshot = {
      address: PUB(0x10),
      tokenAMint: usdc,
      tokenBMint: rwt,
      reserveA: 100n,
      reserveB: 200n,
      feeBps: 30,
      isActive: true,
    };
    const side = resolveUsdcSide(pool, vaultA, vaultB, usdc);
    expect(side).not.toBeNull();
    expect(side!.poolUsdcVault.equals(vaultA)).toBe(true);
    expect(side!.poolRwtVault.equals(vaultB)).toBe(true);
  });

  it('returns vaultB as USDC side when tokenB == USDC', () => {
    const pool: PoolSnapshot = {
      address: PUB(0x10),
      tokenAMint: rwt,
      tokenBMint: usdc,
      reserveA: 100n,
      reserveB: 200n,
      feeBps: 30,
      isActive: true,
    };
    const side = resolveUsdcSide(pool, vaultA, vaultB, usdc);
    expect(side!.poolUsdcVault.equals(vaultB)).toBe(true);
    expect(side!.poolRwtVault.equals(vaultA)).toBe(true);
  });

  it('returns null when neither token matches USDC', () => {
    const pool: PoolSnapshot = {
      address: PUB(0x10),
      tokenAMint: rwt,
      tokenBMint: PUB(0x03),
      reserveA: 100n,
      reserveB: 200n,
      feeBps: 30,
      isActive: true,
    };
    expect(resolveUsdcSide(pool, vaultA, vaultB, usdc)).toBeNull();
  });
});
