/**
 * Phase 22 unit tests for badges.ts.
 *
 * Drives `renderBadge` against a freshly-constructed metrics registry,
 * mutating gauge values to trigger fresh / stale / drift / unknown
 * paths. The HTTP layer (createBadgesHandler → 404 on bad routes,
 * Cache-Control header) is exercised through a single end-to-end
 * test using node:http.
 */

import { describe, it, expect } from 'vitest';
import { createMetrics } from '../src/metrics.js';
import {
  createBadgesHandler,
  renderBadge,
  DEFAULT_THRESHOLDS,
  BADGE_NAMES,
} from '../src/badges.js';
import type { BadgesContext } from '../src/badges.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

function makeCtx(): BadgesContext {
  return {
    metrics: createMetrics(),
    thresholds: DEFAULT_THRESHOLDS,
  };
}

describe('renderBadge — merkle-fresh', () => {
  it('returns unknown when no series have been recorded yet', async () => {
    const ctx = makeCtx();
    const r = await renderBadge(ctx, 'merkle-fresh');
    expect(r).toEqual({
      schemaVersion: 1,
      label: 'merkle root',
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: 15,
    });
  });

  it('returns fresh when age is below threshold', async () => {
    const ctx = makeCtx();
    ctx.metrics.merkleRootAgeSeconds.set({ distributor: 'D1' }, 100);
    const r = await renderBadge(ctx, 'merkle-fresh');
    expect(r.message).toBe('fresh');
    expect(r.color).toBe('brightgreen');
    expect(r.cacheSeconds).toBe(60);
  });

  it('returns stale when age exceeds threshold', async () => {
    const ctx = makeCtx();
    ctx.metrics.merkleRootAgeSeconds.set(
      { distributor: 'D1' },
      DEFAULT_THRESHOLDS.merkleFreshSec + 1,
    );
    const r = await renderBadge(ctx, 'merkle-fresh');
    expect(r.message).toBe('stale');
    expect(r.color).toBe('red');
    expect(r.cacheSeconds).toBe(30);
  });
});

describe('renderBadge — nav-fresh', () => {
  it('returns fresh when age is below threshold', async () => {
    const ctx = makeCtx();
    ctx.metrics.navAgeSeconds.set({ rwt_engine: 'V1' }, 60);
    const r = await renderBadge(ctx, 'nav-fresh');
    expect(r.message).toBe('fresh');
    expect(r.label).toBe('nav');
  });

  it('returns stale when age exceeds threshold', async () => {
    const ctx = makeCtx();
    ctx.metrics.navAgeSeconds.set({ rwt_engine: 'V1' }, DEFAULT_THRESHOLDS.navFreshSec + 1);
    const r = await renderBadge(ctx, 'nav-fresh');
    expect(r.message).toBe('stale');
  });
});

describe('renderBadge — authority-ok', () => {
  it('returns ok when all 5 contracts report 1', async () => {
    const ctx = makeCtx();
    for (const c of ['ot_governance', 'futarchy_config', 'rwt_vault', 'dex_config', 'yd_distribution_config']) {
      ctx.metrics.authorityMatch.set({ contract: c, authority: 'A' }, 1);
    }
    const r = await renderBadge(ctx, 'authority-ok');
    expect(r.message).toBe('ok');
    expect(r.color).toBe('brightgreen');
  });

  it('returns drift when any contract reports 0', async () => {
    const ctx = makeCtx();
    ctx.metrics.authorityMatch.set({ contract: 'rwt_vault', authority: 'A' }, 0);
    ctx.metrics.authorityMatch.set({ contract: 'ot_governance', authority: 'A' }, 1);
    const r = await renderBadge(ctx, 'authority-ok');
    expect(r.message).toBe('drift');
    expect(r.color).toBe('red');
  });

  it('returns unknown when only -1 values are present (no drift)', async () => {
    const ctx = makeCtx();
    ctx.metrics.authorityMatch.set({ contract: 'rwt_vault', authority: 'A' }, -1);
    const r = await renderBadge(ctx, 'authority-ok');
    expect(r.message).toBe('unknown');
    expect(r.color).toBe('lightgrey');
  });

  it('drift takes precedence over unknown when both are present', async () => {
    const ctx = makeCtx();
    ctx.metrics.authorityMatch.set({ contract: 'rwt_vault', authority: 'A' }, -1);
    ctx.metrics.authorityMatch.set({ contract: 'ot_governance', authority: 'A' }, 0);
    const r = await renderBadge(ctx, 'authority-ok');
    expect(r.message).toBe('drift');
  });
});

describe('renderBadge — supply-ok', () => {
  it('returns ok when drift is 0', async () => {
    const ctx = makeCtx();
    ctx.metrics.rwtSupplyDriftAbs.set({ rwt_engine: 'V1' }, 0);
    const r = await renderBadge(ctx, 'supply-ok');
    expect(r.message).toBe('ok');
  });

  it('returns drift when any series is non-zero', async () => {
    const ctx = makeCtx();
    ctx.metrics.rwtSupplyDriftAbs.set({ rwt_engine: 'V1' }, 1);
    const r = await renderBadge(ctx, 'supply-ok');
    expect(r.message).toBe('drift');
  });
});

describe('createBadgesHandler', () => {
  async function runHttp(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      handler(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    return {
      port: addr.port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('serves /api/badges/merkle-fresh with Cache-Control header', async () => {
    const ctx = makeCtx();
    ctx.metrics.merkleRootAgeSeconds.set({ distributor: 'D1' }, 60);
    const handler = createBadgesHandler(ctx);
    const { port, close } = await runHttp(handler);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/badges/merkle-fresh`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(r.headers.get('cache-control')).toMatch(/max-age=\d+/);
      const body = await r.json();
      expect(body.schemaVersion).toBe(1);
      expect(body.label).toBe('merkle root');
      expect(body.message).toBe('fresh');
    } finally {
      await close();
    }
  });

  it('returns 404 for /api/badges/<unknown-name>', async () => {
    const handler = createBadgesHandler(makeCtx());
    const { port, close } = await runHttp(handler);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/badges/not-a-real-badge`);
      expect(r.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('returns 404 for paths outside /api/badges/', async () => {
    const handler = createBadgesHandler(makeCtx());
    const { port, close } = await runHttp(handler);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/something/else`);
      expect(r.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('all four badge names are routable', async () => {
    const handler = createBadgesHandler(makeCtx());
    const { port, close } = await runHttp(handler);
    try {
      for (const name of BADGE_NAMES) {
        const r = await fetch(`http://127.0.0.1:${port}/api/badges/${name}`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.schemaVersion).toBe(1);
      }
    } finally {
      await close();
    }
  });
});
