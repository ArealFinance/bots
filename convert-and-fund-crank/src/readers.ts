import { Connection, PublicKey } from '@solana/web3.js';
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

/** PDA seed for `Accumulator` (yield-distribution). */
export const ACCUMULATOR_SEED = Buffer.from('accumulator');
/** PDA seed for `MerkleDistributor` (yield-distribution). */
export const MERKLE_DIST_SEED = Buffer.from('merkle_dist');
/** PDA seed for the singleton `DistributionConfig` (yield-distribution). */
export const DIST_CONFIG_SEED = Buffer.from('dist_config');
/** PDA seed for the RWT engine vault (singleton). */
export const RWT_VAULT_SEED = Buffer.from('rwt_vault');
/** PDA seed for the RWT engine `RwtDistributionConfig` (singleton). */
export const RWT_DIST_CONFIG_SEED = Buffer.from('dist_config_rwt');

export function deriveAccumulatorPda(otMint: PublicKey, ydProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ACCUMULATOR_SEED, otMint.toBuffer()],
    ydProgramId,
  )[0];
}

export function deriveDistributorPda(otMint: PublicKey, ydProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [MERKLE_DIST_SEED, otMint.toBuffer()],
    ydProgramId,
  )[0];
}

export function deriveDistConfigPda(ydProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DIST_CONFIG_SEED], ydProgramId)[0];
}

export function deriveRwtVaultPda(rwtEngineProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([RWT_VAULT_SEED], rwtEngineProgramId)[0];
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
 * RwtVault layout (rwt-engine state.rs) keeps `nav_book_value` near the top
 * of the struct. We read it at a known offset from the discriminator.
 *
 * NOTE: this offset is dependent on the RwtVault layout — if the contract
 * struct changes, the test in `slippage.test.ts` will not catch it; only an
 * E2E run will. The architecture flagged this as Step-10 follow-up.
 *
 * Current layout (after 8-byte discriminator):
 *   pub authority: [u8;32]              // 0..32
 *   pub pending_authority: [u8;32]       // 32..64
 *   pub has_pending: bool                // 64
 *   pub vault_manager: [u8;32]           // 65..97
 *   pub capital_acc: [u8;32]             // 97..129
 *   pub dao_fee_account: [u8;32]         // 129..161
 *   pub total_invested_capital: u64      // 161..169
 *   pub total_rwt_supply: u64            // 169..177
 *   pub nav_book_value: u64              // 177..185
 *   ...
 *
 * If the layout above is wrong, the bot picks an unrealistic NAV and the
 * on-chain `min_rwt_out` slippage check will reject — failure is loud, not
 * silent.
 */
export const NAV_OFFSET_FROM_BODY = 177;

export async function fetchNav(conn: Connection, rwtVaultPda: PublicKey): Promise<bigint | null> {
  const info = await conn.getAccountInfo(rwtVaultPda, 'confirmed');
  if (!info) return null;
  if (info.data.length < 8 + NAV_OFFSET_FROM_BODY + 8) return null;
  return info.data.readBigUInt64LE(8 + NAV_OFFSET_FROM_BODY);
}

/**
 * Parse a DEX classic `PoolState` and return the trading-relevant fields.
 *
 * Classic pool layout (native-dex state.rs, 8 disc + body):
 *   pub authority:    [u8;32]   // 0..32
 *   pub token_a_mint: [u8;32]   // 32..64
 *   pub token_b_mint: [u8;32]   // 64..96
 *   pub vault_a:      [u8;32]   // 96..128
 *   pub vault_b:      [u8;32]   // 128..160
 *   pub reserve_a:    u64       // 160..168
 *   pub reserve_b:    u64       // 168..176
 *   pub fee_bps:      u16       // 176..178
 *   pub pool_type:    u8        // 178
 *   pub is_active:    bool      // 179
 *   ... (concentrated-pool fields follow)
 *
 * Match the on-chain pool layout used in `convert_to_rwt`. The byte offsets
 * here mirror the comments in `architecture §8.2`. For Concentrated pools
 * the `reserve_*` / `fee_bps` fields share the same offsets — we only read
 * the classic-shared prefix, so concentrated pools are fine too.
 */
const POOL_OFFSET = {
  TOKEN_A_MINT: 8 + 32,
  TOKEN_B_MINT: 8 + 64,
  RESERVE_A: 8 + 160,
  RESERVE_B: 8 + 168,
  FEE_BPS: 8 + 176,
  IS_ACTIVE: 8 + 179,
} as const;

const POOL_MIN_LEN = 8 + 180;

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
