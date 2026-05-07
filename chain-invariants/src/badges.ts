/**
 * Phase 22: shields.io endpoint badges.
 *
 * Each public badge maps a current metric value into a small JSON
 * envelope conforming to the shields.io endpoint schema:
 *   https://shields.io/badges/endpoint-badge
 *
 *   {
 *     "schemaVersion": 1,
 *     "label": "merkle root",
 *     "message": "fresh",
 *     "color": "brightgreen",
 *     "cacheSeconds": 60
 *   }
 *
 * Color & cache contract:
 *   - ok        → "brightgreen", cacheSeconds: 60
 *   - drift     → "red",          cacheSeconds: 30 (faster TTL on alarm)
 *   - unknown   → "lightgrey",    cacheSeconds: 15 (encourage re-poll)
 *
 * Routes wired through `/api/badges/<name>`:
 *   - merkle-fresh   → reads chain_invariant_merkle_root_age_seconds
 *   - nav-fresh      → reads chain_invariant_nav_age_seconds
 *   - authority-ok   → reads chain_invariant_authority_match (ALL must == 1)
 *   - supply-ok      → reads chain_invariant_rwt_supply_drift_abs (must == 0)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChainInvariantsMetrics } from './metrics.js';

export type BadgeName =
  | 'merkle-fresh'
  | 'nav-fresh'
  | 'authority-ok'
  | 'supply-ok';

export const BADGE_NAMES: readonly BadgeName[] = [
  'merkle-fresh',
  'nav-fresh',
  'authority-ok',
  'supply-ok',
] as const;

export type BadgeColor =
  | 'brightgreen'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'lightgrey';

export interface BadgeResponse {
  schemaVersion: 1;
  label: string;
  message: string;
  color: BadgeColor;
  cacheSeconds: number;
}

export interface BadgeThresholds {
  /** Stale threshold for merkle root age (seconds). Matches the alert. */
  merkleFreshSec: number;
  /** Stale threshold for NAV age (seconds). Matches the alert. */
  navFreshSec: number;
  /** Drift must be 0 — a non-bigint type is intentional, badges
   *  compute against the gauge's number value, not the source bigint. */
  rwtSupplyDriftMax: number;
}

export const DEFAULT_THRESHOLDS: BadgeThresholds = {
  merkleFreshSec: 6 * 3600,
  navFreshSec: 24 * 3600,
  rwtSupplyDriftMax: 0,
};

export interface BadgesContext {
  metrics: ChainInvariantsMetrics;
  thresholds: BadgeThresholds;
}

// ---- Public API -----------------------------------------------------------

/**
 * Build the HTTP handler used by the metrics server for `/api/badges/*`.
 * Returns a function with the standard (req, res) signature so callers
 * can plug it directly into `createMetricsServer({ badgesHandler })`.
 */
export function createBadgesHandler(
  ctx: BadgesContext,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const m = path.match(/^\/api\/badges\/([^/]+)\/?$/);
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    const name = m[1];
    if (!isBadgeName(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await renderBadge(ctx, name);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${body.cacheSeconds}`,
    });
    res.end(JSON.stringify(body));
  };
}

/**
 * Pure: render a badge JSON envelope from the current metric values.
 * Exported separately so unit tests can drive it without HTTP.
 */
export async function renderBadge(
  ctx: BadgesContext,
  name: BadgeName,
): Promise<BadgeResponse> {
  switch (name) {
    case 'merkle-fresh':
      return await ageBadge(
        ctx.metrics,
        'chain_invariant_merkle_root_age_seconds',
        'merkle root',
        ctx.thresholds.merkleFreshSec,
      );
    case 'nav-fresh':
      return await ageBadge(
        ctx.metrics,
        'chain_invariant_nav_age_seconds',
        'nav',
        ctx.thresholds.navFreshSec,
      );
    case 'authority-ok':
      return await authorityBadge(ctx.metrics);
    case 'supply-ok':
      return await supplyBadge(ctx.metrics, ctx.thresholds.rwtSupplyDriftMax);
  }
}

// ---- Helpers --------------------------------------------------------------

function isBadgeName(s: string | undefined): s is BadgeName {
  return s !== undefined && (BADGE_NAMES as readonly string[]).includes(s);
}

interface SeriesValue {
  value: number;
  labels: Record<string, string>;
}

/**
 * Pull all current series from a single Gauge name. Unlike the prom-text
 * scrape (which reads from registry.metrics()) this reads structured JSON
 * via registry.getSingleMetric().get(), which gives us the raw value array.
 */
async function readSeries(
  metrics: ChainInvariantsMetrics,
  name: string,
): Promise<SeriesValue[]> {
  const m = metrics.registry.getSingleMetric(name);
  if (!m) return [];
  const got = await m.get();
  // prom-client returns { name, help, type, values, aggregator }
  const values = (got.values ?? []) as Array<{
    value: number;
    labels?: Record<string, string>;
  }>;
  return values.map((v) => ({
    value: v.value,
    labels: v.labels ?? {},
  }));
}

async function ageBadge(
  metrics: ChainInvariantsMetrics,
  metricName: string,
  label: string,
  thresholdSec: number,
): Promise<BadgeResponse> {
  const series = await readSeries(metrics, metricName);
  if (series.length === 0) {
    return {
      schemaVersion: 1,
      label,
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  // Worst case across series (only 1 in v1, but written for the multi-vault
  // future — we do NOT want to silently average a stale series with a fresh one).
  const maxAge = Math.max(...series.map((s) => s.value));
  if (!Number.isFinite(maxAge)) {
    return {
      schemaVersion: 1,
      label,
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  if (maxAge < thresholdSec) {
    return {
      schemaVersion: 1,
      label,
      message: 'fresh',
      color: 'brightgreen',
      cacheSeconds: 60,
    };
  }
  return {
    schemaVersion: 1,
    label,
    message: 'stale',
    color: 'red',
    cacheSeconds: 30,
  };
}

async function authorityBadge(
  metrics: ChainInvariantsMetrics,
): Promise<BadgeResponse> {
  const series = await readSeries(metrics, 'chain_invariant_authority_match');
  if (series.length === 0) {
    return {
      schemaVersion: 1,
      label: 'authority',
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  // Any -1 → unknown; any 0 → drift; otherwise all 1 → ok.
  const hasUnknown = series.some((s) => s.value === -1);
  const hasDrift = series.some((s) => s.value === 0);
  if (hasUnknown && !hasDrift) {
    return {
      schemaVersion: 1,
      label: 'authority',
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  if (hasDrift) {
    return {
      schemaVersion: 1,
      label: 'authority',
      message: 'drift',
      color: 'red',
      cacheSeconds: 30,
    };
  }
  return {
    schemaVersion: 1,
    label: 'authority',
    message: 'ok',
    color: 'brightgreen',
    cacheSeconds: 60,
  };
}

async function supplyBadge(
  metrics: ChainInvariantsMetrics,
  driftMax: number,
): Promise<BadgeResponse> {
  const series = await readSeries(metrics, 'chain_invariant_rwt_supply_drift_abs');
  if (series.length === 0) {
    return {
      schemaVersion: 1,
      label: 'rwt supply',
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  const maxDrift = Math.max(...series.map((s) => s.value));
  if (!Number.isFinite(maxDrift)) {
    return {
      schemaVersion: 1,
      label: 'rwt supply',
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    };
  }
  if (maxDrift <= driftMax) {
    return {
      schemaVersion: 1,
      label: 'rwt supply',
      message: 'ok',
      color: 'brightgreen',
      cacheSeconds: 60,
    };
  }
  return {
    schemaVersion: 1,
    label: 'rwt supply',
    message: 'drift',
    color: 'red',
    cacheSeconds: 30,
  };
}
