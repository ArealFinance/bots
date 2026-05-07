/**
 * R29: multi-RPC client with weighted primary selection, failure tracking,
 * and a routine-fallback chain.
 *
 * Companion: see {@link ./consensus.ts} for the cross-validation read path
 * (`consensusRead`) used on security-critical state queries.
 *
 * Design goals:
 *   - **Routine reads** — use `withFallback`. Try the highest-weighted
 *     endpoint first; on transient failure, fall back through the chain in
 *     weight order. Increment `failureCount` on any error so chronic offenders
 *     get demoted by the next selection cycle.
 *   - **Critical reads** — use `consensusRead` (in `./consensus.ts`). Query
 *     N endpoints in parallel and require a quorum of identical answers. If
 *     RPCs disagree the call throws — do NOT silently pick one. Cranks call
 *     this on Accumulator balance, MerkleDistributor.cumulative_amount,
 *     RevenueAccount.last_distribution_ts, and similar money-touching state.
 *   - **WS endpoints** — exposed via `wsUrlFor()` so the caller can pair the
 *     selected HTTP endpoint with its native WS sibling. Solana Connection
 *     accepts a separate `wsEndpoint` option.
 *
 * Failure-count semantics:
 *   - Increments on any thrown error from the supplied operation.
 *   - Decay is the caller's responsibility (call `resetFailures()` on a
 *     timer, or after a successful consensus). For now we keep it monotonic
 *     so a misbehaving endpoint stays at the back of the rotation until the
 *     bot restarts or explicitly forgives it.
 */

import { Connection, type Commitment, type ConnectionConfig } from '@solana/web3.js';

import { logger, redactUrl } from './logger.js';
import type { RpcEndpoint } from './types.js';

export interface MultiRpcClientOptions {
  /** Default commitment used when constructing each Connection. */
  commitment?: Commitment;
  /** Extra options passed through to each `Connection` constructor. */
  connectionConfig?: Omit<ConnectionConfig, 'wsEndpoint' | 'commitment'>;
  /**
   * Phase 21: invoked on every fallback hop with a redacted endpoint
   * label. Cranks wire this to `metrics.rpcFallbackTotal` so each
   * failover is observable. The callback runs inside the catch block;
   * a thrown callback never masks the underlying RPC error (we wrap
   * the call in try/catch).
   *
   * Cardinality note: `endpoint` label cardinality is bounded by the
   * operator's `RPC_URLS` env (typically ≤5 endpoints). Operator policy
   * enforces ≤10 to keep the prom series count predictable.
   */
  onFallback?: (endpoint: string) => void;
}

/**
 * Holds N Solana `Connection` objects (one per endpoint) and exposes
 * fallback / fan-out helpers used by cranks.
 *
 * The class is intentionally thread-unsafe: cranks are single-process,
 * single-loop. If a future caller wants concurrency, wrap individual
 * methods in their own mutex.
 */
export class MultiRpcClient {
  private readonly endpoints: RpcEndpoint[];
  private readonly connections: Map<string, Connection>;
  private readonly options: {
    commitment: Commitment;
    connectionConfig: NonNullable<MultiRpcClientOptions['connectionConfig']>;
    onFallback: ((endpoint: string) => void) | undefined;
  };

  constructor(endpoints: RpcEndpoint[], options: MultiRpcClientOptions = {}) {
    if (endpoints.length === 0) {
      throw new Error('MultiRpcClient requires at least one endpoint');
    }
    // Defensive copy — caller mutating their array post-construction must
    // not silently change rotation order.
    this.endpoints = endpoints.map(e => ({ ...e }));
    this.options = {
      commitment: options.commitment ?? 'confirmed',
      connectionConfig: options.connectionConfig ?? {},
      onFallback: options.onFallback,
    };

    this.connections = new Map();
    for (const ep of this.endpoints) {
      this.connections.set(ep.url, this.makeConnection(ep));
    }
  }

  private makeConnection(ep: RpcEndpoint): Connection {
    return new Connection(ep.url, {
      commitment: this.options.commitment,
      wsEndpoint: ep.wsUrl,
      ...this.options.connectionConfig,
    });
  }

  /**
   * Endpoints sorted best-first: lower failureCount wins, then higher weight.
   * Ties broken by original declaration order (stable sort in V8/JSC).
   */
  private rotation(): RpcEndpoint[] {
    return [...this.endpoints].sort((a, b) => {
      if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
      return b.weight - a.weight;
    });
  }

  /** Best-weighted Connection right now. Stable until a failure changes the rotation. */
  primary(): Connection {
    const sorted = this.rotation();
    const head = sorted[0];
    if (!head) throw new Error('MultiRpcClient: no endpoints available');
    const conn = this.connections.get(head.url);
    if (!conn) throw new Error(`MultiRpcClient: missing connection for ${head.url}`);
    return conn;
  }

  /** All Connections in rotation order. Useful for fan-out reads (consensus). */
  all(): Connection[] {
    return this.rotation()
      .map(ep => this.connections.get(ep.url))
      .filter((c): c is Connection => c !== undefined);
  }

  /**
   * All (Connection, RpcEndpoint) pairs in rotation order. Use this instead
   * of pairing `all()` with `describe()` — `describe()` returns declaration
   * order, which diverges from rotation order after non-zero failure counts
   * (correlation bug fixed via Substep 7 architect review I-1).
   */
  allWithEndpoints(): { conn: Connection; endpoint: Readonly<RpcEndpoint> }[] {
    return this.rotation()
      .map(ep => {
        const conn = this.connections.get(ep.url);
        return conn ? { conn, endpoint: { ...ep } as Readonly<RpcEndpoint> } : null;
      })
      .filter((p): p is { conn: Connection; endpoint: Readonly<RpcEndpoint> } => p !== null);
  }

  /** Look up the WS URL configured for a given HTTP url, if any. */
  wsUrlFor(url: string): string | undefined {
    return this.endpoints.find(e => e.url === url)?.wsUrl;
  }

  /** Snapshot of endpoint state — read-only, useful for telemetry. */
  describe(): readonly Readonly<RpcEndpoint>[] {
    return this.endpoints.map(e => ({ ...e }));
  }

  /**
   * Run `op` against the best endpoint. On failure, fall back through the
   * rotation in weight/failure order. Returns the first successful result.
   *
   * Throws an `AggregateError` if all endpoints fail. Callers that want to
   * distinguish transient from terminal errors should check the inner
   * `errors` array.
   */
  async withFallback<T>(op: (conn: Connection) => Promise<T>): Promise<T> {
    const errors: unknown[] = [];
    for (const ep of this.rotation()) {
      const conn = this.connections.get(ep.url);
      if (!conn) continue;
      try {
        return await op(conn);
      } catch (err) {
        ep.failureCount += 1;
        errors.push(err);
        logger.warn('rpc fallback', {
          url: redactUrl(ep.url),
          failureCount: ep.failureCount,
          error: err instanceof Error ? err.message : String(err),
        });
        // Phase 21: surface the failover to the caller's metrics. Wrap in
        // try/catch so a thrown callback never masks the underlying RPC
        // error (which the AggregateError below would otherwise lose).
        if (this.options.onFallback) {
          try {
            this.options.onFallback(redactUrl(ep.url));
          } catch {
            /* swallow — metric recording must never become a new failure mode */
          }
        }
      }
    }
    throw new AggregateError(errors, 'MultiRpcClient: all endpoints failed');
  }

  /**
   * Reset failure counts for all endpoints — call after a successful
   * consensus read or on a periodic decay timer to forgive transient errors.
   */
  resetFailures(): void {
    for (const ep of this.endpoints) ep.failureCount = 0;
  }

  /**
   * Manually mark an endpoint as failed — used by the consensus path
   * when a specific endpoint's answer disagrees with the quorum.
   */
  markFailure(url: string): void {
    const ep = this.endpoints.find(e => e.url === url);
    if (ep) ep.failureCount += 1;
  }

  /** Number of endpoints — used by consensus quorum validation. */
  size(): number {
    return this.endpoints.length;
  }
}
