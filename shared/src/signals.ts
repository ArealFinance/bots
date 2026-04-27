/**
 * Shared signal-handler installer.
 *
 * Every crank wires the same four handlers (SIGINT, SIGTERM,
 * uncaughtException, unhandledRejection) to a shutdown function. Lifting
 * the boilerplate here keeps the contract identical across the fleet:
 *   - signals exit cleanly with code 0;
 *   - uncaughtException / unhandledRejection log + shut down with code 1.
 *
 * The shutdown callback is invoked at most once per signal (handlers use
 * `process.once`); callers' own `alreadyShuttingDown` guards remain the
 * primary defense against double-release.
 */

import { logger } from './logger.js';

/**
 * Shutdown callback contract:
 *   - first arg: signal name ("SIGINT" / "uncaughtException" / etc.);
 *   - second arg: process exit code (defaults to 0 for signals, 1 for errors).
 *
 * Implementations are expected to release resources (locks, DB handles,
 * WS subscriptions) and call `process.exit(code)` once cleanup completes.
 */
export type ShutdownFn = (signal: string, exitCode?: number) => void | Promise<void>;

/**
 * Wires SIGINT/SIGTERM/uncaughtException/unhandledRejection to a single
 * shutdown function. Errors from the callback are swallowed (logged) so
 * a partial-shutdown failure cannot prevent the next signal from firing.
 */
export function installSignalHandlers(shutdown: ShutdownFn): void {
  process.once('SIGINT', () => void Promise.resolve(shutdown('SIGINT')).catch(swallow));
  process.once('SIGTERM', () => void Promise.resolve(shutdown('SIGTERM')).catch(swallow));
  process.once('uncaughtException', (e: unknown) => {
    logger.error('uncaughtException', e);
    void Promise.resolve(shutdown('uncaughtException', 1)).catch(swallow);
  });
  process.once('unhandledRejection', (e: unknown) => {
    logger.error('unhandledRejection', e);
    void Promise.resolve(shutdown('unhandledRejection', 1)).catch(swallow);
  });
}

function swallow(err: unknown): void {
  logger.error('signal handler shutdown threw', err);
}
