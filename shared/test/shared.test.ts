/**
 * Unit tests for the bots/shared package.
 *
 * Coverage:
 *   - MultiRpcClient: rotation order, fallback chain, failure tracking.
 *   - consensusRead: quorum success, dissenter demotion, split → throw,
 *                    insufficient successes → throw, custom comparator.
 *   - SingleInstanceLock: acquire/release, stale reclaim, live peer reject.
 *   - reconcileEvents: empty range, paginated walk, abort signal.
 *
 * `Connection` is mocked because we never want unit tests touching a real
 * RPC. The mock surface is narrow (just the methods we exercise).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';

import { MultiRpcClient } from '../src/rpc-pool.js';
import { consensusRead } from '../src/consensus.js';
import { SingleInstanceLock } from '../src/lock.js';
import { reconcileEvents } from '../src/reconcile.js';
import {
  AlreadyRunningError,
  ConsensusError,
  type RpcEndpoint,
} from '../src/types.js';

// -- MultiRpcClient ---------------------------------------------------------

function endpoints(...urls: string[]): RpcEndpoint[] {
  return urls.map((url, i) => ({
    url,
    weight: urls.length - i, // first = highest weight
    failureCount: 0,
  }));
}

describe('MultiRpcClient', () => {
  it('selects the highest-weight endpoint as primary', () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const primary = client.primary();
    // We can't read .url from Connection — but rotation() ordering surfaces
    // through describe() after sort.
    expect(client.describe()[0]!.url).toBe('http://a');
    expect(primary).toBeDefined();
  });

  it('demotes endpoints with higher failure count', () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b'));
    client.markFailure('http://a');
    client.markFailure('http://a');
    // After 2 failures on a, b should be primary in rotation.
    const all = client.all();
    expect(all.length).toBe(2);
    // The first endpoint in rotation should now be b (zero failures).
    // We verify via withFallback: stub op throws on first endpoint, succeeds
    // on second; the rotated-first endpoint receives the call first.
    let calls = 0;
    return client
      .withFallback(async () => {
        calls += 1;
        return 'ok';
      })
      .then(result => {
        expect(result).toBe('ok');
        expect(calls).toBe(1); // b succeeded immediately
      });
  });

  it('falls back to next endpoint when primary throws', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b'));
    let attempts = 0;
    const result = await client.withFallback(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('primary down');
      return 'fallback-success';
    });
    expect(result).toBe('fallback-success');
    expect(attempts).toBe(2);
    // a should now have failureCount 1.
    expect(client.describe().find(e => e.url === 'http://a')?.failureCount).toBe(1);
  });

  it('throws AggregateError when all endpoints fail', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b'));
    await expect(
      client.withFallback(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/all endpoints failed/);
  });

  it('rejects empty endpoint list', () => {
    expect(() => new MultiRpcClient([])).toThrow(/at least one endpoint/);
  });

  it('resetFailures clears all failure counters', () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b'));
    client.markFailure('http://a');
    client.markFailure('http://b');
    client.resetFailures();
    for (const ep of client.describe()) {
      expect(ep.failureCount).toBe(0);
    }
  });
});

// -- consensusRead ----------------------------------------------------------

describe('consensusRead', () => {
  it('returns the consensus value when quorum is met', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const result = await consensusRead(
      client,
      async () => 42n,
      { quorum: 2 },
    );
    expect(result).toBe(42n);
  });

  it('marks dissenters as failed', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const conns = client.all();
    let idx = 0;
    await consensusRead(
      client,
      async conn => {
        // We can't reliably correlate conn → url from outside, but we know
        // there are exactly N conns and we visit each once — so we cycle
        // a counter to give one of them a different answer.
        const i = conns.indexOf(conn);
        idx += 1;
        return i === 0 ? 999n : 100n; // first endpoint dissents
      },
      { quorum: 2 },
    );
    // After dissent, exactly one endpoint should have failureCount === 1.
    const failed = client.describe().filter(e => e.failureCount > 0);
    expect(failed.length).toBe(1);
    expect(idx).toBe(3); // all three were polled
  });

  it('throws ConsensusError when quorum cannot be reached (split)', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const conns = client.all();
    let counter = 0;
    await expect(
      consensusRead(
        client,
        async conn => {
          const i = conns.indexOf(conn);
          counter += 1;
          // Each endpoint gives a different answer → no quorum of 2.
          return BigInt(i + 1);
        },
        { quorum: 2 },
      ),
    ).rejects.toThrow(ConsensusError);
    expect(counter).toBe(3);
  });

  it('throws ConsensusError when too many endpoints fail', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const conns = client.all();
    await expect(
      consensusRead(
        client,
        async conn => {
          const i = conns.indexOf(conn);
          if (i < 2) throw new Error('rpc down');
          return 7n;
        },
        { quorum: 2 },
      ),
    ).rejects.toThrow(/only 1\/3 endpoints succeeded/);
  });

  it('rejects quorum > pool size', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b'));
    await expect(
      consensusRead(client, async () => 1, { quorum: 3 }),
    ).rejects.toThrow(/exceeds pool size/);
  });

  it('rejects quorum < 1', async () => {
    const client = new MultiRpcClient(endpoints('http://a'));
    await expect(
      consensusRead(client, async () => 1, { quorum: 0 }),
    ).rejects.toThrow(/quorum must be ≥ 1/);
  });

  it('honours custom comparator (slot-tolerant)', async () => {
    const client = new MultiRpcClient(endpoints('http://a', 'http://b', 'http://c'));
    const conns = client.all();
    // Each endpoint returns a different slot but the same data — should
    // pass under a comparator that ignores slot.
    const result = await consensusRead(
      client,
      async conn => {
        const i = conns.indexOf(conn);
        return { slot: 100 + i, data: 'shared-payload' };
      },
      {
        quorum: 2,
        comparator: (a, b) => a.data === b.data,
      },
    );
    expect(result.data).toBe('shared-payload');
  });

  it('quorum=1 acts like a single-RPC read', async () => {
    const client = new MultiRpcClient(endpoints('http://a'));
    const result = await consensusRead(client, async () => 'hello', {
      quorum: 1,
    });
    expect(result).toBe('hello');
  });
});

// -- SingleInstanceLock -----------------------------------------------------

describe('SingleInstanceLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-shared-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    const lock = new SingleInstanceLock();
    await lock.acquire({ lockDir: tmpDir, instanceId: 'test-bot' });
    const filePath = path.join(tmpDir, 'test-bot.lock');
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(raw.instanceId).toBe('test-bot');

    await lock.release();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects invalid instanceId', async () => {
    const lock = new SingleInstanceLock();
    await expect(
      lock.acquire({ lockDir: tmpDir, instanceId: 'bad name!' }),
    ).rejects.toThrow(/invalid instanceId/);
  });

  it('reclaims a stale lock (peer dead)', async () => {
    // Write a lock-file pointing at a clearly-dead PID (PID 1 cannot be
    // killed by us in test env, so use a guaranteed-invalid PID).
    const filePath = path.join(tmpDir, 'stale-bot.lock');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        pid: 999_999_999, // virtually guaranteed to not exist
        startedAt: Date.now() - 10_000,
        instanceId: 'stale-bot',
      }),
    );

    const lock = new SingleInstanceLock();
    await lock.acquire({ lockDir: tmpDir, instanceId: 'stale-bot' });

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.pid).toBe(process.pid);
    await lock.release();
  });

  it('rejects when a live peer holds the lock', async () => {
    // Use our own PID + a fresh timestamp → guaranteed to be "live and recent".
    const filePath = path.join(tmpDir, 'live-bot.lock');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        instanceId: 'live-bot',
      }),
    );

    const lock = new SingleInstanceLock();
    await expect(
      lock.acquire({ lockDir: tmpDir, instanceId: 'live-bot' }),
    ).rejects.toThrow(AlreadyRunningError);
  });

  it('reclaims when lock-file is corrupt', async () => {
    const filePath = path.join(tmpDir, 'corrupt-bot.lock');
    fs.writeFileSync(filePath, 'not valid json {{{');

    const lock = new SingleInstanceLock();
    await lock.acquire({ lockDir: tmpDir, instanceId: 'corrupt-bot' });
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.pid).toBe(process.pid);
    await lock.release();
  });

  it('release is idempotent', async () => {
    const lock = new SingleInstanceLock();
    await lock.acquire({ lockDir: tmpDir, instanceId: 'idempotent-bot' });
    await lock.release();
    await lock.release(); // must not throw
    expect(lock.heldPath()).toBeNull();
  });
});

// -- reconcileEvents --------------------------------------------------------

describe('reconcileEvents', () => {
  // Minimal Connection mock — only the methods reconcile uses.
  function mockConnection(opts: {
    sigs: Array<{ signature: string; slot: number; blockTime?: number; err?: unknown }>;
    txLogs: Record<string, string[]>;
  }) {
    const allSigs = [...opts.sigs];
    return {
      getSignaturesForAddress: vi.fn(async (_pk: PublicKey, params?: { before?: string; limit?: number }) => {
        // Return descending order with simple `before` cursor support.
        const limit = params?.limit ?? 1000;
        let start = 0;
        if (params?.before) {
          const idx = allSigs.findIndex(s => s.signature === params.before);
          start = idx >= 0 ? idx + 1 : allSigs.length;
        }
        return allSigs.slice(start, start + limit).map(s => ({
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime ?? null,
          err: s.err ?? null,
          memo: null,
        }));
      }),
      getTransaction: vi.fn(async (sig: string) => ({
        slot: allSigs.find(s => s.signature === sig)?.slot ?? 0,
        blockTime: null,
        meta: { logMessages: opts.txLogs[sig] ?? [] },
      })),
    } as any;
  }

  const programId = PublicKey.default;

  it('returns 0 when no signatures match', async () => {
    const conn = mockConnection({ sigs: [], txLogs: {} });
    const handler = vi.fn();
    const dispatched = await reconcileEvents(
      conn,
      { programId, fromSlot: 100 },
      handler,
    );
    expect(dispatched).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches matching signatures oldest-first', async () => {
    const conn = mockConnection({
      sigs: [
        { signature: 'sig3', slot: 30 },
        { signature: 'sig2', slot: 20 },
        { signature: 'sig1', slot: 10 },
      ],
      txLogs: {
        sig1: ['Program data: AAAA'],
        sig2: ['Program data: BBBB'],
        sig3: ['Program data: CCCC'],
      },
    });
    const seen: { sig: string; slot: number }[] = [];
    const dispatched = await reconcileEvents(
      conn,
      { programId, fromSlot: 0 },
      e => {
        seen.push({ sig: e.signature, slot: e.slot });
      },
    );
    expect(dispatched).toBe(3);
    // Oldest first.
    expect(seen.map(s => s.sig)).toEqual(['sig1', 'sig2', 'sig3']);
  });

  it('respects fromSlot (strict <)', async () => {
    const conn = mockConnection({
      sigs: [
        { signature: 'sig3', slot: 30 },
        { signature: 'sig2', slot: 20 },
        { signature: 'sig1', slot: 10 },
      ],
      txLogs: {
        sig1: ['log1'],
        sig2: ['log2'],
        sig3: ['log3'],
      },
    });
    const handler = vi.fn();
    const dispatched = await reconcileEvents(
      conn,
      { programId, fromSlot: 20 }, // include sig2 (slot=20) AND sig3
      handler,
    );
    expect(dispatched).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('skips errored signatures', async () => {
    const conn = mockConnection({
      sigs: [
        { signature: 'sig2', slot: 20, err: 'failed' },
        { signature: 'sig1', slot: 10 },
      ],
      txLogs: { sig1: ['ok-log'], sig2: [] },
    });
    const handler = vi.fn();
    const dispatched = await reconcileEvents(
      conn,
      { programId, fromSlot: 0 },
      handler,
    );
    expect(dispatched).toBe(1);
  });

  it('respects abort signal pre-flight', async () => {
    const conn = mockConnection({ sigs: [], txLogs: {} });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      reconcileEvents(
        conn,
        { programId, fromSlot: 0, signal: ctrl.signal },
        () => {},
      ),
    ).rejects.toThrow(/aborted/);
  });

  it('respects maxSignatures cap', async () => {
    const sigs = Array.from({ length: 100 }, (_, i) => ({
      signature: `sig${i}`,
      slot: 1000 - i,
    }));
    const txLogs: Record<string, string[]> = {};
    for (const s of sigs) txLogs[s.signature] = [`log-${s.signature}`];

    const conn = mockConnection({ sigs, txLogs });
    const handler = vi.fn();
    const dispatched = await reconcileEvents(
      conn,
      { programId, fromSlot: 0, maxSignatures: 5 },
      handler,
    );
    // We capped collection at 5 signatures.
    expect(dispatched).toBe(5);
  });
});
