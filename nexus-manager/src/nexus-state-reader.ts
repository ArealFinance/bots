/**
 * On-chain reads for the nexus-manager bot.
 *
 * The exported parsers are thin wrappers over `@areal/sdk/native-dex`
 * codegen parsers (Phase 4.2 B.6 — SDK ships first-class parsers since
 * Phase 3.5). The bot's wrappers project the bot's narrow `PoolStateInfo`
 * subset (the decision engine never reads bin/treasury fields).
 *
 * As of `@arlex/client@0.3.1` (Phase 3.5 C.3), the SDK runtime wraps
 * pubkey-overridden `[u8; 32]` fields as `PublicKey` instances directly,
 * so the bot no longer needs a `toPublicKey` adapter — fields like
 * `manager`, `pool`, `owner`, `tokenAMint`, `vaultA` come back ready
 * to use with `.equals` / `.toBuffer` / `.toBase58`.
 *
 * Critical-state reads (`readLiquidityNexus`) use {@link consensusRead} from
 * `@areal/bots-shared` so that a single misbehaving RPC cannot cause the bot
 * to issue a Manager TX against a phantom state. Routine reads (per-pool
 * scans) fall back to a single-endpoint primary because per-pool drift is
 * tolerated by the on-chain re-validation inside each Nexus ix.
 *
 * Layout sources (see `contracts/native-dex/src/state.rs`):
 *   - `LiquidityNexus`: 8-byte arlex discriminator + 50-byte body.
 *   - `LpPosition`:    8 + 121 bytes (Layer 9 D28).
 *   - `PoolState`:     8 + 244 bytes (Layer 9 D28).
 *   - SPL Token Account: 165 bytes (`amount` at bytes 64..72 LE) — the only
 *     non-program-account read still done locally.
 */

import { Connection, PublicKey } from '@solana/web3.js';

import { consensusRead, type MultiRpcClient } from '@areal/bots-shared';
import {
  findDexConfigPda,
  findLiquidityNexusPda,
  findLpPositionPda,
} from '@areal/sdk/pda';
import {
  parseLiquidityNexus as sdkParseLiquidityNexus,
  parseLpPosition as sdkParseLpPosition,
  parsePoolState as sdkParsePoolState,
} from '@areal/sdk/native-dex';

import type {
  LiquidityNexusState,
  LpPositionState,
  PoolStateInfo,
} from './types.js';

const SPL_TOKEN_ACCOUNT_LEN = 165;

/**
 * Derive the singleton `LiquidityNexus` PDA address under the given DEX
 * program. Thin wrapper that adapts the SDK's `[PublicKey, number]` tuple
 * to this bot's existing single-PublicKey return shape.
 */
export function deriveLiquidityNexusPda(dexProgramId: PublicKey): PublicKey {
  return findLiquidityNexusPda(dexProgramId)[0];
}

/** Derive `["dex_config"]` singleton under the DEX program. */
export function deriveDexConfigPda(dexProgramId: PublicKey): PublicKey {
  return findDexConfigPda(dexProgramId)[0];
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
  return findLpPositionPda(pool, owner, dexProgramId)[0];
}

/**
 * Parse `LiquidityNexus` raw account data (8-byte discriminator + 50-byte
 * body). Validates the IDL discriminator and throws on mismatch or length
 * underflow — caller must catch.
 *
 * Phase 4.2 B.6 — delegates to `@areal/sdk/native-dex` codegen parser
 * (Phase 3.5 unblocked SDK first-class parsers). As of `@arlex/client@0.3.1`
 * the SDK returns `manager` as a `PublicKey` directly (runtime pubkey
 * wrapping); the bot wrapper just narrows to the bot's local type.
 *
 * Layout (per `contracts/native-dex/src/state.rs::LiquidityNexus`):
 *   manager              [u8;32]  → 0..32
 *   total_deposited_usdc u64      → 32..40
 *   total_deposited_rwt  u64      → 40..48
 *   is_active            bool     → 48
 *   bump                 u8       → 49
 */
export function parseLiquidityNexus(data: Buffer): LiquidityNexusState {
  const raw = sdkParseLiquidityNexus(data);
  return {
    manager: raw.manager,
    totalDepositedUsdc: raw.totalDepositedUsdc,
    totalDepositedRwt: raw.totalDepositedRwt,
    isActive: raw.isActive,
    bump: raw.bump,
  };
}

/**
 * Parse `LpPosition` raw account data (8-byte discriminator + 121-byte body).
 *
 * Phase 4.2 B.6 — delegates to `@areal/sdk/native-dex`. As of
 * `@arlex/client@0.3.1` the SDK returns `pool` and `owner` as `PublicKey`
 * directly — no adapter needed.
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
  const raw = sdkParseLpPosition(data);
  return {
    pool: raw.pool,
    owner: raw.owner,
    shares: raw.shares,
    lastUpdateTs: raw.lastUpdateTs,
    bump: raw.bump,
    feesClaimedPerShareA: raw.feesClaimedPerShareA,
    feesClaimedPerShareB: raw.feesClaimedPerShareB,
  };
}

/**
 * Parse the subset of `PoolState` fields the decision engine needs.
 *
 * Phase 4.2 B.6 — delegates to `@areal/sdk/native-dex` and projects the
 * subset (mints, vaults, reserves, totalLpShares, isActive, fee
 * accumulators). SDK parses all 17 fields incl. D28 LP-fee accumulators;
 * we keep the bot's narrow surface to limit the consumer-facing change.
 *
 * As of `@arlex/client@0.3.1` the SDK returns mint/vault `[u8;32]` fields
 * as `PublicKey` directly — no adapter needed.
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
  const raw = sdkParsePoolState(data);
  return {
    pool,
    tokenAMint: raw.tokenAMint,
    tokenBMint: raw.tokenBMint,
    vaultA: raw.vaultA,
    vaultB: raw.vaultB,
    reserveA: raw.reserveA,
    reserveB: raw.reserveB,
    totalLpShares: raw.totalLpShares,
    isActive: raw.isActive,
    // Fee-on-top compliance (docs/contracts/native-dex.mdx:522-568) — the
    // decision engine needs both `fee_bps` and `has_ot_treasury` to size
    // `amount_in` so that the Nexus ATA reserves fee headroom for the
    // sell-RWT inbound vault debit (`amount_in + fee_total + ot_treasury_fee`).
    feeBps: raw.feeBps,
    hasOtTreasury: raw.hasOtTreasury,
    cumulativeFeesPerShareA: raw.cumulativeFeesPerShareA,
    cumulativeFesPerShareB: raw.cumulativeFeesPerShareB,
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

