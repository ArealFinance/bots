/**
 * Phase 22: chain-invariants exporter — entrypoint.
 *
 * Boot sequence:
 *   1. Load + eagerly validate every required env var (PDAs and the 5
 *      EXPECTED_AUTHORITY_* pubkeys). Any missing/malformed value
 *      throws with a descriptive message — fail fast on misconfig.
 *   2. Build the metrics + HTTP server (binds 127.0.0.1:9201 by default).
 *   3. Run a FIRST POLL synchronously before the interval starts —
 *      Architect requirement so a fresh exporter does NOT lie green for
 *      the first poll cycle.
 *   4. Schedule pollOnce() at config.pollIntervalMs cadence.
 *   5. SIGINT/SIGTERM → clearInterval, close server, exit 0.
 *
 * The bot is read-only — no keypair, no signing. start-bots.ts spawns
 * it via a `BotSpec.readOnly: true` flag.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger, redactUrl } from '@areal/bots-shared';
import { createMetricsServer, type ChainInvariantsMetrics } from './metrics.js';
import { createBadgesHandler, DEFAULT_THRESHOLDS } from './badges.js';
import {
  checkMerkleRootAge,
  checkNavAge,
  checkAuthorities,
  checkRwtSupply,
  CONTRACT_NAMES,
  type CheckContext,
  type CheckOutcome,
  type ContractName,
  type MerkleRootAgeResult,
  type NavAgeResult,
  type AuthorityCheckResult,
  type RwtSupplyResult,
} from './checks.js';

// ---- Config ---------------------------------------------------------------

interface Config {
  rpcUrl: string;
  metricsPort: number;
  pollIntervalMs: number;
  // PDAs
  ydMerkleDistributor: PublicKey;
  ydDistributionConfig: PublicKey;
  rwtVault: PublicKey;
  otGovernance: PublicKey;
  futarchyConfig: PublicKey;
  dexConfig: PublicKey;
  // Expected authorities (Q5: one env per contract)
  expectedAuthorities: Record<ContractName, PublicKey>;
}

function getEnv(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new Error(`chain-invariants: required env var ${name} is missing`);
  }
  return v;
}

function getEnvPubkey(name: string, env: NodeJS.ProcessEnv): PublicKey {
  const v = getEnv(name, env);
  try {
    return new PublicKey(v);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`chain-invariants: env ${name}="${v}" is not a valid pubkey (${msg})`);
  }
}

function getEnvInt(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < range.min || n > range.max) {
    throw new Error(
      `chain-invariants: env ${name}="${raw}" must be an integer in [${range.min}, ${range.max}]`,
    );
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = getEnv('RPC_URL', env);
  const metricsPort = getEnvInt('BOT_METRICS_PORT', env, 9201, { min: 1, max: 65_535 });
  const pollIntervalMs = getEnvInt(
    'CHAIN_INVARIANTS_POLL_INTERVAL_MS',
    env,
    60_000,
    { min: 5_000, max: 24 * 60 * 60 * 1000 },
  );

  const expectedAuthorities: Record<ContractName, PublicKey> = {
    ot_governance: getEnvPubkey('EXPECTED_AUTHORITY_OT_GOVERNANCE', env),
    futarchy_config: getEnvPubkey('EXPECTED_AUTHORITY_FUTARCHY_CONFIG', env),
    rwt_vault: getEnvPubkey('EXPECTED_AUTHORITY_RWT_VAULT', env),
    dex_config: getEnvPubkey('EXPECTED_AUTHORITY_DEX_CONFIG', env),
    yd_distribution_config: getEnvPubkey('EXPECTED_AUTHORITY_YD_DISTRIBUTION_CONFIG', env),
  };

  return {
    rpcUrl,
    metricsPort,
    pollIntervalMs,
    ydMerkleDistributor: getEnvPubkey('PDA_YD_MERKLE_DISTRIBUTOR', env),
    ydDistributionConfig: getEnvPubkey('PDA_YD_DISTRIBUTION_CONFIG', env),
    rwtVault: getEnvPubkey('PDA_RWT_VAULT', env),
    otGovernance: getEnvPubkey('PDA_OT_GOVERNANCE', env),
    futarchyConfig: getEnvPubkey('PDA_FUTARCHY_CONFIG', env),
    dexConfig: getEnvPubkey('PDA_DEX_CONFIG', env),
    expectedAuthorities,
  };
}

// ---- Metric application ---------------------------------------------------

type CheckName = 'merkle_root_age' | 'nav_age' | 'authority_match' | 'rwt_supply';

interface TimedResult<T> {
  result: CheckOutcome<T>;
  durationSec: number;
}

async function timed<T>(fn: () => Promise<CheckOutcome<T>>): Promise<TimedResult<T>> {
  const t0 = Date.now();
  const result = await fn();
  const durationSec = (Date.now() - t0) / 1000;
  return { result, durationSec };
}

function recordCheckOutcome(
  metrics: ChainInvariantsMetrics,
  check: CheckName,
  outcome: CheckOutcome<unknown>,
  durationSec: number,
  nowSec: number,
): void {
  metrics.checkDurationSeconds.set({ check }, durationSec);
  if (outcome.ok) {
    metrics.checkLastSuccessTimestamp.set({ check }, nowSec);
  } else {
    metrics.checkErrorsTotal.inc({ check });
    logger.warn('check_failed', { check, error: outcome.error });
  }
}

function applyMerkleResult(
  metrics: ChainInvariantsMetrics,
  outcome: CheckOutcome<MerkleRootAgeResult>,
): void {
  if (!outcome.ok) return;
  metrics.merkleRootAgeSeconds.set(
    { distributor: outcome.value.distributorPubkey },
    outcome.value.ageSeconds,
  );
}

function applyNavResult(
  metrics: ChainInvariantsMetrics,
  outcome: CheckOutcome<NavAgeResult>,
): void {
  if (!outcome.ok) return;
  metrics.navAgeSeconds.set(
    { rwt_engine: outcome.value.vaultPubkey },
    outcome.value.ageSeconds,
  );
}

function applyAuthorityResult(
  metrics: ChainInvariantsMetrics,
  outcome: CheckOutcome<AuthorityCheckResult[]>,
  expected: Record<ContractName, PublicKey>,
): void {
  // Always emit a value for every contract: 1 (match), 0 (drift), or -1 (unknown).
  if (!outcome.ok) {
    // Top-level failure — mark all 5 contracts unknown so the metric does
    // not silently freeze on the previous value.
    for (const c of CONTRACT_NAMES) {
      metrics.authorityMatch.set(
        { contract: c, authority: expected[c].toBase58() },
        -1,
      );
    }
    return;
  }
  for (const r of outcome.value) {
    let value: number;
    if (r.actual.startsWith('<fetch_error') || r.actual === '<account_missing>') {
      value = -1;
    } else if (r.match) {
      value = 1;
    } else {
      value = 0;
    }
    // The authority label carries the EXPECTED pubkey (operator-supplied,
    // bounded cardinality of 5). NOT the on-chain "actual" — including
    // drifted values would explode cardinality on a sustained attack.
    metrics.authorityMatch.set(
      { contract: r.contract, authority: r.expected },
      value,
    );
  }
}

function applySupplyResult(
  metrics: ChainInvariantsMetrics,
  outcome: CheckOutcome<RwtSupplyResult>,
): void {
  if (!outcome.ok) return;
  // bigint → number coercion: clamp to Number.MAX_SAFE_INTEGER on overflow
  // so the gauge does not silently underflow on absurd values. Real
  // RWT supplies are well within u53.
  const tracked = bigintToSafe(outcome.value.trackedSupply);
  const mintActual = bigintToSafe(outcome.value.mintActualSupply);
  const drift = bigintToSafe(outcome.value.drift);
  metrics.rwtSupplyTracked.set({ rwt_engine: outcome.value.vaultPubkey }, tracked);
  metrics.rwtSupplyMintActual.set({ rwt_engine: outcome.value.vaultPubkey }, mintActual);
  metrics.rwtSupplyDriftAbs.set({ rwt_engine: outcome.value.vaultPubkey }, drift);
}

function bigintToSafe(b: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (b > max) return Number.MAX_SAFE_INTEGER;
  if (b < -max) return -Number.MAX_SAFE_INTEGER;
  return Number(b);
}

// ---- Poll loop ------------------------------------------------------------

async function pollOnce(
  ctx: CheckContext,
  config: Config,
  metrics: ChainInvariantsMetrics,
): Promise<void> {
  metrics.exporterPollsTotal.inc();

  const [merkle, nav, auth, supply] = await Promise.all([
    timed(() => checkMerkleRootAge(ctx, { distributorPda: config.ydMerkleDistributor })),
    timed(() => checkNavAge(ctx, { rwtVaultPda: config.rwtVault })),
    timed(() =>
      checkAuthorities(ctx, {
        otGovernancePda: config.otGovernance,
        futarchyConfigPda: config.futarchyConfig,
        rwtVaultPda: config.rwtVault,
        dexConfigPda: config.dexConfig,
        ydDistributionConfigPda: config.ydDistributionConfig,
        expected: config.expectedAuthorities,
      }),
    ),
    timed(() => checkRwtSupply(ctx, { rwtVaultPda: config.rwtVault })),
  ]);

  const nowSec = ctx.nowSec();

  recordCheckOutcome(metrics, 'merkle_root_age', merkle.result, merkle.durationSec, nowSec);
  applyMerkleResult(metrics, merkle.result);

  recordCheckOutcome(metrics, 'nav_age', nav.result, nav.durationSec, nowSec);
  applyNavResult(metrics, nav.result);

  recordCheckOutcome(metrics, 'authority_match', auth.result, auth.durationSec, nowSec);
  applyAuthorityResult(metrics, auth.result, config.expectedAuthorities);

  recordCheckOutcome(metrics, 'rwt_supply', supply.result, supply.durationSec, nowSec);
  applySupplyResult(metrics, supply.result);

  metrics.exporterAlive.set(1);
}

// ---- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info('config_loaded', {
    rpc: redactUrl(config.rpcUrl),
    port: config.metricsPort,
    interval_ms: config.pollIntervalMs,
  });

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const ctx: CheckContext = {
    connection,
    nowSec: () => Math.floor(Date.now() / 1000),
  };

  // Build server first (it returns the ChainInvariantsMetrics handle that
  // the badges handler closes over).
  // We forward-construct the badges handler with a placeholder context whose
  // metrics field is filled after createMetricsServer returns. Cleaner than
  // splitting createMetricsServer into createMetrics + listen-server.
  let metricsRef: ChainInvariantsMetrics | null = null;
  const handle = await createMetricsServer({
    port: config.metricsPort,
    host: '127.0.0.1',
    logger,
    badgesHandler: async (req, res) => {
      if (!metricsRef) {
        res.writeHead(503);
        res.end();
        return;
      }
      const handler = createBadgesHandler({
        metrics: metricsRef,
        thresholds: DEFAULT_THRESHOLDS,
      });
      await handler(req, res);
    },
  });
  metricsRef = handle.metrics;

  // First poll on startup — Architect requirement. Wrap in a 30s timeout
  // (R-22-6) so a slow RPC does not block the systemd start gate
  // indefinitely. On timeout we proceed to the interval anyway.
  logger.info('first_poll_starting');
  try {
    await Promise.race([
      pollOnce(ctx, config, handle.metrics),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('first_poll_timeout_30s')), 30_000),
      ),
    ]);
    logger.info('first_poll_complete');
  } catch (err) {
    logger.error('first_poll_failed', err);
    // Do NOT exit — interval will retry. Meta-alert
    // ChainInvariantsCheckFailing fires after 5m if the poll never
    // succeeds.
  }

  let shuttingDown = false;
  const intervalHandle: NodeJS.Timeout = setInterval(() => {
    if (shuttingDown) return;
    pollOnce(ctx, config, handle.metrics).catch((err) =>
      logger.error('poll_failed', err),
    );
  }, config.pollIntervalMs);

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_starting', { signal });
    clearInterval(intervalHandle);
    try {
      await handle.close();
    } catch (err) {
      logger.error('shutdown_close_failed', err);
    }
    logger.info('shutdown_complete');
    // Force-exit so any leftover sockets do not keep the process alive.
    process.exit(0);
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.info('chain_invariants_running');
}

main().catch((err) => {
  logger.error('fatal', err);
  process.exit(1);
});
