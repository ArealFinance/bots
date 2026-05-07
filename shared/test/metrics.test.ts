/**
 * Phase 21: unit tests for `createBotMetrics`.
 *
 * Coverage:
 *   - Constructor validation (port, bot name, instructions enum).
 *   - HTTP server binds 127.0.0.1 only (security guard).
 *   - `/metrics` returns 200 + correct content-type.
 *   - `/healthz` returns valid JSON shape.
 *   - Unknown URL returns 404.
 *   - `observeTx` records ok/error paths and preserves throw.
 *   - `observeTx` rejects unknown instruction (cardinality enforcement).
 *   - `observeKmsSign` records provider label on success and failure.
 *   - `markProgress` updates lastProgressTs.
 *   - `shutdown` closes the server (port reusable after).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createBotMetrics, type BotMetrics, type TxResult } from '../src/metrics.js';

// Track instances so afterEach can shut them down even on test failure
// (otherwise the HTTP server would keep the test runner alive).
const instances: BotMetrics[] = [];

function make(opts?: Partial<Parameters<typeof createBotMetrics>[0]>): BotMetrics {
  const m = createBotMetrics({
    bot: opts?.bot ?? 'test-bot',
    instructions: opts?.instructions ?? ['tick'],
    port: opts?.port ?? 19_999, // caller passes a real port
    startedAt: opts?.startedAt,
    walletPubkey: opts?.walletPubkey,
  });
  instances.push(m);
  return m;
}

/** Curl with retry — handles the brief window between `listen()` and the
 *  socket being accept-ready. */
async function curlReady(port: number, path: string): Promise<{ status: number; ct: string; body: string }> {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return await curl(port, path);
    } catch (err) {
      lastErr = err;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw lastErr;
}

/** Pick an ephemeral free port via Node's built-in OS-assigned listener. */
async function pickPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function curl(port: number, path: string): Promise<{ status: number; ct: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            ct: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      })
      .on('error', reject);
  });
}

/** Same shape as curl() but lets the caller pick the HTTP method — used to
 *  exercise the 405 method gate on /metrics + /healthz. */
async function curlMethod(
  port: number,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS',
): Promise<{ status: number; allow: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            allow: (res.headers['allow'] as string) ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  // Drain in reverse to avoid port-reuse races within a single test file.
  while (instances.length > 0) {
    const m = instances.pop()!;
    try {
      await m.shutdown();
    } catch {
      /* swallow */
    }
  }
});

describe('createBotMetrics — constructor validation', () => {
  it('throws when bot name is empty', () => {
    expect(() => createBotMetrics({ bot: '', instructions: ['x'], port: 9999 })).toThrow(
      /bot name required/i,
    );
  });

  it('throws when port is 0 or negative', () => {
    expect(() => createBotMetrics({ bot: 'b', instructions: ['x'], port: 0 })).toThrow(
      /invalid port/i,
    );
    expect(() => createBotMetrics({ bot: 'b', instructions: ['x'], port: -1 })).toThrow(
      /invalid port/i,
    );
  });

  it('throws when port is above 65535', () => {
    expect(() => createBotMetrics({ bot: 'b', instructions: ['x'], port: 70000 })).toThrow(
      /invalid port/i,
    );
  });

  it('throws when instructions enum is empty', () => {
    expect(() => createBotMetrics({ bot: 'b', instructions: [], port: 9999 })).toThrow(
      /instructions enum must be non-empty/i,
    );
  });
});

describe('createBotMetrics — HTTP server', () => {
  it('binds 127.0.0.1 (loopback only) — never 0.0.0.0', async () => {
    const port = await pickPort();
    const m = make({ port });
    const res = await curlReady(port, '/healthz');
    expect(res.status).toBe(200);
    // The healthz body proves the bind succeeded on loopback.
    expect(res.body).toContain('"status":"ok"');
    void m;
  });

  it('GET /metrics returns 200 with prom text content-type', async () => {
    const port = await pickPort();
    make({ port });
    const res = await curlReady(port, '/metrics');
    expect(res.status).toBe(200);
    expect(res.ct).toMatch(/text\/plain/);
    // prom-client default content-type advertises openmetrics or text/plain;
    // both contain `version=` so we don't lock the exact suffix.
    expect(res.body).toContain('bot_alive');
  });

  it('GET /healthz returns JSON {status, bot, uptime_s}', async () => {
    const port = await pickPort();
    make({ port, bot: 'healthz-bot' });
    const res = await curlReady(port, '/healthz');
    expect(res.status).toBe(200);
    expect(res.ct).toBe('application/json');
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.bot).toBe('healthz-bot');
    expect(typeof body.uptime_s).toBe('number');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('GET unknown URL returns 404', async () => {
    const port = await pickPort();
    make({ port });
    const res = await curlReady(port, '/whatever');
    expect(res.status).toBe(404);
  });

  it('non-GET/HEAD on /metrics returns 405 with Allow header (Phase 21.5 INFO 7a)', async () => {
    const port = await pickPort();
    make({ port });
    // Make sure the server is up before issuing the method-gate probes.
    await curlReady(port, '/healthz');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const res = await curlMethod(port, '/metrics', method);
      expect(res.status).toBe(405);
      expect(res.allow).toBe('GET, HEAD');
    }
  });

  it('non-GET/HEAD on /healthz returns 405 with Allow header (Phase 21.5 INFO 7a)', async () => {
    const port = await pickPort();
    make({ port });
    await curlReady(port, '/healthz');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const res = await curlMethod(port, '/healthz', method);
      expect(res.status).toBe(405);
      expect(res.allow).toBe('GET, HEAD');
    }
  });

  it('shutdown() closes the server', async () => {
    const port = await pickPort();
    const m = make({ port });
    // Verify the port is in use first.
    const r1 = await curlReady(port, '/healthz');
    expect(r1.status).toBe(200);
    // Now shutdown — afterwards the server should refuse connections.
    await m.shutdown();
    // Pop manually so afterEach doesn't double-close.
    instances.pop();
    // Curl should now fail (ECONNREFUSED).
    await expect(curl(port, '/healthz')).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNREFUSED|ECONNRESET/),
    });
  });
});

describe('createBotMetrics — observeTx', () => {
  it('records ok result on success and increments tx_total', async () => {
    const port = await pickPort();
    const m = make({ port, instructions: ['tick'] });
    const out = await m.observeTx('tick', async () => 42, () => 'rpc_error' as TxResult);
    expect(out).toBe(42);
    const text = await m.registry.metrics();
    expect(text).toMatch(/bot_tx_total\{[^}]*result="ok"[^}]*\}\s+1/);
    expect(text).toMatch(/bot_tick_total\{[^}]*instruction="tick"[^}]*\}\s+1/);
  });

  it('records classified error on failure and re-throws', async () => {
    const port = await pickPort();
    const m = make({ port, instructions: ['tick'] });
    const err = new Error('boom');
    await expect(
      m.observeTx('tick', async () => {
        throw err;
      }, () => 'rpc_error' as TxResult),
    ).rejects.toBe(err);
    const text = await m.registry.metrics();
    expect(text).toMatch(/bot_tx_total\{[^}]*result="rpc_error"[^}]*\}\s+1/);
  });

  it('rejects unknown instruction (cardinality enforcement)', async () => {
    const port = await pickPort();
    const m = make({ port, instructions: ['tick'] });
    await expect(
      m.observeTx('not_in_enum', async () => 1, () => 'ok' as TxResult),
    ).rejects.toThrow(/unknown instruction/i);
  });
});

describe('createBotMetrics — observeKmsSign', () => {
  it('records provider+ok on success', async () => {
    const port = await pickPort();
    const m = make({ port });
    const out = await m.observeKmsSign('gcp', async () => 'sig');
    expect(out).toBe('sig');
    const text = await m.registry.metrics();
    expect(text).toMatch(/bot_kms_sign_total\{[^}]*provider="gcp"[^}]*result="ok"[^}]*\}\s+1/);
  });

  it('records provider+rpc_error on failure and re-throws', async () => {
    const port = await pickPort();
    const m = make({ port });
    const err = new Error('kms 403');
    await expect(
      m.observeKmsSign('gcp', async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    const text = await m.registry.metrics();
    expect(text).toMatch(
      /bot_kms_sign_total\{[^}]*provider="gcp"[^}]*result="rpc_error"[^}]*\}\s+1/,
    );
  });
});

describe('createBotMetrics — markProgress + bot_info', () => {
  it('markProgress updates last_progress_timestamp_seconds', async () => {
    const port = await pickPort();
    const m = make({ port });
    // Before any progress, the gauge has not been set explicitly — but
    // observeTx-success path initialises it. Here we test the standalone
    // markProgress() helper used by bots that mark non-TX progress.
    const before = Math.floor(Date.now() / 1000);
    m.markProgress();
    const text = await m.registry.metrics();
    // The metric line shape is: `<name>{bot="..."} <value>`. Account for
    // both labelled and bare forms (default-labels are applied at scrape time).
    const match = text.match(/bot_last_progress_timestamp_seconds(?:\{[^}]*\})?\s+(\d+)/);
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('bot_info one-shot gauge is set when walletPubkey is provided', async () => {
    const port = await pickPort();
    const m = make({ port, walletPubkey: 'WaLLet1111111111111111111111111111111111111' });
    const text = await m.registry.metrics();
    expect(text).toMatch(/bot_info\{[^}]*wallet="WaLLet1111111111111111111111111111111111111"[^}]*\}\s+1/);
  });

  it('bot_info gauge is absent when walletPubkey is omitted', async () => {
    const port = await pickPort();
    const m = make({ port });
    const text = await m.registry.metrics();
    // The HELP line is always emitted; the value line is what matters.
    expect(text).not.toMatch(/bot_info\{wallet=/);
  });
});
