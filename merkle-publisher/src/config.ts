import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

/**
 * Environment schema — fail-fast on startup if misconfigured.
 * Pubkey strings are validated lazily (parsed via new PublicKey).
 */
const NetworkSchema = z.enum(['devnet', 'mainnet']);
const KmsProviderSchema = z.enum(['local', 'aws', 'gcp']);
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const EnvSchema = z.object({
  NETWORK: NetworkSchema.default('devnet'),
  RPC_URL: z.string().url().default('http://127.0.0.1:8899'),
  RPC_WS_URL: z.string().default('ws://127.0.0.1:8900'),
  ARCHIVAL_RPC_URL: z.string().url().default('http://127.0.0.1:8899'),
  /** Optional second archival RPC for cross-verification (H-3). */
  ARCHIVAL_RPC_URL_2: z.string().url().optional(),

  YD_PROGRAM_ID: z.string().min(32),
  OT_PROGRAM_ID: z.string().min(32),
  DEX_PROGRAM_ID: z.string().min(32).optional(),

  MIN_HOLDING_OT_LAMPORTS: z.coerce.bigint().default(100_000_000n),
  ARL_OT_TREASURY: z.string().min(32),

  PUBLISHER_PUBKEY: z.string().min(32),

  PUBLISH_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),

  KMS_PROVIDER: KmsProviderSchema.default('local'),
  KMS_KEY_ID: z.string().default('./local-mock-keypair.json'),
  AWS_REGION: z.string().default('us-east-1'),

  /**
   * Comma-separated base58 pubkeys excluded from snapshot eligibility (L-5).
   * Examples: RWT vault PDA, DEX pool PDAs, protocol treasuries that should
   * not receive yield allocations (they cannot claim anyway).
   */
  EXCLUDED_HOLDERS: z.string().default(''),

  DB_PATH: z.string().default('./data/merkle-publisher.db'),
  PROOF_DIR: z.string().default('./data/proofs'),

  /**
   * NEW-M-2: how far back to scan on cold start (no snapshots in DB).
   * Default ≈ 2 days at 400 ms/slot (2 × 24 × 3600 / 0.4 = 432 000 slots) —
   * plenty for first-deploy scenarios where the bot is started AFTER the
   * initial fund_distributor event landed on-chain.
   */
  COLD_START_LOOKBACK_SLOTS: z.coerce.bigint().default(432_000n),

  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Network = z.infer<typeof NetworkSchema>;
export type KmsProvider = z.infer<typeof KmsProviderSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface BotConfig {
  network: Network;
  rpcUrl: string;
  rpcWsUrl: string;
  archivalRpcUrl: string;
  archivalRpcUrl2: string | null;

  ydProgramId: PublicKey;
  otProgramId: PublicKey;
  dexProgramId: PublicKey | null;

  minHoldingOtLamports: bigint;
  arlOtTreasury: PublicKey;

  publisherPubkey: PublicKey;

  publishIntervalMs: number;

  kmsProvider: KmsProvider;
  kmsKeyId: string;
  awsRegion: string;

  excludedHolders: string[];

  dbPath: string;
  proofDir: string;

  /** NEW-M-2: slot lookback for cold-start reconcile (empty DB). */
  coldStartLookbackSlots: bigint;

  logLevel: LogLevel;
}

export function loadConfig(): BotConfig {
  const raw = EnvSchema.parse(process.env);

  const excludedHolders = raw.EXCLUDED_HOLDERS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  // Validate each as a pubkey up front (fail-fast on bad config).
  for (const h of excludedHolders) {
    try {
      // Throws if invalid base58 or wrong length.
      // eslint-disable-next-line no-new
      new PublicKey(h);
    } catch {
      throw new Error(`EXCLUDED_HOLDERS: invalid pubkey "${h}"`);
    }
  }

  const cfg: BotConfig = {
    network: raw.NETWORK,
    rpcUrl: raw.RPC_URL,
    rpcWsUrl: raw.RPC_WS_URL,
    archivalRpcUrl: raw.ARCHIVAL_RPC_URL,
    archivalRpcUrl2: raw.ARCHIVAL_RPC_URL_2 ?? null,

    ydProgramId: new PublicKey(raw.YD_PROGRAM_ID),
    otProgramId: new PublicKey(raw.OT_PROGRAM_ID),
    dexProgramId: raw.DEX_PROGRAM_ID ? new PublicKey(raw.DEX_PROGRAM_ID) : null,

    minHoldingOtLamports: raw.MIN_HOLDING_OT_LAMPORTS,
    arlOtTreasury: new PublicKey(raw.ARL_OT_TREASURY),

    publisherPubkey: new PublicKey(raw.PUBLISHER_PUBKEY),

    publishIntervalMs: raw.PUBLISH_INTERVAL_MS,

    kmsProvider: raw.KMS_PROVIDER,
    kmsKeyId: raw.KMS_KEY_ID,
    awsRegion: raw.AWS_REGION,

    excludedHolders,

    dbPath: raw.DB_PATH,
    proofDir: raw.PROOF_DIR,

    coldStartLookbackSlots: raw.COLD_START_LOOKBACK_SLOTS,

    logLevel: raw.LOG_LEVEL,
  };

  // Startup invariant: local-mock signer is forbidden on mainnet.
  if (cfg.network === 'mainnet' && cfg.kmsProvider === 'local') {
    throw new Error(
      'Refusing to start: KMS_PROVIDER=local is forbidden on NETWORK=mainnet. ' +
        'Use aws or gcp KMS provider for mainnet.',
    );
  }

  // NEW-L-1: if both archival URLs are identical, the cross-check in
  // snapshot-taker.ts::assertHoldersAgree compares a value to itself and
  // always passes. Refuse the footgun at load time.
  if (cfg.archivalRpcUrl2 && cfg.archivalRpcUrl2 === cfg.archivalRpcUrl) {
    throw new Error(
      'Refusing to start: ARCHIVAL_RPC_URL_2 must differ from ARCHIVAL_RPC_URL ' +
        '(otherwise the dual-RPC cross-verification is illusory).',
    );
  }

  return cfg;
}
