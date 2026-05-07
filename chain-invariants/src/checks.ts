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
import {
  OWNERSHIP_TOKEN_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  NATIVE_DEX_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
} from '@areal/sdk';

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

/**
 * Authority check outcome per contract.
 *
 * Outcome semantics (used by index.ts to set the
 * `chain_invariant_authority_match` gauge):
 *
 *   - `match`            — actual authority equals expected → metric=1
 *   - `drift`            — successful read, authority differs → metric=0
 *                          (real on-chain authority change — fires AuthorityDrift)
 *   - `decode_error`     — account read OK, but bytes are malformed (wrong
 *                          discriminator, etc.) → metric=0
 *                          (treated as drift: account at this PDA is no longer
 *                          the expected config struct → substitution attempt
 *                          or program upgrade with breaking layout change)
 *   - `account_not_found`— `getAccountInfo` returned null at the expected PDA
 *                          → metric=0 (the config simply isn't there anymore;
 *                          treat as drift, NOT unknown)
 *   - `wrong_owner`      — account exists but is owned by a different program
 *                          than expected → metric=0
 *                          (account substitution: someone closed our PDA and
 *                          another program created an account at the same
 *                          address — defense-in-depth on top of discriminator)
 *   - `rpc_error`        — network/RPC failure (timeout, connection refused,
 *                          response parse error) → metric=-1
 *                          (transient infrastructure issue — do NOT treat as
 *                          drift; the meta-alert ChainInvariantsCheckFailing
 *                          fires after 5m of repeated failure)
 *
 * Note on the alert design: `chain_invariant_authority_match == 0` (drift)
 * MUST fire on any of `drift | decode_error | account_not_found | wrong_owner`,
 * but MUST NOT fire on `rpc_error`. That is why `rpc_error` is the only
 * outcome that maps to `-1` (`unable_to_fetch`).
 */
export type AuthorityOutcome =
  | 'match'
  | 'drift'
  | 'decode_error'
  | 'account_not_found'
  | 'wrong_owner'
  | 'rpc_error';

export interface AuthorityCheckResult {
  contract: ContractName;
  expected: string;
  actual: string;
  match: boolean;
  outcome: AuthorityOutcome;
}

/** Map an outcome to the gauge value documented above. */
export function authorityOutcomeToMetricValue(outcome: AuthorityOutcome): number {
  switch (outcome) {
    case 'match':
      return 1;
    case 'drift':
    case 'decode_error':
    case 'account_not_found':
    case 'wrong_owner':
      return 0;
    case 'rpc_error':
      return -1;
  }
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
 * failures surface per-contract via `outcome`.
 *
 * Per-contract outcomes (see `AuthorityOutcome` for full semantics):
 *   - rpc_error          → metric=-1 (transient infra failure)
 *   - account_not_found  → metric=0  (account literally missing — drift)
 *   - wrong_owner        → metric=0  (defense-in-depth: explicit owner check
 *                                     on top of the SDK's discriminator
 *                                     validation; catches account
 *                                     substitution where another program
 *                                     squatted the PDA address)
 *   - decode_error       → metric=0  (malformed bytes — treat as drift)
 *   - drift              → metric=0  (authority differs from expected)
 *   - match              → metric=1  (steady state)
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
    expectedOwner: PublicKey;
    decode: (data: Buffer | Uint8Array) => { authority: unknown };
  }> = [
    {
      name: 'ot_governance',
      pda: args.otGovernancePda,
      expectedOwner: OWNERSHIP_TOKEN_PROGRAM_ID,
      decode: (data) => parseOtGovernance(data),
    },
    {
      name: 'futarchy_config',
      pda: args.futarchyConfigPda,
      expectedOwner: FUTARCHY_PROGRAM_ID,
      decode: (data) => parseFutarchyConfig(data),
    },
    {
      name: 'rwt_vault',
      pda: args.rwtVaultPda,
      expectedOwner: RWT_ENGINE_PROGRAM_ID,
      decode: (data) => parseRwtVault(data),
    },
    {
      name: 'dex_config',
      pda: args.dexConfigPda,
      expectedOwner: NATIVE_DEX_PROGRAM_ID,
      decode: (data) => parseDexConfig(data),
    },
    {
      name: 'yd_distribution_config',
      pda: args.ydDistributionConfigPda,
      expectedOwner: YIELD_DISTRIBUTION_PROGRAM_ID,
      decode: (data) => parseDistributionConfig(data),
    },
  ];

  const results: AuthorityCheckResult[] = [];
  for (const t of targets) {
    const expected = args.expected[t.name];
    let info: Awaited<ReturnType<typeof ctx.connection.getAccountInfo>>;
    try {
      info = await ctx.connection.getAccountInfo(t.pda);
    } catch (err) {
      // Network/RPC failure: timeout, ECONNREFUSED, malformed JSON-RPC.
      // This is transient infra — distinct from "the account is gone".
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: `<rpc_error:${errMessage(err)}>`,
        match: false,
        outcome: 'rpc_error',
      });
      continue;
    }
    if (!info) {
      // Successful RPC, account simply doesn't exist at this PDA. The
      // operator pinned a PDA that's not on chain — treat as drift.
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: '<account_not_found>',
        match: false,
        outcome: 'account_not_found',
      });
      continue;
    }
    // Defense-in-depth (I2): explicit owner check before decoding. The
    // SDK's discriminator validation in parseXxx provides one layer; if
    // an attacker (or a misconfigured operator) pinned a PDA owned by a
    // foreign program that happens to have a colliding 8-byte
    // discriminator, the owner check catches it. Owner mismatch is
    // STRUCTURAL fraud, NOT a transient error.
    if (!info.owner.equals(t.expectedOwner)) {
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: `<wrong_owner:${info.owner.toBase58()}>`,
        match: false,
        outcome: 'wrong_owner',
      });
      continue;
    }
    let decoded: { authority: unknown };
    try {
      decoded = t.decode(info.data);
    } catch (err) {
      // Owner OK but the bytes don't decode (wrong discriminator,
      // truncated buffer, layout drift after a contract upgrade we
      // missed). Treat as drift, not rpc_error — RPC delivered the
      // bytes; the data itself is malformed.
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: `<decode_error:${errMessage(err)}>`,
        match: false,
        outcome: 'decode_error',
      });
      continue;
    }
    let actualPk: PublicKey;
    try {
      actualPk = toPublicKey(decoded.authority);
    } catch (err) {
      // The decoder returned something we can't coerce into PublicKey —
      // same class of failure as decode_error.
      results.push({
        contract: t.name,
        expected: expected.toBase58(),
        actual: `<decode_error:${errMessage(err)}>`,
        match: false,
        outcome: 'decode_error',
      });
      continue;
    }
    const matches = actualPk.equals(expected);
    results.push({
      contract: t.name,
      expected: expected.toBase58(),
      actual: actualPk.toBase58(),
      match: matches,
      outcome: matches ? 'match' : 'drift',
    });
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
