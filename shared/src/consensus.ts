/**
 * R29: cross-validation read path.
 *
 * Critical-state queries (Accumulator balance, MerkleDistributor.cumulative,
 * RevenueAccount.last_distribution_ts, NAV oracle reads) MUST use this path
 * instead of `withFallback` — a single compromised or out-of-sync RPC
 * returning a wrong number could cause the crank to send a bad transaction.
 *
 * Algorithm:
 *   1. Fan out the operation to every endpoint in parallel.
 *   2. Collect all successful answers.
 *   3. Group answers using the supplied `comparator` (default: deep equality
 *      via `JSON.stringify` on a normalised value).
 *   4. The largest group is the consensus answer; require it to meet the
 *      configured `quorum` size.
 *   5. Return the consensus value. Endpoints whose answer was outside the
 *      consensus group are marked as failed via `client.markFailure(url)` so
 *      they get demoted in the rotation.
 *   6. If quorum is not reached → throw {@link ConsensusError}.
 *
 * Quorum guidance:
 *   - 5 endpoints: quorum = 3 (3-of-5, tolerates 2 dissenters).
 *   - 3 endpoints: quorum = 2 (2-of-3, tolerates 1 dissenter).
 *   - 1 endpoint: degenerate — quorum = 1 → equivalent to a direct read.
 *     Cranks deploying with a single RPC must explicitly request quorum=1.
 *
 * Comparator:
 *   - Default uses `JSON.stringify` on a value with BigInts coerced to
 *     strings — works for plain JSON, account balances (BigInt), and
 *     `PublicKey` (which serialises as a base58 string in our logs but as
 *     `{_bn: ...}` in raw JSON, hence the BigInt coercion).
 *   - Pass a custom comparator for AccountInfo (compare `data` bytes only,
 *     ignore `slot`) or for slot-tolerant reads.
 */

import type { Connection } from '@solana/web3.js';

import type { MultiRpcClient } from './rpc-pool.js';
import { logger, redactUrl } from './logger.js';
import { ConsensusError } from './types.js';

export interface ConsensusOptions<T> {
  /**
   * Minimum number of identical successful answers required for consensus.
   * Must be ≥ 1 and ≤ pool size.
   */
  quorum: number;
  /**
   * Equality predicate. Default uses BigInt-aware JSON serialisation.
   * Return `true` if `a` and `b` represent the same answer.
   */
  comparator?: (a: T, b: T) => boolean;
  /**
   * Optional per-endpoint timeout in ms. Defaults to no timeout.
   * Endpoints that exceed it are counted as failures.
   */
  timeoutMs?: number;
}

/**
 * Default comparator: serialise both values with BigInt → string coercion,
 * then string-compare. Stable for plain objects and primitives.
 */
function defaultComparator<T>(a: T, b: T): boolean {
  return canon(a) === canon(b);
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

interface Settled<T> {
  url: string;
  ok: boolean;
  value?: T;
  error?: unknown;
}

async function runWithTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return op();
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`consensus op timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    op().then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Read the same value from every endpoint and require N matching answers.
 * Returns the consensus value, or throws {@link ConsensusError} if quorum
 * could not be reached.
 *
 * The `client` parameter is the `MultiRpcClient` whose endpoints we fan out
 * over; we use `client.all()` to enumerate Connections and `markFailure()` to
 * record dissenters.
 */
export async function consensusRead<T>(
  client: MultiRpcClient,
  op: (conn: Connection) => Promise<T>,
  options: ConsensusOptions<T>,
): Promise<T> {
  const { quorum, comparator = defaultComparator, timeoutMs } = options;
  if (quorum < 1) throw new Error('consensusRead: quorum must be ≥ 1');
  if (quorum > client.size()) {
    throw new Error(
      `consensusRead: quorum ${quorum} exceeds pool size ${client.size()}`,
    );
  }

  // Use allWithEndpoints() to keep conn↔url correlation correct after
  // non-zero failure counts (rotation order ≠ declaration order).
  // Substep 7 architect review I-1 fix.
  const pairs = client.allWithEndpoints();

  const settled = await Promise.all(
    pairs.map(async ({ conn, endpoint }): Promise<Settled<T>> => {
      const url = endpoint.url;
      try {
        const value = await runWithTimeout(() => op(conn), timeoutMs);
        return { url, ok: true, value };
      } catch (err) {
        return { url, ok: false, error: err };
      }
    }),
  );

  const successful = settled.filter((s): s is Settled<T> & { ok: true; value: T } => s.ok);
  if (successful.length < quorum) {
    throw new ConsensusError(
      `consensus failed: only ${successful.length}/${pairs.length} endpoints succeeded (need ${quorum})`,
      pairs.length,
      successful.length,
      quorum,
    );
  }

  // Group identical answers. We do an O(N^2) pairwise scan because N is
  // tiny (5 endpoints in practice) and the comparator may be opaque (we
  // can't rely on it being a total order).
  const groups: { rep: T; members: typeof successful }[] = [];
  for (const s of successful) {
    const grp = groups.find(g => comparator(g.rep, s.value));
    if (grp) grp.members.push(s);
    else groups.push({ rep: s.value, members: [s] });
  }
  groups.sort((a, b) => b.members.length - a.members.length);
  const winner = groups[0];
  if (!winner || winner.members.length < quorum) {
    const sizes = groups.map(g => g.members.length).join(',');
    throw new ConsensusError(
      `consensus split: largest group ${winner?.members.length ?? 0}/${pairs.length} (need ${quorum}); group sizes [${sizes}]`,
      pairs.length,
      successful.length,
      quorum,
    );
  }

  // Mark every endpoint outside the winning group as failed — they returned
  // a stale or wrong answer and should be demoted.
  for (const s of successful) {
    if (!winner.members.includes(s)) {
      client.markFailure(s.url);
      logger.warn('rpc consensus dissenter', { url: redactUrl(s.url) });
    }
  }
  // Mark errored endpoints as failed too.
  for (const s of settled) {
    if (!s.ok) {
      client.markFailure(s.url);
      logger.warn('rpc consensus error', {
        url: redactUrl(s.url),
        error: s.error instanceof Error ? s.error.message : String(s.error),
      });
    }
  }

  return winner.members[0]!.value;
}
