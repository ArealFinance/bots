import 'dotenv/config';
import * as fs from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import type { RpcEndpoint } from '@areal/bots-shared';

const NetworkSchema = z.enum(['devnet', 'mainnet']);
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const EnvSchema = z.object({
  NETWORK: NetworkSchema.default('devnet'),
  /** Pipe-separated RPC tuple list: `<http>|<ws>|<weight>`, comma-separated. */
  RPC_URLS: z
    .string()
    .min(1)
    .default('https://api.devnet.solana.com|wss://api.devnet.solana.com|100'),

  YIELD_CLAIM_CRANK_KEYPAIR_PATH: z.string().min(1),

  YD_PROGRAM_ID: z.string().min(32),
  RWT_ENGINE_PROGRAM_ID: z.string().min(32),
  DEX_PROGRAM_ID: z.string().min(32),
  OT_PROGRAM_ID: z.string().min(32),

  PROOF_DIR: z.string().optional(),
  PROOF_BASE_URL: z.string().url().optional(),

  OT_PROJECTS: z.string().default(''),
  OT_RWT_POOLS: z.string().default(''),

  ARL_OT_MINT: z.string().min(32),
  RWT_MINT: z.string().min(32),

  CLAIM_INTERVAL_SECS: z.coerce.number().int().positive().default(1800),
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().default(150_000),
  COMPUTE_UNIT_PRICE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(10_000),

  LOCK_DIR: z.string().default('./data/locks'),
  DB_PATH: z.string().default('./data/checkpoint.db'),

  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Network = z.infer<typeof NetworkSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export type ProofSource =
  | { kind: 'fs'; baseDir: string }
  | { kind: 'http'; baseUrl: string };

export interface BotConfig {
  network: Network;
  rpcEndpoints: RpcEndpoint[];

  crankKeypair: Keypair;
  crankKeypairPath: string;

  ydProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  dexProgramId: PublicKey;
  otProgramId: PublicKey;

  proofSource: ProofSource;

  otProjects: PublicKey[];
  otRwtPools: PublicKey[];

  arlOtMint: PublicKey;
  rwtMint: PublicKey;

  claimIntervalSecs: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;

  lockDir: string;
  dbPath: string;
  logLevel: LogLevel;
}

function loadKeypair(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`crank keypair file not found at ${path}`);
  }
  const raw = JSON.parse(fs.readFileSync(path, 'utf-8')) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every(b => typeof b === 'number')) {
    throw new Error(`crank keypair file at ${path} must be a 64-element JSON array of bytes`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

function pubkeyOrThrow(s: string, name: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`${name}: invalid pubkey "${s}"`);
  }
}

/**
 * Parse the `RPC_URLS` env var into a list of {@link RpcEndpoint}s.
 *
 * Format: comma-separated tuples of `<httpUrl>|<wsUrl>|<weight>`. The WS URL
 * and weight are optional. Mirrors the helper in nexus-manager/src/config.ts
 * to keep cranks environment-compatible.
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

export function loadConfig(): BotConfig {
  const raw = EnvSchema.parse(process.env);

  const otProjects = raw.OT_PROJECTS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => pubkeyOrThrow(s, 'OT_PROJECTS'));
  const otRwtPools = raw.OT_RWT_POOLS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => pubkeyOrThrow(s, 'OT_RWT_POOLS'));

  let proofSource: ProofSource;
  if (raw.PROOF_DIR && raw.PROOF_DIR.length > 0) {
    proofSource = { kind: 'fs', baseDir: raw.PROOF_DIR };
  } else if (raw.PROOF_BASE_URL && raw.PROOF_BASE_URL.length > 0) {
    proofSource = { kind: 'http', baseUrl: raw.PROOF_BASE_URL };
  } else {
    throw new Error('one of PROOF_DIR or PROOF_BASE_URL must be set');
  }

  const rpcEndpoints = parseRpcEndpoints(raw.RPC_URLS);

  return {
    network: raw.NETWORK,
    rpcEndpoints,

    crankKeypair: loadKeypair(raw.YIELD_CLAIM_CRANK_KEYPAIR_PATH),
    crankKeypairPath: raw.YIELD_CLAIM_CRANK_KEYPAIR_PATH,

    ydProgramId: pubkeyOrThrow(raw.YD_PROGRAM_ID, 'YD_PROGRAM_ID'),
    rwtEngineProgramId: pubkeyOrThrow(raw.RWT_ENGINE_PROGRAM_ID, 'RWT_ENGINE_PROGRAM_ID'),
    dexProgramId: pubkeyOrThrow(raw.DEX_PROGRAM_ID, 'DEX_PROGRAM_ID'),
    otProgramId: pubkeyOrThrow(raw.OT_PROGRAM_ID, 'OT_PROGRAM_ID'),

    proofSource,

    otProjects,
    otRwtPools,

    arlOtMint: pubkeyOrThrow(raw.ARL_OT_MINT, 'ARL_OT_MINT'),
    rwtMint: pubkeyOrThrow(raw.RWT_MINT, 'RWT_MINT'),

    claimIntervalSecs: raw.CLAIM_INTERVAL_SECS,
    computeUnitLimit: raw.COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: raw.COMPUTE_UNIT_PRICE_MICROLAMPORTS,

    lockDir: raw.LOCK_DIR,
    dbPath: raw.DB_PATH,
    logLevel: raw.LOG_LEVEL,
  };
}
