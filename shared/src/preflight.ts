/**
 * R-60: shared SOL pre-flight check for off-chain cranks.
 *
 * Cranks must skip submission cleanly when their fee-payer keypair is
 * underfunded — otherwise sendTransaction returns a generic InsufficientFunds
 * the operator must trace through RPC logs. Centralising the check also
 * normalises the env-var override surface (`<CRANK>_MIN_SOL_LAMPORTS`).
 *
 * Decision contract:
 *   - { kind: 'ok' }                     → caller proceeds with submit.
 *   - { kind: 'skip', reason: 'low_sol' } → caller MUST NOT submit; surfaces
 *     balance + required lamports for operator-facing logs.
 *
 * Failure handling:
 *   - All MultiRpcClient endpoints failing collapses into a thrown
 *     `AggregateError`. We re-throw so the caller's outer cycle handler
 *     decides how to log; we don't silently bypass the gate (sec H-2).
 *
 * Default threshold: 0.05 SOL (50_000_000 lamports). Empirically covers
 * ~3 priority-fee'd Layer 8/9 transactions before the wallet drops below
 * the rent-exempt floor for a typical signature account; operators tighten
 * with the per-crank env override when running against a more expensive
 * cluster (mainnet priority).
 */

import type { PublicKey } from '@solana/web3.js';

import { MultiRpcClient } from './rpc-pool.js';

/** Default minimum lamports gate — 0.05 SOL. */
export const MIN_LAMPORTS_DEFAULT = 50_000_000;

export type AssertCrankBalanceResult =
  | { kind: 'ok'; balance: number }
  | { kind: 'skip'; reason: 'low_sol'; balance: number; required: number };

/**
 * Check whether `pubkey` holds at least `minLamports`. Routes the read
 * through `client.withFallback` so a single RPC flake does not bypass the
 * gate; an "all endpoints failed" outcome propagates as the underlying
 * AggregateError to the caller (R29 contract).
 */
export async function assertCrankBalance(
  client: MultiRpcClient,
  pubkey: PublicKey,
  minLamports: number = MIN_LAMPORTS_DEFAULT,
): Promise<AssertCrankBalanceResult> {
  const required = Math.max(0, Math.floor(minLamports));
  const balance = await client.withFallback((conn) =>
    conn.getBalance(pubkey, 'confirmed'),
  );
  if (balance < required) {
    return { kind: 'skip', reason: 'low_sol', balance, required };
  }
  return { kind: 'ok', balance };
}

/**
 * Convenience helper: read a per-crank override from `<CRANK>_MIN_SOL_LAMPORTS`
 * with a fallback to the default. Operators tune by setting e.g.
 * `REVENUE_MIN_SOL_LAMPORTS=100000000` for a 0.1 SOL gate.
 *
 * Invalid (non-positive integer) values fall through to the default — we'd
 * rather skip cleanly than refuse to start because of a typo.
 */
export function resolveMinLamportsFromEnv(
  crankPrefix: string,
  envSource: NodeJS.ProcessEnv = process.env,
): number {
  const key = `${crankPrefix.toUpperCase()}_MIN_SOL_LAMPORTS`;
  const raw = envSource[key];
  if (typeof raw !== 'string' || raw.length === 0) return MIN_LAMPORTS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MIN_LAMPORTS_DEFAULT;
  return parsed;
}
