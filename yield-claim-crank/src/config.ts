import 'dotenv/config';
import * as fs from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import { parseRpcEndpoints } from '@areal/bots-shared';
import type { RpcEndpoint } from '@areal/bots-shared';

export { parseRpcEndpoints };

const NetworkSchema = z.enum(['localnet', 'devnet', 'mainnet']);
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

  SPRK_OT_MINT: z.string().min(32),
  RWT_MINT: z.string().min(32),

  CLAIM_INTERVAL_SECS: z.coerce.number().int().positive().default(1800),
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().default(150_000),
  COMPUTE_UNIT_PRICE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(10_000),

  LOCK_DIR: z.string().default('./data/locks'),
  DB_PATH: z.string().default('./data/checkpoint.db'),

  /**
   * If `true`, the crank submits the on-chain TX. When `false` (default), the
   * crank stops at the decision step and logs only.
   */
  SEND_TX: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Opt-in: when `true` AND `SEND_TX=true`, the crank issues
   * `YD::withdraw_liquidity_holding` once per RWT distribution epoch. Disabled
   * by default until R20 lands (RWT_MINT pin migration). See `crank.ts`
   * `processLiquidityHoldingDrain`.
   */
  YIELD_CLAIM_ENABLE_LH_DRAIN: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Opt-in: when `true` AND `SEND_TX=true`, the crank performs a Nexus USDC
   * deposit per OT revenue cycle (DEX `nexus_deposit`). Disabled by default
   * until LiquidityNexus is provisioned end-to-end.
   */
  YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

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

  sprkOtMint: PublicKey;
  rwtMint: PublicKey;

  claimIntervalSecs: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;

  lockDir: string;
  dbPath: string;

  sendTx: boolean;
  enableLhDrain: boolean;
  enableNexusDeposit: boolean;

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

    sprkOtMint: pubkeyOrThrow(raw.SPRK_OT_MINT, 'SPRK_OT_MINT'),
    rwtMint: pubkeyOrThrow(raw.RWT_MINT, 'RWT_MINT'),

    claimIntervalSecs: raw.CLAIM_INTERVAL_SECS,
    computeUnitLimit: raw.COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: raw.COMPUTE_UNIT_PRICE_MICROLAMPORTS,

    lockDir: raw.LOCK_DIR,
    dbPath: raw.DB_PATH,

    sendTx: raw.SEND_TX,
    enableLhDrain: raw.YIELD_CLAIM_ENABLE_LH_DRAIN,
    enableNexusDeposit: raw.YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT,

    logLevel: raw.LOG_LEVEL,
  };
}
