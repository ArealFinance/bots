/**
 * Shared types for the bots/shared package.
 *
 * Kept deliberately small — most types live next to their feature module
 * (rpc-pool, lock, reconcile). This file only hosts cross-cutting types
 * referenced by more than one module.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A single RPC endpoint description for {@link MultiRpcClient}.
 *
 * `weight` is used by the primary-selection algorithm: higher weight = higher
 * priority. Endpoints with equal weight are tried in declaration order.
 *
 * `failureCount` is mutated by the client at runtime to track rolling failures
 * — endpoints with high failure counts get demoted in the rotation. Callers
 * should pass `failureCount: 0` at construction time.
 */
export interface RpcEndpoint {
  /** HTTPS RPC URL. */
  url: string;
  /** Optional WebSocket URL paired with this RPC. */
  wsUrl?: string;
  /**
   * Priority weight (higher = preferred). Endpoints sharing a weight are
   * tried in the order supplied to the {@link MultiRpcClient} constructor.
   */
  weight: number;
  /** Rolling failure count, incremented by the client on errors. */
  failureCount: number;
}

/**
 * Error thrown when a quorum was requested but enough endpoints disagreed
 * (or failed) to make consensus impossible.
 */
export class ConsensusError extends Error {
  constructor(
    message: string,
    public readonly attempted: number,
    public readonly succeeded: number,
    public readonly quorum: number,
  ) {
    super(message);
    this.name = 'ConsensusError';
  }
}

/**
 * Error thrown when {@link SingleInstanceLock.acquire} detects a live peer
 * holding the lock.
 */
export class AlreadyRunningError extends Error {
  constructor(
    message: string,
    public readonly pid: number,
    public readonly startedAt: number,
  ) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}
