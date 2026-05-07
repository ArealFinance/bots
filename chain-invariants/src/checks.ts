/**
 * Phase 22: on-chain invariant checks.
 *
 * Each `check*` function performs the RPC + decode for one invariant
 * and returns a `CheckOutcome<T>` discriminated union — `ok: true` with
 * the structured value, or `ok: false` with a string error. The poller
 * (index.ts) inspects `ok` to decide whether to update gauges or to
 * increment `chain_invariant_check_errors_total`. On `ok: false` the
 * previous gauge value is left in place: a transient RPC blip should
 * NOT reset the value to zero (which would silently cure the alert
 * state). Instead `chain_invariant_check_last_success_timestamp` ages
 * out and the meta-alert `ChainInvariantsCheckFailing` fires.
 *
 * All checks are stateless — restart-safe by construction (Q2 lock).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { parseMerkleDistributor } from '@areal/sdk/yield-distribution';
import { parseRwtVault } from '@areal/sdk/rwt-engine';
import { parseOtGovernance } from '@areal/sdk/ownership-token';
import { parseDexConfig } from '@areal/sdk/native-dex';
import { parseFutarchyConfig } from '@areal/sdk/futarchy';
import { parseDistributionConfig } from '@areal/sdk/yield-distribution';

// ---------- Result types ----------

export type CheckOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface MerkleRootAgeResult {
  distributorPubkey: string;
  ageSeconds: number;
  epoch: bigint;
  lastSignature: string;
}

export interface NavAgeResult {
  vaultPubkey: string;
  ageSeconds: number;
  navBookValue: bigint;
  totalRwtSupply: bigint;
  lastSignature: string;
}

export type ContractName =
  | 'ot_governance'
  | 'futarchy_config'
  | 'rwt_vault'
  | 'dex_config'
  | 'yd_distribution_config';

export const CONTRACT_NAMES: readonly ContractName[] = [
  'ot_governance',
  'futarchy_config',
  'rwt_vault',
  'dex_config',
  'yd_distribution_config',
] as const;

export interface AuthorityCheckResult {
  contract: ContractName;
  expected: string;
  actual: string;
  match: boolean;
}

export interface RwtSupplyResult {
  vaultPubkey: string;
  trackedSupply: bigint; // RwtVault.total_rwt_supply
  mintActualSupply: bigint; // mint account .supply
  drift: bigint; // |trackedSupply - mintActualSupply|
}

// ---------- Check context ----------

export interface CheckContext {
  connection: Connection;
  /** Injectable so tests can drive a deterministic clock. */
  nowSec: () => number;
}

// ---------- Internals ----------

/**
 * Pull the most recent signature touching `pda` and translate it into a
 * `(now − blockTime)` age in seconds. Used by both
 * `checkMerkleRootAge` (distributor PDA) and `checkNavAge` (vault PDA).
 *
 * Caveat per Q2 decision: this returns the timestamp of the LAST TX
 * touching the account, including admin TXs (e.g., `update_config`).
 * For the distributor that is fine — publish_root and fund_distributor
 * dominate the traffic. For the vault we accept the over-approximation
 * for v1: if the vault has had no activity in 24h the alert fires
 * correctly; an admin TX masking a stuck NAV updater is a known
 * false-negative tracked for Phase 23 (filter on inner-instruction
 * discriminator).
 */
export async function fetchLastTxAge(
  connection: Connection,
  pda: PublicKey,
  nowSec: number,
): Promise<{ ageSeconds: number; signature: string }> {
  const sigs = await connection.getSignaturesForAddress(pda, { limit: 1 });
  if (sigs.length === 0) {
    throw new Error('no_signatures');
  }
  const sig = sigs[0];
  if (!sig) {
    throw new Error('no_signatures');
  }
  // Prefer the blockTime returned alongside the signature; fall back to
  // an explicit `getBlockTime(slot)` call only when the RPC didn't
  // populate it (some older RPC nodes return null).
  let blockTime: number | null = sig.blockTime ?? null;
  if (blockTime === null) {
    blockTime = await connection.getBlockTime(sig.slot);
  }
  if (blockTime === null) {
    throw new Error('no_block_time');
  }
  return {
    ageSeconds: nowSec - blockTime,
    signature: sig.signature,
  };
}

// ---------- Check #1: Merkle root age ----------

export interface CheckMerkleRootAgeArgs {
  distributorPda: PublicKey;
}

export async function checkMerkleRootAge(
  ctx: CheckContext,
  args: CheckMerkleRootAgeArgs,
): Promise<CheckOutcome<MerkleRootAgeResult>> {
  try {
    const now = ctx.nowSec();
    const { ageSeconds, signature } = await fetchLastTxAge(
      ctx.connection,
      args.distributorPda,
      now,
    );
    // Decode the distributor for the epoch label (operator context).
    const info = await ctx.connection.getAccountInfo(args.distributorPda);
    if (!info) throw new Error('distributor_account_missing');
    const distributor = parseMerkleDistributor(info.data);
    return {
      ok: true,
      value: {
        distributorPubkey: args.distributorPda.toBase58(),
        ageSeconds,
        epoch: distributor.epoch,
        lastSignature: signature,
      },
    };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ---------- Check #2: NAV age ----------

export interface CheckNavAgeArgs {
  rwtVaultPda: PublicKey;
}

export async function checkNavAge(
  ctx: CheckContext,
  args: CheckNavAgeArgs,
): Promise<CheckOutcome<NavAgeResult>> {
  try {
    const now = ctx.nowSec();
    const { ageSeconds, signature } = await fetchLastTxAge(
      ctx.connection,
      args.rwtVaultPda,
      now,
    );
    const info = await ctx.connection.getAccountInfo(args.rwtVaultPda);
    if (!info) throw new Error('vault_account_missing');
    const vault = parseRwtVault(info.data);
    return {
      ok: true,
      value: {
        vaultPubkey: args.rwtVaultPda.toBase58(),
        ageSeconds,
        navBookValue: vault.navBookValue,
        totalRwtSupply: vault.totalRwtSupply,
        lastSignature: signature,
      },
    };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ---------- Check #3: Authority drift ----------

export interface CheckAuthoritiesArgs {
  otGovernancePda: PublicKey;
  futarchyConfigPda: PublicKey;
  rwtVaultPda: PublicKey;
  dexConfigPda: PublicKey;
  ydDistributionConfigPda: PublicKey;
  expected: Record<ContractName, PublicKey>;
}

/**
 * Read the `authority` field on each of the 5 contract config PDAs and
 * compare against the operator-supplied expected pubkey. Always returns
 * results for ALL 5 contracts, even if some fetches fail — partial
 * failures produce `{ match: false, actual: '<fetch_error>' }` so the
 * unknown-state is visible in the metric (-1) rather than silenced.
 */
export async function checkAuthorities(
  ctx: CheckContext,
  args: CheckAuthoritiesArgs,
): Promise<CheckOutcome<AuthorityCheckResult[]>> {
  // Wrapping the whole batch in try/catch is wrong — partial failures
  // must surface per-contract. We never throw at the top level here.
  //
  // Note: the SDK's typeRegistry decoder returns raw Buffer for pubkey
  // fields rather than @solana/web3.js PublicKey instances (the .d.ts
  // labels them PublicKey but at runtime they are Buffer). We coerce
  // via `new PublicKey(buffer)` before comparing.
  const targets: Array<{
    name: ContractName;
    pda: PublicKey;
    decode: (data: Buffer | Uint8Array) => { authority: unknown };
  }> = [
    {
      name: 'ot_governance',
      pda: args.otGovernancePda,
      decode: (data) => parseOtGovernance(data),
    },
    {
      name: 'futarchy_config',
      pda: args.futarchyConfigPda,
      decode: (data) => parseFutarchyConfig(data),
    },
    {
      name: 'rwt_vault',
      pda: args.rwtVaultPda,
      decode: (data) => parseRwtVault(data),
    },
    {
      name: 'dex_config',
      pda: args.dexConfigPda,
      decode: (data) => parseDexConfig(data),
    },
    {
      name: 'yd_distribution_config',
      pda: args.ydDistributionConfigPda,
      decode: (data) => parseDistributionConfig(data),
    },
  ];

  const results: AuthorityCheckResult[] = [];
  for (const t of targets) {
    const expected = args.expected[t.name];
    try {
      const info = await ctx.connection.getAccountInfo(t.pda);
      if (!info) {
        results.push({
          contract: t.name,
          expected: expected.toBase58(),
          actual: '<account_missing>',
          match: false,
        });
        continue;
      }
      const decoded = t.decode(info.data);
      const actualPk = toPublicKey(decoded.authority);
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: actualPk.toBase58(),
        match: actualPk.equals(expected),
      });
    } catch (err) {
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: `<fetch_error:${errMessage(err)}>`,
        match: false,
      });
    }
  }
  return { ok: true, value: results };
}

// ---------- Check #4: RWT supply parity ----------

export interface CheckRwtSupplyArgs {
  rwtVaultPda: PublicKey;
}

export async function checkRwtSupply(
  ctx: CheckContext,
  args: CheckRwtSupplyArgs,
): Promise<CheckOutcome<RwtSupplyResult>> {
  try {
    const info = await ctx.connection.getAccountInfo(args.rwtVaultPda);
    if (!info) throw new Error('vault_account_missing');
    const vault = parseRwtVault(info.data);
    const tracked = vault.totalRwtSupply;
    const mintPk = toPublicKey(vault.rwtMint);
    const supplyResp = await ctx.connection.getTokenSupply(mintPk);
    const mintActual = BigInt(supplyResp.value.amount);
    const drift = tracked > mintActual ? tracked - mintActual : mintActual - tracked;
    return {
      ok: true,
      value: {
        vaultPubkey: args.rwtVaultPda.toBase58(),
        trackedSupply: tracked,
        mintActualSupply: mintActual,
        drift,
      },
    };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ---------- Helpers ----------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coerce the raw value returned by the SDK's typeRegistry decoder for a
 * pubkey field into a `PublicKey`. The decoder returns either:
 *   - a `Buffer` of length 32 (when the field type is `[u8; 32]`),
 *   - or a `PublicKey` instance (when the SDK was generated against a
 *     newer codegen that already wraps it).
 * Both shapes are accepted by the `PublicKey` constructor, but we only
 * call `new PublicKey(...)` if the value is not already an instance —
 * the constructor short-circuits cheaply on PublicKey input but
 * throws clearer error messages for invalid Buffer lengths.
 */
function toPublicKey(value: unknown): PublicKey {
  if (value instanceof PublicKey) return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return new PublicKey(value);
  }
  // Last-resort: let the PublicKey constructor throw a useful error.
  return new PublicKey(value as ConstructorParameters<typeof PublicKey>[0]);
}
