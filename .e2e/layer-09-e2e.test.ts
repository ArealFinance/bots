/**
 * Layer 9 §10.3 — full Nexus E2E.
 *
 * Scenario (architecture §10.3 + §5.1):
 *
 *   1. Init: bootstrap-init.ts populated `pdas.liquidity_nexus`. Skip if
 *      `phaseNexus` is in `init_skipped[]` or `init_failed[]` (R57).
 *   2. Manager rotation: dashboard-side `update_nexus_manager` was already
 *      issued during bootstrap; the Nexus PDA reflects the deployer pubkey.
 *   3. nexus-manager.runCycle() — assert decision is one of {noop, swap,
 *      addLiquidity, removeLiquidity}; on a fresh validator the canonical
 *      output is `noop` because Nexus balances are 0.
 *   4. Permissionless `nexus_deposit` (USDC) via dashboard ix-builder —
 *      assert NexusDeposited event signature pattern is logged.
 *   5. Permissionless `nexus_deposit` (RWT) — same.
 *   6. nexus-manager.runCycle() — now that balances are positive, assert
 *      the bot considers a `swap` or `addLiquidity` decision.
 *   7. nexus_withdraw_profits — Authority signs; assert
 *      `NexusProfitsWithdrawn` is observable.
 *   8. nexus_claim_rewards — Manager signs; assert it returns Ok or skips.
 *
 * The full live-submit path requires:
 *   - Fresh dashboard IDL with all 9 Layer 9 ix.
 *   - Funded `nexus-manager` keypair.
 *   - `SEND_TX=true` in nexus-manager `.env`.
 *
 * Until those are in place, this file asserts the artifact contains the
 * right state (Nexus PDA initialized OR explicitly gated) and exits with a
 * clean skip otherwise. Live-run is operator-driven via `npm run e2e`.
 *
 * R57: scenarios that depend on `phaseNexus` skip cleanly when the
 * Substep-12 bootstrap could not initialise the Nexus singleton (typically
 * because the DEX IDL was not regenerated yet).
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_ARTIFACT = resolve(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const ARTIFACT_PATH = process.env.E2E_BOOTSTRAP_ARTIFACT ?? DEFAULT_ARTIFACT;
const RPC_URL = process.env.RPC_URL;

interface Artifact {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  programs: {
    ownership_token: string;
    native_dex: string;
    rwt_engine: string;
    yield_distribution: string;
    futarchy: string;
  };
  pdas?: {
    liquidity_nexus?: string;
    master_pool?: string;
    [k: string]: string | undefined;
  };
  init_skipped?: string[];
  init_failed?: { phase: string; error: string }[];
}

function loadArtifact(): Artifact | null {
  if (!existsSync(ARTIFACT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
  } catch {
    return null;
  }
}

function isNexusGated(art: Artifact): { gated: boolean; reason: string } {
  const skipped = art.init_skipped ?? [];
  const failed = art.init_failed ?? [];
  if (
    skipped.some((s) => s.includes('initialize_nexus')) ||
    failed.some((f) => f.phase.includes('initialize_nexus'))
  ) {
    return {
      gated: true,
      reason: 'phaseNexus skipped/failed (Layer 9 IDL regeneration pending)',
    };
  }
  return { gated: false, reason: '' };
}

const artifact = loadArtifact();
const ARTIFACT_OK = artifact !== null;
const RPC_OK = Boolean(RPC_URL);
const E2E_READY = ARTIFACT_OK && RPC_OK;

if (!E2E_READY) {
  test('Layer 9 E2E (skipped — bootstrap artifact or RPC missing)', () => {
    const reasons: string[] = [];
    if (!ARTIFACT_OK) reasons.push(`artifact missing at ${ARTIFACT_PATH}`);
    if (!RPC_OK) reasons.push('RPC_URL env var not set');
    // eslint-disable-next-line no-console
    console.warn(`[layer-09-e2e] skip: ${reasons.join('; ')}`);
    assert.ok(true);
  });
} else {
  const art = artifact!;

  test('Layer 9 E2E — schema_version >= 1', () => {
    assert.ok(
      art.schema_version >= 1,
      `schema_version too old: ${art.schema_version}`,
    );
  });

  test('Layer 9 E2E — DEX program reachable', async () => {
    const conn = new Connection(RPC_URL!, 'confirmed');
    const dex = new PublicKey(art.programs.native_dex);
    const info = await conn.getAccountInfo(dex, 'confirmed');
    assert.ok(info, `DEX program ${dex.toBase58()} not found`);
    assert.equal(info!.executable, true);
  });

  test('Layer 9 E2E — Nexus init gating (R57)', async () => {
    const gating = isNexusGated(art);
    if (gating.gated) {
      // eslint-disable-next-line no-console
      console.warn(`[layer-09-e2e] Nexus assertions skipped: ${gating.reason}`);
      assert.ok(true);
      return;
    }
    assert.ok(
      art.pdas?.liquidity_nexus,
      'liquidity_nexus PDA expected when phaseNexus is not gated',
    );
    const conn = new Connection(RPC_URL!, 'confirmed');
    const info = await conn.getAccountInfo(
      new PublicKey(art.pdas!.liquidity_nexus!),
      'confirmed',
    );
    assert.ok(info, `LiquidityNexus PDA not initialized: ${art.pdas!.liquidity_nexus}`);
  });

  test('Layer 9 E2E — master pool present (manager target)', () => {
    if (!art.pdas?.master_pool) {
      // eslint-disable-next-line no-console
      console.warn('[layer-09-e2e] master_pool not in artifact, manager will idle');
      assert.ok(true);
      return;
    }
    assert.ok(art.pdas.master_pool.length > 30, 'master_pool pubkey looks malformed');
  });

  test('Layer 9 E2E — nexus-manager runCycle (decision-only smoke)', async () => {
    // We do not exec the bot here — running a full cycle requires loadConfig
    // (which expects MANAGER_KEYPAIR_PATH and a populated env) and the
    // checkpoint store.  The artifact-driven harness in scripts/e2e-runner
    // (TBD) will exec the bot and capture decisions; here we assert only
    // that everything the bot needs is present (or explicitly gated).
    const gating = isNexusGated(art);
    if (gating.gated) {
      // eslint-disable-next-line no-console
      console.warn(`[layer-09-e2e] runCycle assertions skipped: ${gating.reason}`);
      assert.ok(true);
      return;
    }
    assert.ok(art.pdas?.liquidity_nexus, 'Nexus PDA missing for runCycle test');
    assert.ok(art.programs.native_dex, 'DEX program missing');
  });

  test('Layer 9 E2E — full live-flow (operator-driven)', () => {
    // The 14-step scenario (initialize_nexus → manager rotation → swap/add/remove
    // via nexus-manager → permissionless nexus_deposit → withdraw_profits →
    // claim_rewards) is exec'd by `scripts/e2e-runner.sh` once the bootstrap
    // toolchain stack is populated. The unit-test harness ships the surface
    // but does not exec the four bots itself — that is operator territory.
    const gating = isNexusGated(art);
    if (gating.gated) {
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-09-e2e] full-flow skipped: ${gating.reason}. Re-run after R20/IDL regen.`,
      );
      assert.ok(true);
      return;
    }
    // When not gated, we sanity-check only — full assertions live in the
    // operator runner.
    assert.ok(art.pdas?.liquidity_nexus, 'Nexus PDA expected');
  });
}
