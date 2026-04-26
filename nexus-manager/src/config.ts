/**
 * Env-driven config for the nexus-manager bot.
 *
 * No secrets in `.env.example` — only file-path placeholders. Production
 * hardening migrates `MANAGER_KEYPAIR_PATH` to a KMS reference per future
 * R3/R6 (out of scope for Layer 9).
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import type { RpcEndpoint } from '@areal/bots-shared';

const NetworkSchema = z.enum(['devnet', 'mainnet']);
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const EnvSchema = z.object({
  /** Pipe-separated RPC tuple list: `<http>|<ws>|<weight>`, comma-separated. */
  RPC_URLS: z.string().min(1),
  NETWORK: NetworkSchema.default('devnet'),

  MANAGER_KEYPAIR_PATH: z.string().min(1),

  LOCK_DIR: z.string().default('./data/locks'),
  CHECKPOINT_DB: z.string().default('./data/nexus-manager.db'),

  POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(300),

  MIN_REBALANCE_USDC: z.coerce.bigint().default(1_000_000n),
  LP_TARGET_RATIO_BPS: z.coerce.number().int().min(0).max(10_000).default(5_000),
  LP_REBALANCE_TRIGGER_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(500),
  MAX_POOL_CONCENTRATION_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(5_000),

  DEX_PROGRAM_ID: z.string().min(32),
  USDC_MINT: z.string().min(32),
  RWT_MINT: z.string().min(32),

  /** Comma-separated PoolState PDAs the bot manages. Empty = idle. */
  NEXUS_MANAGED_POOLS: z.string().default(''),

  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Network = z.infer<typeof NetworkSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface ManagerConfig {
  network: Network;
  rpcEndpoints: RpcEndpoint[];

  managerKeypair: Keypair;
  managerKeypairPath: string;

  lockDir: string;
  checkpointDb: string;

  pollIntervalSec: number;

  minRebalanceUsdc: bigint;
  lpTargetRatioBps: number;
  lpRebalanceTriggerBps: number;
  maxPoolConcentrationBps: number;

  dexProgramId: PublicKey;
  usdcMint: PublicKey;
  rwtMint: PublicKey;

  managedPools: PublicKey[];

  logLevel: LogLevel;
}

/**
 * Read a Solana keypair JSON file (`Uint8Array` of 64 bytes encoded as a JSON
 * array — the standard `solana-keygen new -o file.json` output).
 *
 * Throws if the file is missing or malformed. Layer 9 only supports the
 * local-file driver; KMS driver is deferred to mainnet (R3/R6).
 */
function loadKeypairFromFile(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`manager keypair file not found at ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `manager keypair file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every(b => typeof b === 'number')) {
    throw new Error(
      `manager keypair file at ${path} must be a 64-element JSON array of bytes (solana-keygen format)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

/**
 * Parse the `RPC_URLS` env var into a list of {@link RpcEndpoint}s.
 *
 * Format: comma-separated tuples of `<httpUrl>|<wsUrl>|<weight>`. The WS URL
 * is optional — if omitted the {@link MultiRpcClient} relies on the HTTP
 * endpoint's default WS sibling.
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

function parsePubkey(raw: string, label: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${label}: invalid pubkey "${raw}"`);
  }
}

export function loadConfig(): ManagerConfig {
  const raw = EnvSchema.parse(process.env);

  const rpcEndpoints = parseRpcEndpoints(raw.RPC_URLS);

  const managerKeypair = loadKeypairFromFile(raw.MANAGER_KEYPAIR_PATH);

  const dexProgramId = parsePubkey(raw.DEX_PROGRAM_ID, 'DEX_PROGRAM_ID');
  const usdcMint = parsePubkey(raw.USDC_MINT, 'USDC_MINT');
  const rwtMint = parsePubkey(raw.RWT_MINT, 'RWT_MINT');

  const managedPools = raw.NEXUS_MANAGED_POOLS.split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => parsePubkey(s, 'NEXUS_MANAGED_POOLS'));

  return {
    network: raw.NETWORK,
    rpcEndpoints,

    managerKeypair,
    managerKeypairPath: raw.MANAGER_KEYPAIR_PATH,

    lockDir: raw.LOCK_DIR,
    checkpointDb: raw.CHECKPOINT_DB,

    pollIntervalSec: raw.POLL_INTERVAL_SEC,

    minRebalanceUsdc: raw.MIN_REBALANCE_USDC,
    lpTargetRatioBps: raw.LP_TARGET_RATIO_BPS,
    lpRebalanceTriggerBps: raw.LP_REBALANCE_TRIGGER_BPS,
    maxPoolConcentrationBps: raw.MAX_POOL_CONCENTRATION_BPS,

    dexProgramId,
    usdcMint,
    rwtMint,

    managedPools,

    logLevel: raw.LOG_LEVEL,
  };
}
