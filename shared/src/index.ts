/**
 * `@areal/bots-shared` — hardening primitives shared across the off-chain
 * bots. See `README.md` for design rationale and per-crank usage examples.
 *
 * Re-exports:
 *   - {@link MultiRpcClient}: weighted multi-RPC pool with fallback chain.
 *   - {@link consensusRead}: cross-validation read (3-of-5 quorum, etc.).
 *   - {@link SingleInstanceLock}: PID-file based single-instance guard.
 *   - {@link reconcileEvents}: post-WS-disconnect catch-up walker.
 *   - {@link logger}: shared structured logger (compatible with each
 *     crank's existing local logger).
 */

export { MultiRpcClient } from './rpc-pool.js';
export type { MultiRpcClientOptions } from './rpc-pool.js';

export { consensusRead } from './consensus.js';
export type { ConsensusOptions } from './consensus.js';

export { SingleInstanceLock } from './lock.js';
export type { LockOptions } from './lock.js';

export { reconcileEvents } from './reconcile.js';
export type { ReconcileOptions, ReconcileHandler, ReconciledEvent } from './reconcile.js';

export { logger, setLogLevel, getLogLevel, redactUrl } from './logger.js';
export type { Logger } from './logger.js';

export {
  AlreadyRunningError,
  ConsensusError,
} from './types.js';
export type { LogLevel, RpcEndpoint } from './types.js';
