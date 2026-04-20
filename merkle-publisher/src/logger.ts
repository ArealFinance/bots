import type { LogLevel } from './config.js';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
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

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => {
    if (shouldLog('debug')) console.log(`[debug] ${msg}${formatContext(ctx)}`);
  },
  info: (msg: string, ctx?: Record<string, unknown>) => {
    if (shouldLog('info')) console.log(`[info] ${msg}${formatContext(ctx)}`);
  },
  warn: (msg: string, ctx?: Record<string, unknown>) => {
    if (shouldLog('warn')) console.warn(`[warn] ${msg}${formatContext(ctx)}`);
  },
  error: (msg: string, err?: unknown, ctx?: Record<string, unknown>) => {
    if (!shouldLog('error')) return;
    const errStr = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
    console.error(`[error] ${msg}${formatContext(ctx)}${err ? '\n  ' + errStr : ''}`);
  },
};
