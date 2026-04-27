import 'dotenv/config';
import * as fs from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import { parseRpcEndpoints } from '@areal/bots-shared';
import type { RpcEndpoint } from '@areal/bots-shared';

export { parseRpcEndpoints };

const NetworkSchema = z.enum(['devnet', 'mainnet']);
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const EnvSchema = z.object({
  NETWORK: NetworkSchema.default('devnet'),
  /** Pipe-separated RPC tuple list: `<http>|<ws>|<weight>`, comma-separated. */
  RPC_URLS: z
    .string()
    .min(1)
    .default('https://api.devnet.solana.com|wss://api.devnet.solana.com|100'),

  CONVERT_FUND_CRANK_KEYPAIR_PATH: z.string().min(1),

  YD_PROGRAM_ID: z.string().min(32),
  DEX_PROGRAM_ID: z.string().min(32),
  RWT_ENGINE_PROGRAM_ID: z.string().min(32),
  OT_PROGRAM_ID: z.string().min(32).default('oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL'),

  USDC_MINT: z.string().min(32),
  RWT_MINT: z.string().min(32),
  RWT_USDC_POOL: z.string().min(32),

  OT_PROJECTS: z.string().default(''),

  COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().default(300_000),
  COMPUTE_UNIT_PRICE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(10_000),

  SLIPPAGE_BPS: z.coerce
    .bigint()
    .default(100n)
    // Sec M-1 — bound the slippage tolerance. >50% would routinely produce
    // min_rwt_out=0 and surface sandwich attacks; the route-recheck guard
    // works in concert with this cap.
    .refine((v) => v >= 0n && v <= 5000n, {
      message: 'SLIPPAGE_BPS must be in [0, 5000] (≤50%)',
    }),
  MIN_CONVERT_USDC: z.coerce.bigint().default(1_000_000n),

  LOCK_DIR: z.string().default('./data/locks'),
  DB_PATH: z.string().default('./data/checkpoint.db'),
  CHECK_INTERVAL_SECS: z.coerce.number().int().positive().default(300),

  /**
   * If `true`, the crank submits the on-chain TX. When `false` (default), the
   * crank stops at the decision step and emits a structured `decision` log
   * line. Used by Substep 12 bootstrap (decision-only) and Substep 13 E2E
   * (live submit).
   */
  SEND_TX: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Network = z.infer<typeof NetworkSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface BotConfig {
  network: Network;
  rpcEndpoints: RpcEndpoint[];

  crankKeypair: Keypair;
  crankKeypairPath: string;

  ydProgramId: PublicKey;
  dexProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  otProgramId: PublicKey;

  usdcMint: PublicKey;
  rwtMint: PublicKey;
  rwtUsdcPool: PublicKey;

  otProjects: PublicKey[];

  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  slippageBps: bigint;
  minConvertUsdc: bigint;

  lockDir: string;
  dbPath: string;
  checkIntervalSecs: number;

  sendTx: boolean;

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

export function loadConfig(): BotConfig {
  const raw = EnvSchema.parse(process.env);

  const otProjects = raw.OT_PROJECTS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => pubkeyOrThrow(s, 'OT_PROJECTS'));

  const rpcEndpoints = parseRpcEndpoints(raw.RPC_URLS);

  return {
    network: raw.NETWORK,
    rpcEndpoints,

    crankKeypair: loadKeypair(raw.CONVERT_FUND_CRANK_KEYPAIR_PATH),
    crankKeypairPath: raw.CONVERT_FUND_CRANK_KEYPAIR_PATH,

    ydProgramId: pubkeyOrThrow(raw.YD_PROGRAM_ID, 'YD_PROGRAM_ID'),
    dexProgramId: pubkeyOrThrow(raw.DEX_PROGRAM_ID, 'DEX_PROGRAM_ID'),
    rwtEngineProgramId: pubkeyOrThrow(raw.RWT_ENGINE_PROGRAM_ID, 'RWT_ENGINE_PROGRAM_ID'),
    otProgramId: pubkeyOrThrow(raw.OT_PROGRAM_ID, 'OT_PROGRAM_ID'),

    usdcMint: pubkeyOrThrow(raw.USDC_MINT, 'USDC_MINT'),
    rwtMint: pubkeyOrThrow(raw.RWT_MINT, 'RWT_MINT'),
    rwtUsdcPool: pubkeyOrThrow(raw.RWT_USDC_POOL, 'RWT_USDC_POOL'),

    otProjects,

    computeUnitLimit: raw.COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: raw.COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    slippageBps: raw.SLIPPAGE_BPS,
    minConvertUsdc: raw.MIN_CONVERT_USDC,

    lockDir: raw.LOCK_DIR,
    dbPath: raw.DB_PATH,
    checkIntervalSecs: raw.CHECK_INTERVAL_SECS,

    sendTx: raw.SEND_TX,

    logLevel: raw.LOG_LEVEL,
  };
}
