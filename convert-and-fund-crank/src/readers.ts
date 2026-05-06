import { Connection, PublicKey } from '@solana/web3.js';
import {
  findDexConfigPda,
  findMerkleDistributorPda,
  findRwtVaultPda,
  findYdAccumulatorPda,
  findYdConfigPda,
} from '@areal/sdk/pda';
import type { PoolSnapshot } from './types.js';

/**
 * On-chain readers for convert-and-fund-crank.
 *
 * Three accounts we read:
 *   - Accumulator USDC ATA (balance only, SPL Token)
 *   - RwtVault PDA (nav_book_value field)
 *   - Master RWT/USDC PoolState PDA (reserves, fee_bps, is_active, mints)
 */

const SPL_TOKEN_ACCOUNT_LEN = 165;

export function deriveDexConfigPda(dexProgramId: PublicKey): PublicKey {
  return findDexConfigPda(dexProgramId)[0];
}

export function deriveAccumulatorPda(otMint: PublicKey, ydProgramId: PublicKey): PublicKey {
  return findYdAccumulatorPda(otMint, ydProgramId)[0];
}

export function deriveDistributorPda(otMint: PublicKey, ydProgramId: PublicKey): PublicKey {
  return findMerkleDistributorPda(otMint, ydProgramId)[0];
}

export function deriveDistConfigPda(ydProgramId: PublicKey): PublicKey {
  return findYdConfigPda(ydProgramId)[0];
}

export function deriveRwtVaultPda(rwtEngineProgramId: PublicKey): PublicKey {
  return findRwtVaultPda(rwtEngineProgramId)[0];
}

/** Read SPL Token Account `amount` (bytes 64..72 LE). */
export async function fetchTokenAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info) return 0n;
  if (info.data.length < SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(
      `SPL Token Account at ${ata.toBase58()} has unexpected length ${info.data.length}`,
    );
  }
  return info.data.readBigUInt64LE(64);
}

/**
 * Parse RwtVault and extract `nav_book_value` (u64 LE).
 *
 * RwtVault layout (contracts/rwt-engine/src/state.rs, after 8-byte
 * discriminator):
 *   pub total_invested_capital: u128       // 0..16
 *   pub total_rwt_supply:       u64        // 16..24
 *   pub nav_book_value:         u64        // 24..32
 *   pub capital_accumulator_ata:[u8;32]    // 32..64
 *   pub rwt_mint:               [u8;32]    // 64..96
 *   pub authority:              [u8;32]    // 96..128
 *   pub pending_authority:      [u8;32]    // 128..160
 *   pub has_pending:            bool       // 160..161
 *   pub manager:                [u8;32]    // 161..193
 *   pub pause_authority:        [u8;32]    // 193..225
 *   pub mint_paused:            bool       // 225..226
 *   pub areal_fee_destination:  [u8;32]    // 226..258
 *   pub bump:                   u8         // 258..259
 *
 * Total body = 259 bytes; SPACE = 8 + 259 = 267.
 *
 * Pinned in unit tests (`readers.test.ts`) and re-asserted in the contract's
 * `const _: () = assert!(core::mem::size_of::<RwtVault>() == 259)`. If the
 * contract layout changes, both this reader and the dashboard's L-1 reader
 * (`readRwtVault` in dashboard/lib/api/layer8.ts) must be updated together.
 */
export const NAV_OFFSET_FROM_BODY = 24;
export const RWT_MINT_OFFSET_FROM_BODY = 64;
export const RWT_VAULT_BODY_SIZE = 259;

export async function fetchNav(conn: Connection, rwtVaultPda: PublicKey): Promise<bigint | null> {
  const info = await conn.getAccountInfo(rwtVaultPda, 'confirmed');
  if (!info) return null;
  if (info.data.length < 8 + NAV_OFFSET_FROM_BODY + 8) return null;
  return info.data.readBigUInt64LE(8 + NAV_OFFSET_FROM_BODY);
}

/**
 * Parse a DEX `PoolState` and return the trading-relevant fields.
 *
 * Canonical PoolState layout (native-dex state.rs:39-65, post-D28).
 * 8 disc + body. Body offsets — added to 8 for absolute offsets in `data`:
 *   pool_type:    u8        // body 0   → abs 8
 *   token_a_mint: [u8;32]   // body 1   → abs 9
 *   token_b_mint: [u8;32]   // body 33  → abs 41
 *   vault_a:      [u8;32]   // body 65  → abs 73
 *   vault_b:      [u8;32]   // body 97  → abs 105
 *   reserve_a:    u64       // body 129 → abs 137
 *   reserve_b:    u64       // body 137 → abs 145
 *   total_lp_shares: u128   // body 145 → abs 153
 *   fee_bps:      u16       // body 161 → abs 169
 *   is_active:    bool      // body 163 → abs 171
 *   ...
 *
 * Mirrors offsets pinned in scripts/lib/bootstrap-init.ts (RESERVE_A_OFFSET
 * = 137) and bots/.e2e/layer-10-scenario-{4,5}.test.ts. PRIOR LAYOUT here
 * was stale (assumed 32B `authority` prefix, no `pool_type` byte) — that
 * caused convert_to_rwt skip with "pool does not contain USDC mint" because
 * the wrong bytes were being matched against cfg.usdcMint.
 */
const POOL_OFFSET = {
  POOL_TYPE: 8,
  TOKEN_A_MINT: 8 + 1,
  TOKEN_B_MINT: 8 + 1 + 32,
  VAULT_A: 8 + 1 + 64,
  VAULT_B: 8 + 1 + 96,
  RESERVE_A: 8 + 1 + 128,
  RESERVE_B: 8 + 1 + 136,
  FEE_BPS: 8 + 1 + 160,
  IS_ACTIVE: 8 + 1 + 162,
} as const;

const POOL_MIN_LEN = 8 + 1 + 163;

export function parsePoolSnapshot(address: PublicKey, data: Buffer): PoolSnapshot | null {
  if (data.length < POOL_MIN_LEN) return null;
  const tokenAMint = new PublicKey(data.subarray(POOL_OFFSET.TOKEN_A_MINT, POOL_OFFSET.TOKEN_A_MINT + 32));
  const tokenBMint = new PublicKey(data.subarray(POOL_OFFSET.TOKEN_B_MINT, POOL_OFFSET.TOKEN_B_MINT + 32));
  const reserveA = data.readBigUInt64LE(POOL_OFFSET.RESERVE_A);
  const reserveB = data.readBigUInt64LE(POOL_OFFSET.RESERVE_B);
  const feeBps = data.readUInt16LE(POOL_OFFSET.FEE_BPS);
  const isActive = data.readUInt8(POOL_OFFSET.IS_ACTIVE) !== 0;
  return { address, tokenAMint, tokenBMint, reserveA, reserveB, feeBps, isActive };
}

export async function fetchPoolSnapshot(
  conn: Connection,
  poolPda: PublicKey,
): Promise<PoolSnapshot | null> {
  const info = await conn.getAccountInfo(poolPda, 'confirmed');
  if (!info) return null;
  return parsePoolSnapshot(poolPda, info.data);
}

/**
 * Parse a YD `MerkleDistributor` and extract `reward_vault` (32 bytes).
 *
 * Canonical MerkleDistributor body layout (contracts/yield-distribution/src/state.rs):
 *   pub ot_mint:          [u8;32]    // 0..32
 *   pub reward_vault:     [u8;32]    // 32..64
 *   pub accumulator:      [u8;32]    // 64..96
 *   pub merkle_root:      [u8;32]    // 96..128
 *   pub max_total_claim:  u64        // 128..136
 *   pub total_claimed:    u64        // 136..144
 *   pub total_funded:     u64        // 144..152
 *   ...
 *
 * Pinned via on-chain fixture in the parity test (R26). Prior reader had
 * stale offsets (assumed leading authority field) — returned `accumulator`
 * instead of `reward_vault`, which then mismatched the contract's
 * `distributor.reward_vault` constraint inside convert_to_rwt.
 */
export const DISTRIBUTOR_REWARD_VAULT_OFFSET_FROM_BODY = 32;

export async function fetchDistributorRewardVault(
  conn: Connection,
  distributorPda: PublicKey,
): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(distributorPda, 'confirmed');
  if (!info) return null;
  const start = 8 + DISTRIBUTOR_REWARD_VAULT_OFFSET_FROM_BODY;
  if (info.data.length < start + 32) return null;
  return new PublicKey(info.data.subarray(start, start + 32));
}

/**
 * Parse a YD singleton `DistributionConfig` and extract
 * `areal_fee_destination` (32 bytes).
 *
 * Canonical DistributionConfig body layout (yield-distribution state.rs):
 *   pub authority:                  [u8;32]    // 0..32
 *   pub pending_authority:          [u8;32]    // 32..64
 *   pub has_pending:                bool       // 64..65
 *   pub publish_authority:          [u8;32]    // 65..97
 *   pub protocol_fee_bps:           u16        // 97..99
 *   pub min_distribution_amount:    u64        // 99..107
 *   pub areal_fee_destination:      [u8;32]    // 107..139
 *   pub is_active:                  bool       // 139..140
 *   pub bump:                       u8         // 140..141
 *
 * The ATA returned here is RWT-denominated and owned by the protocol.
 * Prior reader had stale offsets (assumed `publish_authority` first, no
 * `authority` / `pending_authority` / `has_pending` prefix) and returned
 * `pending_authority` bytes (zeroed = SystemProgram pubkey) instead of the
 * fee destination — convert_to_rwt then reverted with "fee_account must
 * be writable" because the SystemProgram account isn't writable.
 */
export const YD_CONFIG_FEE_DEST_OFFSET_FROM_BODY = 107;

export async function fetchYdArealFeeDestination(
  conn: Connection,
  configPda: PublicKey,
): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(configPda, 'confirmed');
  if (!info) return null;
  const start = 8 + YD_CONFIG_FEE_DEST_OFFSET_FROM_BODY;
  if (info.data.length < start + 32) return null;
  return new PublicKey(info.data.subarray(start, start + 32));
}

/**
 * Parse a DEX singleton `DexConfig` and extract `areal_fee_destination`
 * (32 bytes — USDC-denominated; receives the DEX swap fee).
 *
 * Canonical DexConfig body layout (native-dex state.rs):
 *   pub authority:                  [u8;32]   // 0..32
 *   pub pending_authority:          [u8;32]   // 32..64
 *   pub has_pending:                bool      // 64..65
 *   pub pause_authority:            [u8;32]   // 65..97
 *   pub base_fee_bps:               u16       // 97..99
 *   pub lp_fee_share_bps:           u16       // 99..101
 *   pub areal_fee_destination:      [u8;32]   // 101..133
 *   pub rebalancer:                 [u8;32]   // 133..165
 *   pub is_active:                  bool      // 165..166
 *   pub bump:                       u8        // 166..167
 *
 * Prior reader had stale offset (32, assumed authority directly followed by
 * fee dest) — returned `pending_authority` bytes (zeroed = SystemProgram).
 */
export const DEX_CONFIG_FEE_DEST_OFFSET_FROM_BODY = 101;

export async function fetchDexArealFeeDestination(
  conn: Connection,
  dexConfigPda: PublicKey,
): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(dexConfigPda, 'confirmed');
  if (!info) return null;
  const start = 8 + DEX_CONFIG_FEE_DEST_OFFSET_FROM_BODY;
  if (info.data.length < start + 32) return null;
  return new PublicKey(info.data.subarray(start, start + 32));
}

/**
 * Parse the `RwtVault` body and extract the `(capital_accumulator_ata,
 * areal_fee_destination)` pair. Used by `convert_to_rwt` to identify
 * `rwt_capital_acc` and `rwt_dao_fee_account` accounts (both writable).
 *
 * Layout — see fetchNav above. We need:
 *   pub capital_accumulator_ata: [u8;32]    // body 32..64
 *   pub areal_fee_destination:   [u8;32]    // body 226..258
 */
export const RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY = 32;
export const RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY = 226;

export interface RwtVaultAccounts {
  capitalAccumulatorAta: PublicKey;
  arealFeeDestination: PublicKey;
}

export async function fetchRwtVaultAccounts(
  conn: Connection,
  rwtVaultPda: PublicKey,
): Promise<RwtVaultAccounts | null> {
  const info = await conn.getAccountInfo(rwtVaultPda, 'confirmed');
  if (!info) return null;
  if (info.data.length < 8 + 259) return null;
  const cap = new PublicKey(
    info.data.subarray(
      8 + RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY,
      8 + RWT_VAULT_CAPITAL_ACC_OFFSET_FROM_BODY + 32,
    ),
  );
  const fee = new PublicKey(
    info.data.subarray(
      8 + RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY,
      8 + RWT_VAULT_AREAL_FEE_DEST_OFFSET_FROM_BODY + 32,
    ),
  );
  return { capitalAccumulatorAta: cap, arealFeeDestination: fee };
}

/**
 * Resolve the (USDC-side, RWT-side) vault pair on a master pool, given the
 * canonical USDC mint. Returns `null` when neither pool token matches.
 */
export interface PoolUsdcSide {
  poolUsdcVault: PublicKey;
  poolRwtVault: PublicKey;
}

export function resolveUsdcSide(
  pool: PoolSnapshot,
  poolVaultA: PublicKey,
  poolVaultB: PublicKey,
  usdcMint: PublicKey,
): PoolUsdcSide | null {
  if (pool.tokenAMint.equals(usdcMint)) {
    return { poolUsdcVault: poolVaultA, poolRwtVault: poolVaultB };
  }
  if (pool.tokenBMint.equals(usdcMint)) {
    return { poolUsdcVault: poolVaultB, poolRwtVault: poolVaultA };
  }
  return null;
}

/**
 * Extract pool vaults A/B from PoolState data. Mirrors the offsets used by
 * `parsePoolSnapshot` (canonical PoolState — 8 disc + 1 pool_type prefix).
 */
export const POOL_VAULT_A_OFFSET = 8 + 1 + 64;  // 73
export const POOL_VAULT_B_OFFSET = 8 + 1 + 96;  // 105

export interface PoolAccountList {
  vaultA: PublicKey;
  vaultB: PublicKey;
}

export async function fetchPoolAccountList(
  conn: Connection,
  poolPda: PublicKey,
): Promise<PoolAccountList | null> {
  const info = await conn.getAccountInfo(poolPda, 'confirmed');
  if (!info) return null;
  if (info.data.length < POOL_VAULT_B_OFFSET + 32) return null;
  return {
    vaultA: new PublicKey(info.data.subarray(POOL_VAULT_A_OFFSET, POOL_VAULT_A_OFFSET + 32)),
    vaultB: new PublicKey(info.data.subarray(POOL_VAULT_B_OFFSET, POOL_VAULT_B_OFFSET + 32)),
  };
}
