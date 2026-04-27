/**
 * Shared env-variable parsers.
 *
 * Cranks call these from their per-bot `loadConfig()` to keep the
 * environment contract identical across the bot fleet (D11 — every bot
 * accepts the same `RPC_URLS` tuple format).
 */

import type { RpcEndpoint } from './types.js';

/**
 * Parse the `RPC_URLS` env var into a list of {@link RpcEndpoint}s.
 *
 * Format: comma-separated tuples of `<httpUrl>|<wsUrl>|<weight>`. The WS
 * URL and weight are optional. Highest-weight endpoint becomes primary;
 * lower-weight endpoints are fallbacks.
 *
 * Examples:
 *   `https://mainnet.helius-rpc.com/?api-key=X|wss://mainnet.helius-rpc.com/?api-key=X|100`
 *   `https://api.devnet.solana.com|wss://api.devnet.solana.com|100, https://rpc.example.com`
 *
 * Throws on:
 *   - empty input,
 *   - missing HTTP url in any tuple,
 *   - non-numeric or non-positive weight.
 */
export function parseRpcEndpoints(raw: string): RpcEndpoint[] {
  const parts = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (parts.length === 0) {
    throw new Error('RPC_URLS must contain at least one endpoint');
  }
  return parts.map((tuple, i) => {
    const [httpUrl, wsUrl, weightStr] = tuple.split('|').map(s => s?.trim());
    if (!httpUrl) {
      throw new Error(`RPC_URLS[${i}]: missing HTTP url in "${tuple}"`);
    }
    const weight = weightStr ? Number.parseInt(weightStr, 10) : 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`RPC_URLS[${i}]: invalid weight "${weightStr}"`);
    }
    return {
      url: httpUrl,
      wsUrl: wsUrl && wsUrl.length > 0 ? wsUrl : undefined,
      weight,
      failureCount: 0,
    };
  });
}
