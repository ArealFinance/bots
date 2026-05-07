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
import {
  findDexConfigPda,
  findRwtVaultPda,
  findYdConfigPda,
  findOtGovernancePda,
  findFutarchyConfigPda,
  findMerkleDistributorPda,
  NATIVE_DEX_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
} from '@areal/sdk';
import { createMetricsServer, type ChainInvariantsMetrics } from './metrics.js';
import { createBadgesHandler, DEFAULT_THRESHOLDS } from './badges.js';
import {
  checkMerkleRootAge,
  checkNavAge,
  checkAuthorities,
  checkRwtSupply,
  CONTRACT_NAMES,
  authorityOutcomeToMetricValue,
  type CheckContext,
  type CheckOutcome,
  type ContractName,
  type MerkleRootAgeResult,
  type NavAgeResult,
  type AuthorityCheckResult,
  type RwtSupplyResult,
} from './checks.js';

// ---- Config ---------------------------------------------------------------

export interface Config {
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
  /**
   * I1 — optional OT mint. When set, the startup self-derivation check
   * also validates the per-OT PDAs (ot_governance, futarchy_config,
   * yd_merkle_distributor). When unset, those PDAs are trusted to the
   * operator (a warning is logged once at startup so the gap is
   * visible in audit). The 3 singleton PDAs (dex_config, rwt_vault,
   * yd_distribution_config) are always self-derived and validated
   * regardless of OT_MINT.
   */
  otMint?: PublicKey;
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

function getOptionalEnvPubkey(
  name: string,
  env: NodeJS.ProcessEnv,
): PublicKey | undefined {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
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
    otMint: getOptionalEnvPubkey('OT_MINT', env),
  };
}

// ---- I1: PDA self-derivation startup check --------------------------------

/**
 * One PDA whose env-supplied address did not match what the SDK helper
 * derives from the canonical seeds.
 */
export interface PdaMismatch {
  /** Env var name the operator set, e.g. `PDA_DEX_CONFIG`. */
  envVar: string;
  /** What the operator put in that env var. */
  envValue: string;
  /** What the SDK's deriver returned (canonical truth). */
  derived: string;
  /** SDK helper used (for the error log). */
  helper: string;
}

/**
 * I1 — startup self-derivation check.
 *
 * Operator-supplied PDA env vars (`PDA_*`) are trusted today; a typo or
 * a stale .env that points at the wrong cluster's PDA would silently
 * make the exporter watch the wrong account. Re-derive each PDA via the
 * SDK helpers using the canonical program IDs and assert equality.
 *
 * Three singletons are always validated:
 *   - PDA_DEX_CONFIG               ← findDexConfigPda(NATIVE_DEX_PROGRAM_ID)
 *   - PDA_RWT_VAULT                ← findRwtVaultPda(RWT_ENGINE_PROGRAM_ID)
 *   - PDA_YD_DISTRIBUTION_CONFIG   ← findYdConfigPda(YIELD_DISTRIBUTION_PROGRAM_ID)
 *
 * Three per-OT PDAs are validated only when `OT_MINT` is supplied, since
 * an operator might genuinely need to override these (e.g., monitoring a
 * second OT mint for testing). Skipping them is logged loudly:
 *   - PDA_OT_GOVERNANCE           ← findOtGovernancePda(otMint, OWNERSHIP_TOKEN_PROGRAM_ID)
 *   - PDA_FUTARCHY_CONFIG         ← findFutarchyConfigPda(otMint, FUTARCHY_PROGRAM_ID)
 *   - PDA_YD_MERKLE_DISTRIBUTOR   ← findMerkleDistributorPda(otMint, YIELD_DISTRIBUTION_PROGRAM_ID)
 *
 * Pure function — does no I/O — so it's trivially testable.
 *
 * @returns array of mismatches; empty array means everything checked is
 * canonical. Caller decides what to do (main() exits non-zero).
 */
export function verifyPdaDerivation(config: Config): PdaMismatch[] {
  const mismatches: PdaMismatch[] = [];

  // Always-validated singletons.
  const checkSingleton = (
    envVar: string,
    helper: string,
    actual: PublicKey,
    derived: PublicKey,
  ): void => {
    if (!actual.equals(derived)) {
      mismatches.push({
        envVar,
        envValue: actual.toBase58(),
        derived: derived.toBase58(),
        helper,
      });
    }
  };

  checkSingleton(
    'PDA_DEX_CONFIG',
    'findDexConfigPda(NATIVE_DEX_PROGRAM_ID)',
    config.dexConfig,
    findDexConfigPda(NATIVE_DEX_PROGRAM_ID)[0],
  );
  checkSingleton(
    'PDA_RWT_VAULT',
    'findRwtVaultPda(RWT_ENGINE_PROGRAM_ID)',
    config.rwtVault,
    findRwtVaultPda(RWT_ENGINE_PROGRAM_ID)[0],
  );
  checkSingleton(
    'PDA_YD_DISTRIBUTION_CONFIG',
    'findYdConfigPda(YIELD_DISTRIBUTION_PROGRAM_ID)',
    config.ydDistributionConfig,
    findYdConfigPda(YIELD_DISTRIBUTION_PROGRAM_ID)[0],
  );

  // Per-OT PDAs — only when OT_MINT is supplied.
  if (config.otMint) {
    checkSingleton(
      'PDA_OT_GOVERNANCE',
      'findOtGovernancePda(OT_MINT, OWNERSHIP_TOKEN_PROGRAM_ID)',
      config.otGovernance,
      findOtGovernancePda(config.otMint, OWNERSHIP_TOKEN_PROGRAM_ID)[0],
    );
    checkSingleton(
      'PDA_FUTARCHY_CONFIG',
      'findFutarchyConfigPda(OT_MINT, FUTARCHY_PROGRAM_ID)',
      config.futarchyConfig,
      findFutarchyConfigPda(config.otMint, FUTARCHY_PROGRAM_ID)[0],
    );
    checkSingleton(
      'PDA_YD_MERKLE_DISTRIBUTOR',
      'findMerkleDistributorPda(OT_MINT, YIELD_DISTRIBUTION_PROGRAM_ID)',
      config.ydMerkleDistributor,
      findMerkleDistributorPda(config.otMint, YIELD_DISTRIBUTION_PROGRAM_ID)[0],
    );
  }

  return mismatches;
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
  // Always emit a value for every contract: 1 (match), 0 (drift class), or
  // -1 (rpc_error / top-level failure — unknown).
  if (!outcome.ok) {
    // Top-level failure: checkAuthorities never throws today (per-contract
    // errors surface inside `value`), but defend against future regression
    // by marking everything unknown.
    for (const c of CONTRACT_NAMES) {
      metrics.authorityMatch.set(
        { contract: c, authority: expected[c].toBase58() },
        -1,
      );
    }
    return;
  }
  for (const r of outcome.value) {
    // Outcome → gauge mapping is centralised in
    // `authorityOutcomeToMetricValue` so the alert contract stays in lock
    // step with the check semantics:
    //   - `chain_invariant_authority_match == 0` fires on
    //     drift | decode_error | account_not_found | wrong_owner
    //   - `chain_invariant_authority_match == -1` is the explicit
    //     "transient infra blip" state and MUST NOT fire AuthorityDrift
    const value = authorityOutcomeToMetricValue(r.outcome);
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
    ot_mint_pinned: config.otMint ? config.otMint.toBase58() : null,
  });

  // I1 — verify operator-supplied PDAs match SDK self-derivation BEFORE the
  // HTTP server starts (and BEFORE any RPC). A mismatch is a misconfiguration
  // that would silently watch the wrong account; fail-fast with a clear log.
  const mismatches = verifyPdaDerivation(config);
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      logger.error('pda_self_derivation_mismatch', undefined, {
        env_var: m.envVar,
        env_value: m.envValue,
        derived: m.derived,
        helper: m.helper,
      });
    }
    throw new Error(
      `chain-invariants: ${mismatches.length} PDA env var(s) do not match SDK self-derivation — refusing to start`,
    );
  }
  if (!config.otMint) {
    // Loud, but recoverable: per-OT PDAs are not validated. Fine for v1
    // (the operator owns those env vars), but the gap is visible in audit.
    logger.warn('pda_self_derivation_partial', {
      reason: 'OT_MINT not set',
      skipped_pdas: [
        'PDA_OT_GOVERNANCE',
        'PDA_FUTARCHY_CONFIG',
        'PDA_YD_MERKLE_DISTRIBUTOR',
      ],
    });
  } else {
    logger.info('pda_self_derivation_ok', { ot_mint: config.otMint.toBase58() });
  }

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

// Gate the auto-bootstrap so importing this module from a test (to call
// `verifyPdaDerivation` or `loadConfig` in isolation) does NOT spin up
// the HTTP server or attempt to load the operator's env. We only run
// main() when this file IS the process entrypoint.
//
// `import.meta.url` is a `file://` URL; `process.argv[1]` is a plain
// path. Convert to URL and compare.
const isEntrypoint = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url === new URL(`file://${argv1}`).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    logger.error('fatal', err);
    process.exit(1);
  });
}
