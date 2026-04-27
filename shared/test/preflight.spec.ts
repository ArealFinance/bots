/**
 * R-60: shared SOL pre-flight unit tests.
 *
 * Coverage:
 *   - sufficient balance → 'ok'
 *   - insufficient balance → 'skip' with reason 'low_sol'
 *   - all-RPC-failure path → throws AggregateError (we propagate, not swallow,
 *     so cycle handlers can decide policy without bypassing the gate).
 *   - env override parsing edge cases.
 */

import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { MultiRpcClient } from '../src/rpc-pool.js';
import {
  MIN_LAMPORTS_DEFAULT,
  assertCrankBalance,
  resolveMinLamportsFromEnv,
} from '../src/preflight.js';

function makeClientWithBalance(balance: number): MultiRpcClient {
  const client = new MultiRpcClient([
    { url: 'http://primary', weight: 2, failureCount: 0 },
    { url: 'http://secondary', weight: 1, failureCount: 0 },
  ]);
  // Replace withFallback so we don't actually issue any RPC traffic.
  // This emulates the success path on the first endpoint.
  vi.spyOn(client, 'withFallback').mockImplementation(async <T>(_op: any) => {
    return balance as unknown as T;
  });
  return client;
}

function makeFailingClient(): MultiRpcClient {
  const client = new MultiRpcClient([
    { url: 'http://primary', weight: 2, failureCount: 0 },
    { url: 'http://secondary', weight: 1, failureCount: 0 },
  ]);
  vi.spyOn(client, 'withFallback').mockImplementation(async () => {
    throw new AggregateError(
      [new Error('rpc 1 down'), new Error('rpc 2 down')],
      'MultiRpcClient: all endpoints failed',
    );
  });
  return client;
}

const PUB = Keypair.generate().publicKey;

describe('assertCrankBalance', () => {
  it('returns ok when balance >= minLamports', async () => {
    const client = makeClientWithBalance(100_000_000);
    const out = await assertCrankBalance(client, PUB, 50_000_000);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.balance).toBe(100_000_000);
    }
  });

  it('returns skip/low_sol with balance + required when balance < minLamports', async () => {
    const client = makeClientWithBalance(10_000_000);
    const out = await assertCrankBalance(client, PUB, 50_000_000);
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toBe('low_sol');
      expect(out.balance).toBe(10_000_000);
      expect(out.required).toBe(50_000_000);
    }
  });

  it('uses MIN_LAMPORTS_DEFAULT when minLamports omitted', async () => {
    const client = makeClientWithBalance(MIN_LAMPORTS_DEFAULT - 1);
    const out = await assertCrankBalance(client, PUB);
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.required).toBe(MIN_LAMPORTS_DEFAULT);
    }
  });

  it('treats balance == minLamports as ok (non-strict comparison)', async () => {
    const client = makeClientWithBalance(50_000_000);
    const out = await assertCrankBalance(client, PUB, 50_000_000);
    expect(out.kind).toBe('ok');
  });

  it('propagates AggregateError when all endpoints fail (does NOT silently bypass)', async () => {
    const client = makeFailingClient();
    await expect(assertCrankBalance(client, PUB, 50_000_000)).rejects.toThrow(
      /all endpoints failed/,
    );
  });

  it('floors negative minLamports to 0 (always ok)', async () => {
    const client = makeClientWithBalance(0);
    const out = await assertCrankBalance(client, PUB, -100);
    expect(out.kind).toBe('ok');
  });
});

describe('resolveMinLamportsFromEnv', () => {
  it('returns default when env var unset', () => {
    expect(resolveMinLamportsFromEnv('REVENUE', {})).toBe(MIN_LAMPORTS_DEFAULT);
  });

  it('returns parsed integer when env var is a positive number', () => {
    expect(
      resolveMinLamportsFromEnv('REVENUE', { REVENUE_MIN_SOL_LAMPORTS: '123456' }),
    ).toBe(123456);
  });

  it('returns default for non-numeric env var', () => {
    expect(
      resolveMinLamportsFromEnv('REVENUE', { REVENUE_MIN_SOL_LAMPORTS: 'abc' }),
    ).toBe(MIN_LAMPORTS_DEFAULT);
  });

  it('returns default for zero / negative env var', () => {
    expect(
      resolveMinLamportsFromEnv('REVENUE', { REVENUE_MIN_SOL_LAMPORTS: '0' }),
    ).toBe(MIN_LAMPORTS_DEFAULT);
    expect(
      resolveMinLamportsFromEnv('REVENUE', { REVENUE_MIN_SOL_LAMPORTS: '-1' }),
    ).toBe(MIN_LAMPORTS_DEFAULT);
  });

  it('uppercases the prefix to match env conventions', () => {
    expect(
      resolveMinLamportsFromEnv('revenue', { REVENUE_MIN_SOL_LAMPORTS: '999' }),
    ).toBe(999);
  });
});
