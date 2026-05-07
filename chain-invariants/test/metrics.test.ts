/**
 * Phase 22 unit tests for metrics.ts.
 *
 * Spins up the HTTP server on an OS-assigned port (127.0.0.1:0), hits
 * /metrics, /healthz, /api/badges/* and a method-not-allowed PUT, then
 * tears the server down. Each test asserts on response shape, not on
 * specific metric values (those are exercised in the integration test).
 */

import { describe, it, expect } from 'vitest';
import { logger } from '@areal/bots-shared';
import type { AddressInfo } from 'node:net';
import {
  createMetrics,
  createMetricsServer,
  type BadgesHandler,
  type MetricsServerHandle,
} from '../src/metrics.js';

const noopBadges: BadgesHandler = async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ schemaVersion: 1, label: 'test', message: 'ok', color: 'green' }));
};

async function startServer(): Promise<{
  handle: MetricsServerHandle;
  base: string;
}> {
  const handle = await createMetricsServer({
    port: 0, // OS-assigned
    host: '127.0.0.1',
    logger,
    badgesHandler: noopBadges,
  });
  const addr = handle.server.address() as AddressInfo;
  return { handle, base: `http://127.0.0.1:${addr.port}` };
}

describe('createMetrics', () => {
  it('registers all chain_invariant_* metrics with bounded labels', async () => {
    const m = createMetrics();
    // Touch every metric so it shows up in registry.metrics().
    m.merkleRootAgeSeconds.set({ distributor: 'D1' }, 1);
    m.navAgeSeconds.set({ rwt_engine: 'V1' }, 2);
    m.authorityMatch.set({ contract: 'rwt_vault', authority: 'A1' }, 1);
    m.rwtSupplyTracked.set({ rwt_engine: 'V1' }, 100);
    m.rwtSupplyMintActual.set({ rwt_engine: 'V1' }, 100);
    m.rwtSupplyDriftAbs.set({ rwt_engine: 'V1' }, 0);
    m.checkErrorsTotal.inc({ check: 'merkle_root_age' });
    m.checkLastSuccessTimestamp.set({ check: 'merkle_root_age' }, 12345);
    m.checkDurationSeconds.set({ check: 'merkle_root_age' }, 0.5);
    m.exporterPollsTotal.inc();

    const text = await m.registry.metrics();
    expect(text).toContain('chain_invariant_merkle_root_age_seconds{');
    expect(text).toContain('chain_invariant_nav_age_seconds{');
    expect(text).toContain('chain_invariant_authority_match{');
    expect(text).toContain('chain_invariant_rwt_supply_tracked{');
    expect(text).toContain('chain_invariant_rwt_supply_mint_actual{');
    expect(text).toContain('chain_invariant_rwt_supply_drift_abs{');
    expect(text).toContain('chain_invariant_check_errors_total{');
    expect(text).toContain('chain_invariant_check_last_success_timestamp{');
    expect(text).toContain('chain_invariant_check_duration_seconds{');
    // Default labels (service="chain-invariants") attach to every series.
    expect(text).toContain('chain_invariant_exporter_alive{service="chain-invariants"} 1');
    expect(text).toContain('chain_invariant_exporter_polls_total{service="chain-invariants"} 1');
    // Default labels are applied.
    expect(text).toContain('service="chain-invariants"');
    // prom-client default metrics with the configured prefix.
    expect(text).toContain('chain_invariant_proc_');
  });
});

describe('createMetricsServer', () => {
  it('serves /metrics with prom-text Content-Type and a 200 status', async () => {
    const { handle, base } = await startServer();
    try {
      const r = await fetch(`${base}/metrics`);
      expect(r.status).toBe(200);
      const ct = r.headers.get('content-type');
      expect(ct).toMatch(/text\/plain/);
      const body = await r.text();
      expect(body).toContain('chain_invariant_exporter_alive');
    } finally {
      await handle.close();
    }
  });

  it('serves /healthz returning {"ok":true}', async () => {
    const { handle, base } = await startServer();
    try {
      const r = await fetch(`${base}/healthz`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toEqual({ ok: true });
    } finally {
      await handle.close();
    }
  });

  it('routes /api/badges/* into the supplied badgesHandler', async () => {
    const { handle, base } = await startServer();
    try {
      const r = await fetch(`${base}/api/badges/merkle-fresh`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ schemaVersion: 1, label: 'test' });
    } finally {
      await handle.close();
    }
  });

  it('returns 405 with Allow: GET, HEAD on POST', async () => {
    const { handle, base } = await startServer();
    try {
      const r = await fetch(`${base}/metrics`, { method: 'POST' });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD');
    } finally {
      await handle.close();
    }
  });

  it('returns 404 on unknown route', async () => {
    const { handle, base } = await startServer();
    try {
      const r = await fetch(`${base}/totally-not-a-route`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('rejects out-of-range port', async () => {
    await expect(
      createMetricsServer({
        port: 70_000,
        host: '127.0.0.1',
        logger,
        badgesHandler: noopBadges,
      }),
    ).rejects.toThrow(/invalid port/);
    await expect(
      createMetricsServer({
        port: -1,
        host: '127.0.0.1',
        logger,
        badgesHandler: noopBadges,
      }),
    ).rejects.toThrow(/invalid port/);
  });
});
