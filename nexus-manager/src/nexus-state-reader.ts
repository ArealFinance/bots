/**
 * On-chain reads for the nexus-manager bot.
 *
 * The exported parsers are pure functions over `Buffer` slices so they can
 * be unit-tested without spinning up a Solana RPC.
 *
 * Critical-state reads (`readLiquidityNexus`) use {@link consensusRead} from
 * `@areal/bots-shared` so that a single misbehaving RPC cannot cause the bot
 * to issue a Manager TX against a phantom state. Routine reads (per-pool
 * scans) fall back to a single-endpoint primary because per-pool drift is
 * tolerated by the on-chain re-validation inside each Nexus ix.
 *
 * Layout sources:
 *   - `LiquidityNexus`: 8-byte arlex discriminator + 50-byte body
 *     (32 manager + 8 total_deposited_usdc + 8 total_deposited_rwt + 1
 *     is_active + 1 bump). See `contracts/native-dex/src/state.rs`.
 *   - `LpPosition`:    8 + 121 bytes (32 pool + 32 owner + 16 shares +
 *     8 last_update_ts + 1 bump + 16 fees_claimed_per_share_a + 16
 *     fees_claimed_per_share_b).
 *   - `PoolState`:     8 + 244 bytes (Layer 9 D28 layout).
 *   - SPL Token Account: 165 bytes (`amount` at bytes 64..72 LE).
 */

import { Connection, PublicKey } from '@solana/web3.js';

import { consensusRead, type MultiRpcClient } from '@areal/bots-shared';

import type {
  LiquidityNexusState,
  LpPositionState,
  PoolStateInfo,
} from './types.js';

/** PDA seed for the singleton `LiquidityNexus`. */
export const LIQUIDITY_NEXUS_SEED = Buffer.from('liquidity_nexus');
/** PDA seed prefix for `LpPosition` (`["lp", pool, owner]`). */
export const LP_POSITION_SEED = Buffer.from('lp');
/** PDA seed for the `DexConfig` singleton. */
export const DEX_CONFIG_SEED = Buffer.from('dex_config');

const LIQUIDITY_NEXUS_BODY_LEN = 50;
const LP_POSITION_BODY_LEN = 121;
const POOL_STATE_BODY_LEN = 244;
const SPL_TOKEN_ACCOUNT_LEN = 165;

const ANCHOR_DISCRIMINATOR_LEN = 8;

/**
 * Derive the singleton `LiquidityNexus` PDA address under the given DEX
 * program. Pure function — no I/O.
 */
export function deriveLiquidityNexusPda(dexProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([LIQUIDITY_NEXUS_SEED], dexProgramId);
  return pda;
}

/** Derive `["dex_config"]` singleton under the DEX program. */
export function deriveDexConfigPda(dexProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([DEX_CONFIG_SEED], dexProgramId);
  return pda;
}

/**
 * Derive `["lp", pool, owner]` PDA under the DEX program. For Nexus-owned
 * positions, `owner` equals the LiquidityNexus PDA address.
 */
export function deriveLpPositionPda(
  dexProgramId: PublicKey,
  pool: PublicKey,
  owner: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LP_POSITION_SEED, pool.toBuffer(), owner.toBuffer()],
    dexProgramId,
  );
  return pda;
}

/**
 * Parse `LiquidityNexus` raw account data (8-byte discriminator + 50-byte
 * body). Throws on length mismatch — caller must catch.
 *
 * Layout (per `contracts/native-dex/src/state.rs::LiquidityNexus`):
 *   manager              [u8;32]  → 0..32
 *   total_deposited_usdc u64      → 32..40
 *   total_deposited_rwt  u64      → 40..48
 *   is_active            bool     → 48
 *   bump                 u8       → 49
 */
export function parseLiquidityNexus(data: Buffer): LiquidityNexusState {
  if (data.length < ANCHOR_DISCRIMINATOR_LEN + LIQUIDITY_NEXUS_BODY_LEN) {
    throw new Error(
      `LiquidityNexus: expected ≥${ANCHOR_DISCRIMINATOR_LEN + LIQUIDITY_NEXUS_BODY_LEN} bytes, got ${data.length}`,
    );
  }
  const body = data.subarray(ANCHOR_DISCRIMINATOR_LEN);
  const manager = new PublicKey(body.subarray(0, 32));
  const totalDepositedUsdc = body.readBigUInt64LE(32);
  const totalDepositedRwt = body.readBigUInt64LE(40);
  const isActive = body.readUInt8(48) !== 0;
  const bump = body.readUInt8(49);
  return {
    manager,
    totalDepositedUsdc,
    totalDepositedRwt,
    isActive,
    bump,
  };
}

/**
 * Parse `LpPosition` raw account data (8-byte discriminator + 121-byte body).
 *
 * Layout (per `contracts/native-dex/src/state.rs::LpPosition`):
 *   pool                       [u8;32] → 0..32
 *   owner                      [u8;32] → 32..64
 *   shares                     u128    → 64..80
 *   last_update_ts             i64     → 80..88
 *   bump                       u8      → 88
 *   fees_claimed_per_share_a   u128    → 89..105
 *   fees_claimed_per_share_b   u128    → 105..121
 */
export function parseLpPosition(data: Buffer): LpPositionState {
  if (data.length < ANCHOR_DISCRIMINATOR_LEN + LP_POSITION_BODY_LEN) {
    throw new Error(
      `LpPosition: expected ≥${ANCHOR_DISCRIMINATOR_LEN + LP_POSITION_BODY_LEN} bytes, got ${data.length}`,
    );
  }
  const body = data.subarray(ANCHOR_DISCRIMINATOR_LEN);
  const pool = new PublicKey(body.subarray(0, 32));
  const owner = new PublicKey(body.subarray(32, 64));
  const shares = readU128LE(body, 64);
  const lastUpdateTs = body.readBigInt64LE(80);
  const bump = body.readUInt8(88);
  const feesClaimedPerShareA = readU128LE(body, 89);
  const feesClaimedPerShareB = readU128LE(body, 105);
  return {
    pool,
    owner,
    shares,
    lastUpdateTs,
    bump,
    feesClaimedPerShareA,
    feesClaimedPerShareB,
  };
}

/**
 * Parse the subset of `PoolState` fields the decision engine needs.
 *
 * Layout offsets (Layer 9 D28 — body 244 bytes):
 *   pool_type            u8       → 0
 *   token_a_mint         [u8;32]  → 1..33
 *   token_b_mint         [u8;32]  → 33..65
 *   vault_a              [u8;32]  → 65..97
 *   vault_b              [u8;32]  → 97..129
 *   reserve_a            u64      → 129..137
 *   reserve_b            u64      → 137..145
 *   total_lp_shares      u128     → 145..161
 *   fee_bps              u16      → 161..163
 *   is_active            bool     → 163
 *   total_fees_accumulated u64    → 164..172
 *   bin_step_bps         u16      → 172..174
 *   active_bin_id        i32      → 174..178
 *   ot_treasury_fee_destination [u8;32] → 178..210
 *   has_ot_treasury      bool     → 210
 *   bump                 u8       → 211
 *   cumulative_fees_per_share_a u128 → 212..228
 *   cumulative_fees_per_share_b u128 → 228..244
 */
export function parsePoolStateInfo(data: Buffer, pool: PublicKey): PoolStateInfo {
  if (data.length < ANCHOR_DISCRIMINATOR_LEN + POOL_STATE_BODY_LEN) {
    throw new Error(
      `PoolState: expected ≥${ANCHOR_DISCRIMINATOR_LEN + POOL_STATE_BODY_LEN} bytes, got ${data.length}`,
    );
  }
  const body = data.subarray(ANCHOR_DISCRIMINATOR_LEN);
  const tokenAMint = new PublicKey(body.subarray(1, 33));
  const tokenBMint = new PublicKey(body.subarray(33, 65));
  const vaultA = new PublicKey(body.subarray(65, 97));
  const vaultB = new PublicKey(body.subarray(97, 129));
  const reserveA = body.readBigUInt64LE(129);
  const reserveB = body.readBigUInt64LE(137);
  const totalLpShares = readU128LE(body, 145);
  const isActive = body.readUInt8(163) !== 0;
  const cumulativeFeesPerShareA = readU128LE(body, 212);
  const cumulativeFesPerShareB = readU128LE(body, 228);
  return {
    pool,
    tokenAMint,
    tokenBMint,
    vaultA,
    vaultB,
    reserveA,
    reserveB,
    totalLpShares,
    isActive,
    cumulativeFeesPerShareA,
    cumulativeFesPerShareB,
  };
}

/**
 * Read SPL Token Account `amount` (bytes 64..72 LE). Returns 0n if the
 * account does not exist (not initialised yet).
 */
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
 * Read the singleton `LiquidityNexus` PDA via 3-of-5-style consensus (or
 * 2-of-3 / 1-of-1 fallback when fewer endpoints are configured).
 *
 * This is the most security-critical read in the bot — `manager`,
 * `is_active`, and `total_deposited_*` all gate downstream actions.
 */
export async function readLiquidityNexus(
  client: MultiRpcClient,
  nexusPda: PublicKey,
): Promise<LiquidityNexusState> {
  return consensusRead(
    client,
    async conn => {
      const info = await conn.getAccountInfo(nexusPda, 'confirmed');
      if (!info) {
        throw new Error(`LiquidityNexus PDA not initialised at ${nexusPda.toBase58()}`);
      }
      return parseLiquidityNexus(info.data);
    },
    {
      // 3-of-5 default with floor on smaller pools — degenerate to single-endpoint
      // only when explicitly configured. Comparator is the default BigInt-aware
      // canonicaliser; PublicKey serialises identically across endpoints.
      quorum: Math.max(1, Math.min(3, client.size())),
      comparator: liquidityNexusEqual,
    },
  );
}

/**
 * Single-endpoint read of one `LpPosition` account. Returns `null` if the
 * account is uninitialised — the Nexus may not have a position on a given
 * pool yet.
 *
 * Routine read (no consensus): per-pool drift is tolerated by the on-chain
 * re-check inside `nexus_remove_liquidity` / `nexus_add_liquidity`.
 */
export async function readLpPosition(
  client: MultiRpcClient,
  lpPda: PublicKey,
): Promise<LpPositionState | null> {
  return client.withFallback(async conn => {
    const info = await conn.getAccountInfo(lpPda, 'confirmed');
    if (!info) return null;
    return parseLpPosition(info.data);
  });
}

/**
 * Bulk read pool states for the decision engine. Returns one entry per
 * pool, in the same order as the input — `null` for uninitialised pools.
 */
export async function readPoolStates(
  client: MultiRpcClient,
  pools: PublicKey[],
): Promise<(PoolStateInfo | null)[]> {
  if (pools.length === 0) return [];
  return client.withFallback(async conn => {
    const infos = await conn.getMultipleAccountsInfo(pools, 'confirmed');
    return infos.map((info, i) => {
      if (!info) return null;
      const pool = pools[i];
      if (!pool) return null;
      return parsePoolStateInfo(info.data, pool);
    });
  });
}

/**
 * Comparator for `LiquidityNexusState` — compares by serialisable fields
 * (manager base58 + numeric counters + flags). Avoids the default
 * `JSON.stringify` pitfall where `PublicKey` instances may serialise as
 * `{_bn: ...}` with non-deterministic ordering.
 */
function liquidityNexusEqual(a: LiquidityNexusState, b: LiquidityNexusState): boolean {
  return (
    a.manager.equals(b.manager) &&
    a.totalDepositedUsdc === b.totalDepositedUsdc &&
    a.totalDepositedRwt === b.totalDepositedRwt &&
    a.isActive === b.isActive &&
    a.bump === b.bump
  );
}

/**
 * Read a little-endian u128 from a Buffer at `offset`. Node has no native
 * `readBigUInt128LE`, so we splice two u64 reads.
 */
function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}
