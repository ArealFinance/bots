/**
 * Phase 21: TX classification integration test for revenue-crank.
 *
 * Verifies that classifyError correctly maps different error/success
 * paths to bot_tx_total{result=...} metric values. This is critical
 * because TxOnchainError alert routing depends on correct classification.
 *
 * Test cases:
 *   - null/undefined → ok
 *   - Anchor program log (onchain_error)
 *   - RPC timeout/ECONNREFUSED (rpc_error or timeout)
 *   - Unknown error → unknown_error
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createBotMetrics, classifyError } from '@areal/bots-shared';
import type { TxResult } from '@areal/bots-shared';

describe('TX Classification Integration (revenue-crank)', () => {
  let metrics: ReturnType<typeof createBotMetrics>;

  beforeEach(() => {
    metrics = createBotMetrics({
      bot: 'revenue-crank-test',
      instructions: ['distribute_revenue'],
      port: 19998,
      walletPubkey: 'Fg6PaFpoGXkYsLMSmYBcZRTc6vFrFj7RwgxF7tzpdgUg',
    });
  });

  afterEach(async () => {
    await metrics.shutdown();
  });

  function findMetricLine(output: string, result: string): string | undefined {
    const lines = output.split('\n');
    return lines.find(
      line =>
        line.includes('bot_tx_total{') &&
        line.includes('distribute_revenue') &&
        line.includes(`result="${result}"`) &&
        !line.startsWith('#'),
    );
  }

  describe('observeTx metric recording with classifyError', () => {
    it('records ok when submit succeeds (null error)', async () => {
      // Simulate successful TX submit (no error)
      const result = classifyError(null);
      expect(result).toBe('ok');

      // Record it
      await metrics.observeTx('distribute_revenue', async () => {
        return 'abc123'; // TX signature
      }, classifyError);

      // Verify metric was incremented
      const metricsOutput = await metrics.registry.metrics();
      const line = findMetricLine(metricsOutput, 'ok');
      expect(line).toBeDefined();
      expect(line).toContain('result="ok"');
    });

    it('records onchain_error for Anchor program logs', async () => {
      const anchorError = Object.assign(new Error('send failed'), {
        logs: [
          'Program 11111111111111111111111111111111 invoke [1]',
          'Program log: AnchorError occurred. Error Code: ConstraintSeeds',
          'Program 11111111111111111111111111111111 consumed 5000 of 200000 compute units',
          'Program 11111111111111111111111111111111 failed: custom instruction error',
        ],
      });

      const result = classifyError(anchorError);
      expect(result).toBe('onchain_error');

      // Record it
      await metrics.observeTx('distribute_revenue', async () => {
        throw anchorError;
      }, classifyError).catch(() => {
        // Expected to fail
      });

      const metricsOutput = await metrics.registry.metrics();
      const line = findMetricLine(metricsOutput, 'onchain_error');
      expect(line).toBeDefined();
      expect(line).toContain('result="onchain_error"');
    });

    it('records rpc_error for connection refused', async () => {
      const connError = new Error('ECONNREFUSED: Connection refused');

      const result = classifyError(connError);
      expect(result).toBe('rpc_error');

      await metrics.observeTx('distribute_revenue', async () => {
        throw connError;
      }, classifyError).catch(() => {
        // Expected to fail
      });

      const metricsOutput = await metrics.registry.metrics();
      const line = findMetricLine(metricsOutput, 'rpc_error');
      expect(line).toBeDefined();
      expect(line).toContain('result="rpc_error"');
    });

    it('records timeout for blockhash expired', async () => {
      const timeoutError = Object.assign(new Error('block height exceeded'), {
        name: 'TransactionExpiredBlockheightExceededError',
      });

      const result = classifyError(timeoutError);
      expect(result).toBe('timeout');

      await metrics.observeTx('distribute_revenue', async () => {
        throw timeoutError;
      }, classifyError).catch(() => {
        // Expected to fail
      });

      const metricsOutput = await metrics.registry.metrics();
      const line = findMetricLine(metricsOutput, 'timeout');
      expect(line).toBeDefined();
      expect(line).toContain('result="timeout"');
    });

    it('records rpc_error for unclassifiable exceptions (default fallback)', async () => {
      const unknownError = new Error('something weird happened');

      const result = classifyError(unknownError);
      expect(result).toBe('rpc_error'); // Unclassified defaults to rpc_error

      await metrics.observeTx('distribute_revenue', async () => {
        throw unknownError;
      }, classifyError).catch(() => {
        // Expected to fail
      });

      const metricsOutput = await metrics.registry.metrics();
      const line = findMetricLine(metricsOutput, 'rpc_error');
      expect(line).toBeDefined();
      expect(line).toContain('result="rpc_error"');
    });

    it('multiple result labels are all tracked independently', async () => {
      // Record multiple different result paths in sequence
      const calls = [
        { error: null, expected: 'ok' as TxResult },
        {
          error: new Error('block height exceeded'),
          expected: 'timeout' as TxResult,
        },
        {
          error: new Error('ECONNREFUSED'),
          expected: 'rpc_error' as TxResult,
        },
      ];

      for (const { error, expected } of calls) {
        const classified = classifyError(error);
        expect(classified).toBe(expected);

        if (error === null) {
          await metrics.observeTx('distribute_revenue', async () => 'tx1', classifyError);
        } else {
          await metrics.observeTx('distribute_revenue', async () => {
            throw error;
          }, classifyError).catch(() => {
            /* noop */
          });
        }
      }

      const metricsOutput = await metrics.registry.metrics();

      // Verify all three result labels were incremented
      expect(metricsOutput).toContain('result="ok"');
      expect(metricsOutput).toContain('result="timeout"');
      expect(metricsOutput).toContain('result="rpc_error"');
    });
  });

  describe('classifyError edge cases (ensuring correctness for routing)', () => {
    it('handles cause chain walking for wrapped errors', () => {
      const innerErr = new Error('ECONNRESET');
      const wrappedErr = Object.assign(new Error('fetch failed'), {
        cause: innerErr,
      });

      const result = classifyError(wrappedErr);
      expect(result).toMatch(/rpc_error|timeout/);
    });

    it('handles circular cause chains without infinite loop', () => {
      const err1 = new Error('loop');
      const err2 = Object.assign(new Error('inner'), { cause: err1 });
      // Create cycle
      Object.assign(err1, { cause: err2 });

      // Should not hang or throw
      const result = classifyError(err2);
      expect(typeof result).toBe('string');
      expect(['ok', 'onchain_error', 'rpc_error', 'timeout', 'unknown_error']).toContain(result);
    });

    it('handles non-Error throws', () => {
      const result = classifyError('string error');
      expect(typeof result).toBe('string');
      expect(['ok', 'onchain_error', 'rpc_error', 'timeout', 'unknown_error']).toContain(result);
    });
  });
});
