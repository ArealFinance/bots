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

  REVENUE_CRANK_KEYPAIR_PATH: z.string().min(1),

  OT_PROGRAM_ID: z.string().min(32),
  OT_PROJECTS: z.string().default(''),

  LOCK_DIR: z.string().default('./data/locks'),
  DB_PATH: z.string().default('./data/checkpoint.db'),
  CHECK_INTERVAL_SECS: z.coerce.number().int().positive().default(3600),

  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Network = z.infer<typeof NetworkSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface BotConfig {
  network: Network;
  rpcEndpoints: RpcEndpoint[];

  crankKeypair: Keypair;
  crankKeypairPath: string;

  otProgramId: PublicKey;
  otProjects: PublicKey[];

  lockDir: string;
  dbPath: string;
  checkIntervalSecs: number;

  logLevel: LogLevel;
}

/**
 * Read a Solana keypair JSON file (`Uint8Array` of 64 bytes encoded as a JSON
 * array — the standard `solana-keygen new -o file.json` output).
 *
 * Throws if the file is missing or malformed. Layer 8 only supports the local
 * file driver; KMS driver is deferred to mainnet (R3/R6).
 */
function loadKeypairFromFile(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`crank keypair file not found at ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `crank keypair file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every(b => typeof b === 'number')) {
    throw new Error(
      `crank keypair file at ${path} must be a 64-element JSON array of bytes (solana-keygen format)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

export function loadConfig(): BotConfig {
  const raw = EnvSchema.parse(process.env);

  const otProjects = raw.OT_PROJECTS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => {
      try {
        return new PublicKey(s);
      } catch {
        throw new Error(`OT_PROJECTS: invalid pubkey "${s}"`);
      }
    });

  const otProgramId = (() => {
    try {
      return new PublicKey(raw.OT_PROGRAM_ID);
    } catch {
      throw new Error(`OT_PROGRAM_ID: invalid pubkey "${raw.OT_PROGRAM_ID}"`);
    }
  })();

  const crankKeypair = loadKeypairFromFile(raw.REVENUE_CRANK_KEYPAIR_PATH);

  const rpcEndpoints = parseRpcEndpoints(raw.RPC_URLS);

  return {
    network: raw.NETWORK,
    rpcEndpoints,

    crankKeypair,
    crankKeypairPath: raw.REVENUE_CRANK_KEYPAIR_PATH,

    otProgramId,
    otProjects,

    lockDir: raw.LOCK_DIR,
    dbPath: raw.DB_PATH,
    checkIntervalSecs: raw.CHECK_INTERVAL_SECS,

    logLevel: raw.LOG_LEVEL,
  };
}
