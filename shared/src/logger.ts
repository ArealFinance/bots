/**
 * Shared logger — drop-in compatible with the per-crank logger pattern used
 * across `merkle-publisher`, `revenue-crank`, `convert-and-fund-crank`, and
 * `yield-claim-crank`.
 *
 * Cranks that already import a local `logger.js` can swap it for this module
 * without changing call sites.
 *
 * Output format mirrors the existing cranks:
 *   `[level] message k1=v1 k2=v2`
 *
 * BigInt values in the context object are stringified (JSON.stringify chokes
 * on BigInt). Errors are flattened to `message + stack` and appended on a new
 * line under the message header.
 */

import type { LogLevel } from './types.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

/** Mutate the global threshold for subsequent log calls. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Read the current threshold (mostly for tests). */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

function formatContext(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    const s = typeof v === 'bigint' ? v.toString() : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/**
 * Strip secrets from a URL before logging. Operators commonly embed
 * API keys in RPC URLs as `?api-key=<KEY>` query params or as basic-auth
 * `https://user:KEY@host/`. Production logs must not capture these.
 *
 * Output format: `<scheme>://<host>[:<port>]` — path, query, fragment,
 * userinfo, and credentials are dropped.
 *
 * Falls back к literal `[invalid-url]` token if input cannot be parsed
 * (so callers don't need to wrap in try/catch).
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return '[invalid-url]';
  }
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, ctx?: Record<string, unknown>): void;
}

export const logger: Logger = {
  debug(msg, ctx) {
    if (shouldLog('debug')) console.log(`[debug] ${msg}${formatContext(ctx)}`);
  },
  info(msg, ctx) {
    if (shouldLog('info')) console.log(`[info] ${msg}${formatContext(ctx)}`);
  },
  warn(msg, ctx) {
    if (shouldLog('warn')) console.warn(`[warn] ${msg}${formatContext(ctx)}`);
  },
  error(msg, err, ctx) {
    if (!shouldLog('error')) return;
    const errStr =
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
    console.error(`[error] ${msg}${formatContext(ctx)}${err ? '\n  ' + errStr : ''}`);
  },
};
