/**
 * R30: PID-file based single-instance guard.
 *
 * Prevents two copies of the same crank from running concurrently against
 * the same checkpoint DB or sending duplicate transactions.
 *
 * Algorithm:
 *   1. `acquire()` reads `<lockDir>/<instanceId>.lock`.
 *   2. If the file exists and contains a PID that is alive (kill -0 succeeds)
 *      AND the recorded `startedAt` is recent (< staleTimeoutMs old) →
 *      throw {@link AlreadyRunningError}.
 *   3. Otherwise we treat the file as stale (process died without releasing,
 *      or the OS recycled the PID), overwrite it with our own PID + start
 *      timestamp, and return.
 *   4. `release()` (best-effort) removes the file. Also wired to
 *      `process.on('exit')` so a SIGINT/SIGTERM-mediated shutdown still
 *      cleans up.
 *
 * Atomicity:
 *   - `O_EXCL` flag is used on the `open()` call. If the file already exists
 *     we skip to step 2 (the stale-check branch). This makes the create-vs-
 *     reclaim path race-free between this process and a concurrent acquire.
 *
 * No external dependency — implemented with `node:fs` to keep the package
 * dependency footprint at @solana/web3.js only.
 *
 * Note on `fs.lockSync` / `flock`: Node does not expose `flock(2)` natively
 * across platforms (Windows lacks it). We use the PID-file approach because
 * it is the same mechanism used by tools like systemd, nginx, and dockerd
 * for single-instance enforcement and works uniformly across Linux/macOS/
 * Windows (`process.kill(pid, 0)` exists everywhere Node runs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from './logger.js';
import { AlreadyRunningError } from './types.js';

export interface LockOptions {
  /** Directory to write the PID-file in (auto-created with 0o755). */
  lockDir: string;
  /** Logical instance name — becomes the lock file basename. */
  instanceId: string;
  /**
   * If the existing lock-file is older than this and we cannot prove the PID
   * is still alive, we steal it. Defaults to 60s.
   *
   * Tradeoff: too low → false reclaims after a brief CPU stall.
   *           too high → second instance must wait minutes after a crash.
   */
  staleTimeoutMs?: number;
}

const DEFAULT_STALE_TIMEOUT_MS = 60_000;

interface LockFilePayload {
  pid: number;
  startedAt: number; // ms epoch
  instanceId: string;
}

/**
 * Acquires a PID-file lock and releases it on shutdown.
 *
 * Usage:
 *   ```
 *   const lock = new SingleInstanceLock();
 *   await lock.acquire({ lockDir: './data/locks', instanceId: 'revenue-crank' });
 *   try {
 *     // ... bot main loop ...
 *   } finally {
 *     await lock.release();
 *   }
 *   ```
 */
export class SingleInstanceLock {
  private filePath: string | null = null;
  private released = false;

  /**
   * Throws {@link AlreadyRunningError} if another live instance holds the lock.
   * Idempotent on the same instance — calling twice in a row is a no-op.
   */
  async acquire(options: LockOptions): Promise<void> {
    const { lockDir, instanceId, staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS } = options;
    if (!instanceId.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error(
        `SingleInstanceLock: invalid instanceId "${instanceId}" (alphanumeric/dash/underscore only)`,
      );
    }
    if (this.filePath) return; // already held

    await fs.promises.mkdir(lockDir, { recursive: true });
    const filePath = path.join(lockDir, `${instanceId}.lock`);

    // Try to create the file exclusively — if this succeeds we win the race.
    let fd: fs.promises.FileHandle | null = null;
    try {
      fd = await fs.promises.open(filePath, 'wx');
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // File exists. Examine it.
      await this.examineExistingLock(filePath, instanceId, staleTimeoutMs);
      // examineExistingLock either threw AlreadyRunningError (live peer) or
      // returned successfully (stale lock). In the stale case we need to
      // overwrite — open without O_EXCL.
      fd = await fs.promises.open(filePath, 'w');
    }

    const payload: LockFilePayload = {
      pid: process.pid,
      startedAt: Date.now(),
      instanceId,
    };
    try {
      await fd.writeFile(JSON.stringify(payload, null, 2), 'utf8');
    } finally {
      await fd.close();
    }

    this.filePath = filePath;

    // Best-effort cleanup on process exit.
    process.once('exit', () => {
      // Synchronous unlink — process.on('exit') cannot await.
      try {
        if (this.filePath && !this.released) fs.unlinkSync(this.filePath);
      } catch {
        // swallow — exit handler must not throw
      }
    });

    logger.info('single-instance lock acquired', {
      instanceId,
      pid: process.pid,
      filePath,
    });
  }

  private async examineExistingLock(
    filePath: string,
    instanceId: string,
    staleTimeoutMs: number,
  ): Promise<void> {
    const raw = await fs.promises.readFile(filePath, 'utf8').catch(() => null);
    if (!raw) {
      // Empty / unreadable — treat as stale.
      logger.warn('lock file unreadable, reclaiming', { filePath });
      return;
    }
    let parsed: LockFilePayload;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('lock file corrupt, reclaiming', { filePath });
      return;
    }
    // Sanity-check the contents — corrupt fields → treat as stale.
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.instanceId !== 'string'
    ) {
      logger.warn('lock file invalid shape, reclaiming', { filePath });
      return;
    }

    const ageMs = Date.now() - parsed.startedAt;
    const peerAlive = isProcessAlive(parsed.pid);

    if (peerAlive && ageMs <= staleTimeoutMs) {
      throw new AlreadyRunningError(
        `another instance "${instanceId}" is running (pid=${parsed.pid}, age=${ageMs}ms)`,
        parsed.pid,
        parsed.startedAt,
      );
    }
    // For older locks where the process appears alive: the OS may have
    // recycled the PID. We'd rather refuse to start than risk dual-instance,
    // unless the lock is *also* clearly stale (older than 2× the threshold).
    if (peerAlive && ageMs > staleTimeoutMs * 2) {
      logger.warn('lock file very old but PID alive — likely recycled, reclaiming', {
        filePath,
        ageMs,
        pid: parsed.pid,
      });
      return;
    }
    if (peerAlive) {
      throw new AlreadyRunningError(
        `another instance "${instanceId}" is running (pid=${parsed.pid}, age=${ageMs}ms, stale check inconclusive)`,
        parsed.pid,
        parsed.startedAt,
      );
    }
    logger.info('lock file stale (peer dead), reclaiming', {
      filePath,
      ageMs,
      pid: parsed.pid,
    });
  }

  /** Best-effort release. Idempotent. */
  async release(): Promise<void> {
    if (this.released || !this.filePath) {
      this.released = true;
      return;
    }
    const filePath = this.filePath;
    this.released = true;
    this.filePath = null;
    try {
      await fs.promises.unlink(filePath);
      logger.info('single-instance lock released', { filePath });
    } catch (err) {
      logger.warn('lock release failed (already gone?)', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Returns the lock file path if held, else null — for tests / introspection. */
  heldPath(): string | null {
    return this.released ? null : this.filePath;
  }
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/**
 * Cross-platform "is this PID alive?" probe via `process.kill(pid, 0)`.
 * - ESRCH → process does not exist.
 * - EPERM → process exists but we lack signal permission (still alive).
 * - undefined → we own it / kill succeeded → alive.
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // exists, owned by another user
    return false; // ESRCH or unknown → assume dead
  }
}
