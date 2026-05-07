/**
 * Phase 21: classify TX-submit errors into the locked 5-value `result`
 * label union. Pure function — no side effects, no logging.
 *
 * Detection rules (architect note 4):
 *   - SendTransactionError + logs containing `Program log: AnchorError`
 *     OR `custom program error` → onchain_error
 *   - TransactionExpiredBlockheightExceededError → timeout
 *   - Connection refused / fetch failed / HTTP 5xx → rpc_error
 *   - Preflight simulation failure (no logs, but `failed to simulate
 *     transaction`) → sim_error
 *   - Any unmatched error → rpc_error (safe default — operator surfaces
 *     it via Grafana panel "rpc_error rate by bot").
 *
 * Walks `err.cause` chains so modern Node `Error(msg, { cause })` patterns
 * (used by undici, fetch, and several Solana web3 helpers) classify
 * correctly even when the root cause is wrapped one level deep.
 */

import type { TxResult } from './metrics.js';

interface SolanaErrorLike {
  name?: string;
  message?: string;
  logs?: unknown;
  /** Some web3.js errors stash the original on `cause`. */
  cause?: unknown;
  /** sendAndConfirmTransaction blockhash-expired error stores blockhash here. */
  blockhash?: string;
  signature?: string;
}

const ANCHOR_LOG_PATTERNS: readonly RegExp[] = [
  /Program log: AnchorError/i,
  /custom program error/i,
  /failed: custom program error/i,
];

const RPC_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /fetch failed/i,
  /failed to fetch/i,
  /socket hang up/i,
  /network request failed/i,
  /\b5\d{2}\b/, // any 5xx token in the message
  /Service Unavailable/i,
  /Bad Gateway/i,
];

const SIM_PATTERNS: readonly RegExp[] = [
  /failed to simulate transaction/i,
  /simulation failed/i,
  /Transaction simulation failed/i,
];

/**
 * Walk a chain of `error.cause` values, collecting names, messages and
 * `logs` arrays into a single search corpus. Bounded to 10 levels so a
 * pathological self-referential cause cannot loop forever.
 *
 * SECURITY (Phase 21.5 INFO 9a): only string-typed `message` and `logs[i]`
 * entries are appended to the corpus. The previous implementation called
 * `String(...)` blindly which would invoke a hostile `toString()` on a
 * crafted object and let it influence classification — a low-impact but
 * easily eliminated vector. Non-strings are treated as empty.
 */
function collectErrorText(err: unknown): { name: string; text: string } {
  let name = '';
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur != null && !seen.has(cur); i++) {
    seen.add(cur);
    const e = cur as SolanaErrorLike;
    if (!name && typeof e.name === 'string') name = e.name;
    if (typeof e.message === 'string') parts.push(e.message);
    if (Array.isArray(e.logs)) {
      for (const ln of e.logs as unknown[]) {
        if (typeof ln === 'string') parts.push(ln);
      }
    }
    cur = e.cause;
  }
  return { name, text: parts.join('\n') };
}

export function classifyError(err: unknown): TxResult {
  if (err == null) return 'ok';

  const { name, text: corpus } = collectErrorText(err);
  const allText = corpus || String(err);

  // 1. Blockhash-expired → timeout (highest priority, name match is exact).
  if (
    name === 'TransactionExpiredBlockheightExceededError' ||
    /TransactionExpiredBlockheightExceededError/.test(allText) ||
    /block height exceeded/i.test(allText)
  ) {
    return 'timeout';
  }

  // 2. Anchor / custom-program error → onchain (check logs first).
  if (ANCHOR_LOG_PATTERNS.some(p => p.test(allText))) {
    return 'onchain_error';
  }

  // 3. SendTransactionError without anchor log but with `Transaction
  //    simulation failed` → sim_error. Order matters: this catches the
  //    preflight-rejection path before the bare network buckets.
  if (SIM_PATTERNS.some(p => p.test(allText))) {
    return 'sim_error';
  }

  // 4. Network / RPC layer failures.
  if (RPC_PATTERNS.some(p => p.test(allText))) {
    return 'rpc_error';
  }

  // 5. Generic SendTransactionError without specific signal — assume RPC.
  if (name === 'SendTransactionError') {
    return 'rpc_error';
  }

  // 6. Default: rpc_error (operator surfaces unclassified via panel).
  return 'rpc_error';
}
