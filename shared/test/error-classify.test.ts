/**
 * Phase 21: classifyError unit tests.
 *
 * Coverage matrix (≥10 cases per architect plan §11.1):
 *   - null sentinel
 *   - blockhash-expired (name + message)
 *   - Anchor program log
 *   - custom program error message
 *   - sim failure (preflight)
 *   - ECONNREFUSED / ECONNRESET / ETIMEDOUT
 *   - HTTP 5xx token
 *   - fetch failed
 *   - bare SendTransactionError (no logs)
 *   - unknown garbage error
 *   - Anchor wrapped in error.cause (cause-chain walk)
 *   - circular cause (must not infinite-loop)
 */

import { describe, expect, it } from 'vitest';

import { classifyError } from '../src/error-classify.js';

describe('classifyError', () => {
  it('null → ok (sentinel)', () => {
    expect(classifyError(null)).toBe('ok');
  });

  it('undefined → ok (sentinel)', () => {
    expect(classifyError(undefined)).toBe('ok');
  });

  it('TransactionExpiredBlockheightExceededError name → timeout', () => {
    const err = Object.assign(new Error('expired'), {
      name: 'TransactionExpiredBlockheightExceededError',
    });
    expect(classifyError(err)).toBe('timeout');
  });

  it('block height exceeded message → timeout', () => {
    const err = new Error(
      'Transaction was not confirmed in 60.00 seconds. block height exceeded',
    );
    expect(classifyError(err)).toBe('timeout');
  });

  it('Anchor program log → onchain_error', () => {
    const err = Object.assign(new Error('send failed'), {
      logs: [
        'Program 11111111111111111111111111111111 invoke [1]',
        'Program log: AnchorError occurred. Error Code: ConstraintSeeds',
        'Program 11111111111111111111111111111111 failed: custom program error: 0x7d2',
      ],
    });
    expect(classifyError(err)).toBe('onchain_error');
  });

  it('custom program error in message → onchain_error', () => {
    const err = new Error('failed: custom program error: 0x1770');
    expect(classifyError(err)).toBe('onchain_error');
  });

  it('Transaction simulation failed → sim_error', () => {
    const err = new Error('Transaction simulation failed: BlockhashNotFound');
    expect(classifyError(err)).toBe('sim_error');
  });

  it('failed to simulate transaction → sim_error', () => {
    const err = new Error('failed to simulate transaction: insufficient lamports');
    expect(classifyError(err)).toBe('sim_error');
  });

  it('ECONNREFUSED → rpc_error', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8899');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('ECONNRESET → rpc_error', () => {
    const err = new Error('socket disconnected (ECONNRESET)');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('ETIMEDOUT → rpc_error', () => {
    const err = new Error('connect ETIMEDOUT 1.2.3.4:443');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('HTTP 503 token → rpc_error', () => {
    const err = new Error('failed to send: 503 Service Unavailable');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('HTTP 502 token → rpc_error', () => {
    const err = new Error('upstream returned 502 Bad Gateway');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('fetch failed → rpc_error', () => {
    const err = new Error('fetch failed');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('socket hang up → rpc_error', () => {
    const err = new Error('socket hang up');
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('bare SendTransactionError → rpc_error (default)', () => {
    const err = Object.assign(new Error('weird'), { name: 'SendTransactionError' });
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('unknown garbage → rpc_error (safe default)', () => {
    expect(classifyError(new Error('lol nope'))).toBe('rpc_error');
  });

  it('Anchor in cause chain → onchain_error (cause walk)', () => {
    const inner = Object.assign(new Error('inner'), {
      logs: ['Program log: AnchorError. Error Code: BadConstraint'],
    });
    const wrapper = Object.assign(new Error('outer wrap'), { cause: inner });
    expect(classifyError(wrapper)).toBe('onchain_error');
  });

  it('block height exceeded in cause chain → timeout', () => {
    const inner = new Error('block height exceeded');
    const outer = Object.assign(new Error('wrap'), { cause: inner });
    expect(classifyError(outer)).toBe('timeout');
  });

  it('circular cause does not infinite-loop', () => {
    // Build a→b→a self-cycle. Classifier must terminate and return a result.
    type Cyc = Error & { cause?: unknown };
    const a: Cyc = new Error('a');
    const b: Cyc = new Error('b');
    a.cause = b;
    b.cause = a;
    // With no real signal in either, defaults to rpc_error.
    expect(classifyError(a)).toBe('rpc_error');
  });

  it('non-Error value is handled (string thrown)', () => {
    expect(classifyError('boom')).toBe('rpc_error');
  });

  it('Anchor in nested logs takes priority over generic 503 in message', () => {
    // Both signals present — anchor must win because the on-chain failure
    // is the more specific cause of the failed TX.
    const err = Object.assign(new Error('tx returned 503'), {
      logs: ['Program log: AnchorError. Error Code: ArithmeticOverflow'],
    });
    expect(classifyError(err)).toBe('onchain_error');
  });

  // Phase 21.5 INFO 9a: classifier must not invoke `toString()` on non-string
  // message/log entries. Hostile objects in those slots are treated as empty.
  it('non-string message with hostile toString() is ignored', () => {
    // The toString() returns "Program log: AnchorError" — a string that, if
    // it reached the corpus, would force onchain_error classification.
    // After the typeof guard the slot is treated as empty and the classifier
    // falls through to the rpc_error default.
    const hostileMessage = {
      toString: () => 'Program log: AnchorError. Error Code: Hijack',
    };
    const err = { name: 'WeirdError', message: hostileMessage };
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('non-string log entry with hostile toString() is ignored', () => {
    const hostileLog = {
      toString: () => 'Program log: AnchorError. Error Code: Hijack',
    };
    const err = { name: 'SendTransactionError', logs: [hostileLog] };
    // SendTransactionError name pushes us into rpc_error (rule 5), and the
    // hostile log entry must NOT escalate that to onchain_error.
    expect(classifyError(err)).toBe('rpc_error');
  });

  it('non-string name is ignored', () => {
    // A weird `name` field that isn't a string must not be treated as
    // SendTransactionError or as the blockhash-expired marker.
    const err = {
      name: { toString: () => 'TransactionExpiredBlockheightExceededError' },
      message: 'totally fine',
    };
    // Without a real string name match, defaults to rpc_error.
    expect(classifyError(err)).toBe('rpc_error');
  });
});
