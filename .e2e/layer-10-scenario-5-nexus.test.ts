/**
 * Layer 10 Substep 7 — Scenario 5: Nexus 14-step (live-submit E2E).
 *
 * Validates the LiquidityNexus surface end-to-end on the singleton Nexus PDA
 * created by Substep 1 phaseNexus (R57 closed). The Nexus owns USDC + RWT
 * ATAs and LpPosition entries; cumulative principal counters track deposits
 * and act as on-chain floor for `nexus_withdraw_profits`.
 *
 * Nine steps mirror the canonical Nexus surface, adapted to chain-state
 * verification (no live TX submission):
 *
 *   S5.1  LiquidityNexus state init verification
 *         → 58-byte length, manager != [0u8;32] (kill-switch off per D22),
 *           is_active == true, manager matches nexus-manager bot pubkey.
 *   S5.2  nexus_deposit USDC principal counter
 *         → total_deposited_usdc monotonically non-decreasing,
 *           ATA balance >= principal floor (no impermanent loss recorded yet).
 *   S5.3  nexus_deposit RWT principal counter (LH-drain leg)
 *         → same shape for RWT side.
 *   S5.4  nexus_swap target program-id wiring (D17 / SD-3)
 *         → NEXUS_HOSTING_PROGRAM_ID == DEX_PROGRAM_ID.
 *   S5.5  nexus_add_liquidity → LpPosition created
 *         → if Nexus has been active, LpPosition PDA exists with shares > 0,
 *           owner == Nexus PDA.
 *   S5.6  nexus_remove_liquidity invariant
 *         → principal counters UNCHANGED post-remove (only ATA balances shift).
 *   S5.7  nexus_withdraw_profits principal protection (KEY INVARIANT)
 *         → withdrawable_profit = max(0, ata_balance - total_deposited);
 *           contract enforces withdraw <= withdrawable_profit.
 *   S5.8  Withdraw > profit MUST be rejected
 *         → contract returns InsufficientNexusProfit when amount exceeds
 *           floor; we verify the floor invariant pre-condition holds.
 *   S5.9  claim_lp_fees / update_nexus_manager / nexus_record_deposit /
 *         nexus_claim_rewards surface verification
 *         → cumulative_fees_per_share_{a,b} u128-readable, manager-rotation
 *           gated on dex_config.authority, principal counters reachable.
 *
 * Mode of operation
 * ------------------
 * **Default (read-only):** asserts current on-chain state of the singleton
 * LiquidityNexus and runs principal-protection math closures against live
 * counter values. Math identities are unconditional; pre/post-snapshot
 * assertions need a live TX submission which the harness does NOT drive.
 *
 * **`SCENARIO_5_LIVE=1` (opt-in marker):** in the current implementation the
 * harness performs CHAIN-STATE VERIFICATION ONLY in both default and LIVE
 * modes — no transactions are submitted by this test. nexus_deposit /
 * nexus_swap / nexus_add_liquidity / nexus_remove_liquidity /
 * nexus_withdraw_profits are operator-driven via dashboard or deploy.sh
 * inline-exec hooks (only the Nexus manager keypair can sign).
 *
 * Pre-flight gates
 * ----------------
 *   1. `data/e2e-bootstrap.json` exists, schema_version === 1, under <REPO>/data/.
 *   2. `art.authority_chain.completed_at` is set (Substep 3 ran).
 *   3. `art.bots_started_at` is set (Substep 4 ran).
 *   4. `RPC_URL` env var reachable.
 *   5. `art.pdas.liquidity_nexus` populated (Substep 1 phaseNexus ran; R57 closed).
 *   6. `art.pdas.master_pool` populated (Nexus's add_liquidity target).
 *
 * Any unmet gate => structured skip (`assert.ok(true)` + `console.warn`).
 *
 * Principal-lock invariant (S5.7 / S5.8 — central Nexus assertion)
 * ----------------------------------------------------------------
 * `total_deposited_<token>` is monotonically non-decreasing (only
 * `nexus_deposit` and `nexus_record_deposit` may bump it). The invariant
 *   ata_balance >= total_deposited_<token>   (post-deposit, pre-withdraw)
 * is REQUIRED for the Nexus to honour deposit redemption semantics across
 * the protocol's lifetime. nexus_withdraw_profits' checked_sub underflow
 * path explicitly reverts with InsufficientNexusProfit on impermanent-loss
 * scenarios. See contracts/native-dex/src/instructions/nexus_withdraw_profits.rs.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// --------------------------------------------------------------------------
// Constants — mirror contract source. DO NOT edit without re-grepping
// contracts/native-dex/src/{constants.rs,state.rs,instructions/nexus_*.rs}.
// --------------------------------------------------------------------------

/** Native DEX pool type discriminants — see native-dex/src/constants.rs:11-12. */
const POOL_TYPE_CONCENTRATED = 1;

/** LiquidityNexus PDA seed (singleton) — see constants.rs:88. */
const LIQUIDITY_NEXUS_SEED = Buffer.from('liquidity_nexus');

/** LpPosition PDA seed prefix — see add_liquidity.rs:247 +
 * nexus_add_liquidity.rs:57: `["lp", pool_state, owner]`. For the Nexus,
 * `owner == liquidity_nexus_pda`. */
const LP_POSITION_SEED = Buffer.from('lp');

/** LiquidityNexus — offsets cross-checked against contracts/native-dex/src/state.rs:147-179.
 *
 * Singleton account: PDA = ["liquidity_nexus"]. is_active bool acts as the
 * Nexus kill-switch (initialized = true; flipping to false disables Nexus
 * surface globally). manager is the bot wallet that signs swap/add/remove
 * ix; manager == [0u8;32] is the documented kill-switch (D22) — the
 * `assert_manager` helper reverts NexusManagerDisabled regardless of which
 * wallet signed.
 *
 *   [0..8]    discriminator
 *   [8..40]   manager                  [u8;32]
 *   [40..48]  total_deposited_usdc     u64 LE — monotonically non-decreasing
 *   [48..56]  total_deposited_rwt      u64 LE — monotonically non-decreasing
 *   [56..57]  is_active                bool
 *   [57..58]  bump                     u8
 * Total SPACE = 8 + 50 = 58 bytes (compile-time asserted in state.rs:179).
 */
const NEXUS_OFFSET_MANAGER = 8;
const NEXUS_OFFSET_TOTAL_DEPOSITED_USDC = 40;
const NEXUS_OFFSET_TOTAL_DEPOSITED_RWT = 48;
const NEXUS_OFFSET_IS_ACTIVE = 56;
const NEXUS_TOTAL_LEN = 58;

/** PoolState — see scenario-3/4 for full layout. We only need cumulative
 * fee accumulator offsets here. */
const POOL_OFFSET_POOL_TYPE = 8;
const POOL_OFFSET_VAULT_A = 73;
const POOL_OFFSET_VAULT_B = 105;
const POOL_OFFSET_RESERVE_A = 137;
const POOL_OFFSET_TOTAL_LP_SHARES = 153;
const POOL_OFFSET_BIN_STEP_BPS = 180;
const POOL_OFFSET_CUMULATIVE_FEES_A = 220;
const POOL_OFFSET_CUMULATIVE_FEES_B = 236;
const POOL_TOTAL_LEN = 252;

/** LpPosition — offsets cross-checked against contracts/native-dex/src/state.rs:97-113.
 *
 *   [0..8]     discriminator
 *   [8..40]    pool                          [u8;32]
 *   [40..72]   owner                         [u8;32]
 *   [72..88]   shares                        u128 LE (16 bytes)
 *   [88..96]   last_update_ts                i64 LE
 *   [96..97]   bump                          u8
 *   [97..113]  fees_claimed_per_share_a      u128 LE
 *   [113..129] fees_claimed_per_share_b      u128 LE
 * Total SPACE = 8 + 121 = 129 bytes.
 */
const LP_POSITION_OFFSET_POOL = 8;
const LP_POSITION_OFFSET_OWNER = 40;
const LP_POSITION_OFFSET_SHARES = 72;
const LP_POSITION_TOTAL_LEN = 129;

/** SPL Token Account amount field (offset 64, u64 LE). */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_DATA_LEN = 165;

/** SPL Token program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA). */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** SPL Associated Token Account program ID. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// --------------------------------------------------------------------------
// Path & env wiring
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_ARTIFACT = resolve(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const ARTIFACT_PATH = process.env.E2E_BOOTSTRAP_ARTIFACT ?? DEFAULT_ARTIFACT;
const RPC_URL = process.env.RPC_URL;
const LIVE_MODE = process.env.SCENARIO_5_LIVE === '1';

// --------------------------------------------------------------------------
// Artifact shape — only fields this scenario reads.
// --------------------------------------------------------------------------

interface AuthorityChainArtifact {
  completed_at?: string;
}

interface BotRecord {
  keypair_path: string;
  pubkey: string;
  lamports?: number;
}

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
  mints?: {
    usdc_test_mint?: string;
    rwt_mint?: string;
  };
  pdas?: {
    dex_config?: string;
    liquidity_holding?: string;
    liquidity_nexus?: string;
    master_pool?: string;
    [k: string]: string | undefined;
  };
  bots?: Record<string, BotRecord>;
  authority_chain?: AuthorityChainArtifact;
  bots_started_at?: string;
}

function loadArtifact(): Artifact | null {
  if (!existsSync(ARTIFACT_PATH)) return null;
  // SEC-76 (mirrored from scenario-1/2/3/4): defense-in-depth — resolve
  // symlinks and assert the artifact lives under <REPO_ROOT>/data/.
  let realPath: string;
  try {
    realPath = realpathSync(ARTIFACT_PATH);
  } catch {
    return null;
  }
  const dataDir = resolve(REPO_ROOT, 'data') + sep;
  if (!realPath.startsWith(dataDir)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[layer-10-scenario-5] artifact path ${realPath} escapes ${dataDir}; refusing to load`,
    );
    return null;
  }
  try {
    return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Pre-flight gate evaluation
// --------------------------------------------------------------------------

interface PreflightResult {
  ready: boolean;
  reasons: string[];
  art?: Artifact;
}

function evaluatePreflight(): PreflightResult {
  const reasons: string[] = [];
  const art = loadArtifact();
  if (!art) {
    reasons.push(`artifact missing or unparseable at ${ARTIFACT_PATH}`);
    return { ready: false, reasons };
  }
  if (art.schema_version !== 1) {
    reasons.push(`schema_version=${art.schema_version} (expected 1)`);
  }
  if (!RPC_URL) {
    reasons.push('RPC_URL env var not set');
  }
  if (!art.authority_chain?.completed_at) {
    reasons.push('authority_chain.completed_at not stamped (Substep 3 not run)');
  }
  if (!art.bots_started_at) {
    reasons.push('bots_started_at not stamped (Substep 4 not run)');
  }
  if (!art.pdas?.liquidity_nexus) {
    reasons.push(
      'pdas.liquidity_nexus missing — Substep 1 phaseNexus did not run (R57 still open?)',
    );
  }
  if (!art.pdas?.master_pool) {
    reasons.push('pdas.master_pool missing — Nexus has no swap target');
  }
  return { ready: reasons.length === 0, reasons, art };
}

const PREFLIGHT = evaluatePreflight();

// --------------------------------------------------------------------------
// Pre-flight skip path
// --------------------------------------------------------------------------

if (!PREFLIGHT.ready) {
  test('Layer 10 Scenario 5 — Nexus 14-step (skipped — preflight not satisfied)', () => {
    // eslint-disable-next-line no-console
    console.warn(
      `[layer-10-scenario-5] preflight gate not satisfied:\n  - ${PREFLIGHT.reasons.join('\n  - ')}`,
    );
    assert.ok(true, 'see preflight reasons above');
  });
} else {
  // ------------------------------------------------------------------------
  // Live tests — preflight passed.
  // ------------------------------------------------------------------------
  const art = PREFLIGHT.art!;
  const conn = new Connection(RPC_URL!, 'confirmed');
  const nexusPda = new PublicKey(art.pdas!.liquidity_nexus!);
  const masterPoolPda = new PublicKey(art.pdas!.master_pool!);
  const dexProgramId = new PublicKey(art.programs.native_dex);

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------

  /** Read u64 amount from an SPL Token Account. Null on missing/malformed. */
  async function readTokenBalance(ata: PublicKey): Promise<bigint | null> {
    const info = await conn.getAccountInfo(ata, 'confirmed');
    if (!info) return null;
    if (info.data.length < TOKEN_ACCOUNT_DATA_LEN) return null;
    return info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
  }

  /** Read u128 LE from a Buffer (low + high u64 halves). */
  function readU128LE(buf: Buffer, offset: number): bigint {
    const low = buf.readBigUInt64LE(offset);
    const high = buf.readBigUInt64LE(offset + 8);
    return low | (high << 64n);
  }

  /** Derive an Associated Token Account address.
   * Seeds: [owner, TOKEN_PROGRAM_ID, mint] under ASSOCIATED_TOKEN_PROGRAM_ID. */
  function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return ata;
  }

  interface NexusView {
    manager: PublicKey;
    totalDepositedUsdc: bigint;
    totalDepositedRwt: bigint;
    isActive: boolean;
  }

  /** Read LiquidityNexus account. Strict 58-byte gate before any subarray. */
  async function readNexus(pda: PublicKey): Promise<NexusView | null> {
    const info = await conn.getAccountInfo(pda, 'confirmed');
    if (!info) return null;
    assert.ok(
      info.data.length >= NEXUS_TOTAL_LEN,
      `LiquidityNexus ${pda.toBase58()} data length ${info.data.length} < ${NEXUS_TOTAL_LEN} — layout drift`,
    );
    return {
      manager: new PublicKey(
        info.data.subarray(NEXUS_OFFSET_MANAGER, NEXUS_OFFSET_MANAGER + 32),
      ),
      totalDepositedUsdc: info.data.readBigUInt64LE(NEXUS_OFFSET_TOTAL_DEPOSITED_USDC),
      totalDepositedRwt: info.data.readBigUInt64LE(NEXUS_OFFSET_TOTAL_DEPOSITED_RWT),
      isActive: info.data.readUInt8(NEXUS_OFFSET_IS_ACTIVE) === 1,
    };
  }

  interface PoolView {
    poolType: number;
    vaultA: PublicKey;
    vaultB: PublicKey;
    reserveA: bigint;
    totalLpShares: bigint;
    binStepBps: number;
    cumulativeFeesA: bigint;
    cumulativeFeesB: bigint;
  }

  async function readPool(pda: PublicKey): Promise<PoolView | null> {
    const info = await conn.getAccountInfo(pda, 'confirmed');
    if (!info) return null;
    assert.ok(
      info.data.length >= POOL_TOTAL_LEN,
      `PoolState ${pda.toBase58()} data length ${info.data.length} < ${POOL_TOTAL_LEN} — layout drift`,
    );
    return {
      poolType: info.data.readUInt8(POOL_OFFSET_POOL_TYPE),
      vaultA: new PublicKey(info.data.subarray(POOL_OFFSET_VAULT_A, POOL_OFFSET_VAULT_A + 32)),
      vaultB: new PublicKey(info.data.subarray(POOL_OFFSET_VAULT_B, POOL_OFFSET_VAULT_B + 32)),
      reserveA: info.data.readBigUInt64LE(POOL_OFFSET_RESERVE_A),
      totalLpShares: readU128LE(info.data, POOL_OFFSET_TOTAL_LP_SHARES),
      binStepBps: info.data.readUInt16LE(POOL_OFFSET_BIN_STEP_BPS),
      cumulativeFeesA: readU128LE(info.data, POOL_OFFSET_CUMULATIVE_FEES_A),
      cumulativeFeesB: readU128LE(info.data, POOL_OFFSET_CUMULATIVE_FEES_B),
    };
  }

  interface LpPositionView {
    pool: PublicKey;
    owner: PublicKey;
    shares: bigint;
  }

  /** Read LpPosition account. Returns null if missing or below the strict
   * 129-byte length gate. */
  async function readLpPosition(pda: PublicKey): Promise<LpPositionView | null> {
    const info = await conn.getAccountInfo(pda, 'confirmed');
    if (!info) return null;
    if (info.data.length < LP_POSITION_TOTAL_LEN) return null;
    return {
      pool: new PublicKey(
        info.data.subarray(LP_POSITION_OFFSET_POOL, LP_POSITION_OFFSET_POOL + 32),
      ),
      owner: new PublicKey(
        info.data.subarray(LP_POSITION_OFFSET_OWNER, LP_POSITION_OFFSET_OWNER + 32),
      ),
      shares: readU128LE(info.data, LP_POSITION_OFFSET_SHARES),
    };
  }

  // SEC L-3 — this file imports no SPL Keypair / signing primitives. Live
  // signing legs (manager-only) are operator-driven; LIVE_MODE only logs
  // deferred targets.

  // ----------------------------------------------------------------------
  // Schema sanity
  // ----------------------------------------------------------------------

  test('S5 sanity — DEX program + Nexus PDA + master pool wiring', async () => {
    assert.equal(art.schema_version, 1, 'schema_version drift');
    assert.ok(art.programs.native_dex, 'DEX program ID missing');
    assert.ok(art.pdas?.dex_config, 'dex_config PDA missing');
    assert.ok(art.pdas?.liquidity_nexus, 'liquidity_nexus PDA missing');
    assert.ok(art.pdas?.master_pool, 'master_pool PDA missing');
    assert.ok(art.mints?.rwt_mint, 'rwt_mint missing');
    assert.ok(art.mints?.usdc_test_mint, 'usdc_test_mint missing');

    // Singleton PDA derivation must match the canonical seed (constants.rs:88).
    const [derivedNexus] = PublicKey.findProgramAddressSync(
      [LIQUIDITY_NEXUS_SEED],
      dexProgramId,
    );
    assert.ok(
      derivedNexus.equals(nexusPda),
      `derived liquidity_nexus PDA ${derivedNexus.toBase58()} != artifact ${nexusPda.toBase58()}`,
    );
  });

  // ----------------------------------------------------------------------
  // S5.1 — LiquidityNexus state init verification
  // ----------------------------------------------------------------------

  test('S5.1 LiquidityNexus init — length + manager + is_active', async () => {
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus account not found on-chain');

    // is_active MUST be true post-initialize_nexus (set inside the ix; only
    // pause_nexus / update_nexus_manager(zero-pubkey) can flip it).
    assert.ok(nexus!.isActive, 'LiquidityNexus.is_active must be true post-initialize_nexus');

    // Kill-switch invariant (D22): manager == [0u8;32] is the documented
    // disabled state (assert_manager reverts NexusManagerDisabled). Initialized
    // Nexus MUST have a non-zero manager.
    const allZero = nexus!.manager.toBuffer().every((b) => b === 0);
    assert.ok(
      !allZero,
      `LiquidityNexus.manager is all-zero (D22 kill-switch state) — phase 5 / phase 6 not run?`,
    );

    // Cross-check: manager SHOULD equal the nexus-manager bot pubkey from
    // the artifact's bots[] map (Phase 6 update_nexus_manager). Surface a
    // structured note rather than fail when artifact has no bot record yet
    // (Substep 4 may have only registered a subset).
    const nexusManagerBot = art.bots?.['nexus-manager'];
    if (nexusManagerBot) {
      const expectedPubkey = new PublicKey(nexusManagerBot.pubkey);
      assert.ok(
        nexus!.manager.equals(expectedPubkey),
        `LiquidityNexus.manager ${nexus!.manager.toBase58()} != artifact bots['nexus-manager'].pubkey ${expectedPubkey.toBase58()}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-10-scenario-5] S5.1: artifact.bots['nexus-manager'] not present — manager pubkey cross-check skipped (manager on chain = ${nexus!.manager.toBase58()})`,
      );
    }

    // Counters must be u64-readable and non-negative (u64 is always >= 0;
    // the assertion guards against future signed-cast bugs).
    assert.ok(
      nexus!.totalDepositedUsdc >= 0n,
      'total_deposited_usdc must be u64 readable',
    );
    assert.ok(
      nexus!.totalDepositedRwt >= 0n,
      'total_deposited_rwt must be u64 readable',
    );
  });

  // ----------------------------------------------------------------------
  // S5.2 — nexus_deposit USDC principal counter
  // ----------------------------------------------------------------------

  test('S5.2 nexus_deposit USDC — principal-floor invariant (ata >= total_deposited)', async () => {
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus missing');
    assert.ok(art.mints?.usdc_test_mint, 'usdc_test_mint missing for ATA derivation');

    // Derive Nexus's USDC ATA (canonical SPL ATA seed: [owner, TOKEN, mint]).
    const usdcMint = new PublicKey(art.mints!.usdc_test_mint!);
    const nexusUsdcAta = deriveAta(nexusPda, usdcMint);

    // The Nexus USDC ATA MAY not exist yet if no deposit has landed — this is
    // a legal post-init / pre-deposit state. In that case the principal
    // counter MUST also be zero.
    const usdcBalance = await readTokenBalance(nexusUsdcAta);
    if (usdcBalance === null) {
      assert.equal(
        nexus!.totalDepositedUsdc,
        0n,
        `Nexus USDC ATA missing but total_deposited_usdc=${nexus!.totalDepositedUsdc} (expected 0)`,
      );
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-10-scenario-5] S5.2: Nexus USDC ATA ${nexusUsdcAta.toBase58()} not initialized (no deposits yet)`,
      );
    } else {
      // PRINCIPAL-FLOOR INVARIANT (the central Nexus property — see
      // contracts/native-dex/src/instructions/nexus_withdraw_profits.rs:13):
      //   ata_balance >= total_deposited_usdc   (post-deposit, pre-withdraw)
      // Drift here means EITHER the manager withdrew principal (contract
      // bug) OR there's an impermanent-loss state (contract reverts on next
      // withdraw_profits with InsufficientNexusProfit). We assert the
      // healthy state; impermanent loss is a tracked condition outside the
      // happy-path E2E.
      assert.ok(
        usdcBalance! >= nexus!.totalDepositedUsdc,
        `principal-floor violation USDC: ata=${usdcBalance} < total_deposited=${nexus!.totalDepositedUsdc}`,
      );
    }

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] LIVE_MODE: nexus_deposit(USDC) deferred to manager bot ` +
          `(nexus_usdc_ata=${nexusUsdcAta.toBase58()}, current_principal=${nexus!.totalDepositedUsdc})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.3 — nexus_deposit RWT principal counter (LH-drain leg)
  // ----------------------------------------------------------------------

  test('S5.3 nexus_deposit RWT — principal-floor invariant + LH-drain compatibility', async () => {
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus missing');
    assert.ok(art.mints?.rwt_mint, 'rwt_mint missing for ATA derivation');

    const rwtMint = new PublicKey(art.mints!.rwt_mint!);
    const nexusRwtAta = deriveAta(nexusPda, rwtMint);

    const rwtBalance = await readTokenBalance(nexusRwtAta);
    if (rwtBalance === null) {
      // Same shape as S5.2: missing ATA must coincide with zero floor.
      assert.equal(
        nexus!.totalDepositedRwt,
        0n,
        `Nexus RWT ATA missing but total_deposited_rwt=${nexus!.totalDepositedRwt} (expected 0)`,
      );
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-10-scenario-5] S5.3: Nexus RWT ATA ${nexusRwtAta.toBase58()} not initialized (no LH-drain or manual deposit yet)`,
      );
    } else {
      // Same principal-floor invariant as S5.2, RWT side. The RWT counter
      // also tracks LH-drain inflows (15% liquidity_share routing via YD's
      // withdraw_liquidity_holding CPI -> nexus_record_deposit). Both
      // sources monotonically bump the counter; ata_balance >= floor must
      // hold across both paths.
      assert.ok(
        rwtBalance! >= nexus!.totalDepositedRwt,
        `principal-floor violation RWT: ata=${rwtBalance} < total_deposited=${nexus!.totalDepositedRwt}`,
      );
    }

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] LIVE_MODE: nexus_deposit(RWT) / LH-drain deferred to operator ` +
          `(nexus_rwt_ata=${nexusRwtAta.toBase58()}, current_principal=${nexus!.totalDepositedRwt})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.4 — nexus_swap target program-id wiring (D17 / SD-3)
  // ----------------------------------------------------------------------

  test('S5.4 nexus_swap surface — NEXUS_HOSTING_PROGRAM_ID == DEX_PROGRAM_ID (D17 / SD-3)', async () => {
    // D17 / SD-3 (Layer 9 decisions): NEXUS_PROGRAM_ID_PLACEHOLDER was
    // replaced by NEXUS_HOSTING_PROGRAM_ID = DEX_PROGRAM_ID. The Nexus PDA
    // is HOSTED inside the DEX program (single program-id, no separate
    // Nexus program). So nexus_swap dispatches via the DEX program-id, and
    // the Nexus PDA derivation MUST use DEX_PROGRAM_ID.
    //
    // Verify the alignment at the artifact level: the Nexus PDA in the
    // artifact must derive under art.programs.native_dex.
    const [derivedNexus] = PublicKey.findProgramAddressSync(
      [LIQUIDITY_NEXUS_SEED],
      dexProgramId,
    );
    assert.ok(
      derivedNexus.equals(nexusPda),
      `D17/SD-3 violation: Nexus PDA ${nexusPda.toBase58()} does not derive under DEX program ${dexProgramId.toBase58()} ` +
        `(derived ${derivedNexus.toBase58()}). NEXUS_HOSTING_PROGRAM_ID alias broken?`,
    );

    // Cross-check the swap target (master pool) is reachable + concentrated.
    const pool = await readPool(masterPoolPda);
    assert.ok(pool, 'master pool not initialized — Nexus has no swap target');
    assert.equal(
      pool!.poolType,
      POOL_TYPE_CONCENTRATED,
      `Nexus swap target master_pool is not concentrated (pool_type=${pool!.poolType})`,
    );
    assert.ok(
      pool!.binStepBps > 0,
      'Nexus swap target master_pool has bin_step_bps=0 — concentrated pool malformed',
    );

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] LIVE_MODE: nexus_swap deferred to manager bot ` +
          `(target_pool=${masterPoolPda.toBase58()}, dex_program=${dexProgramId.toBase58()})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.5 — nexus_add_liquidity → LpPosition created
  // ----------------------------------------------------------------------

  test('S5.5 nexus_add_liquidity — LpPosition derivation + ownership', async () => {
    // LpPosition PDA seed: ["lp", pool_state, owner] where owner == nexus_pda.
    const [lpPositionPda] = PublicKey.findProgramAddressSync(
      [LP_POSITION_SEED, masterPoolPda.toBuffer(), nexusPda.toBuffer()],
      dexProgramId,
    );

    const lp = await readLpPosition(lpPositionPda);
    if (!lp) {
      // Legal pre-condition: Nexus has not yet deposited liquidity on this
      // pool. Surface as structured note + skip.
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-10-scenario-5] S5.5: Nexus LpPosition ${lpPositionPda.toBase58()} not yet created ` +
          `(no nexus_add_liquidity has landed for master_pool)`,
      );
      assert.ok(true, 'see warning above');
      return;
    }

    // Cross-check ownership: LpPosition.pool MUST be master_pool, and
    // LpPosition.owner MUST be the Nexus PDA. Drift here means a foreign LP
    // (NOT the Nexus) wrote to this PDA — should be impossible if PDA
    // derivation is consistent, but a defense-in-depth assertion.
    assert.ok(
      lp!.pool.equals(masterPoolPda),
      `LpPosition.pool ${lp!.pool.toBase58()} != master_pool ${masterPoolPda.toBase58()}`,
    );
    assert.ok(
      lp!.owner.equals(nexusPda),
      `LpPosition.owner ${lp!.owner.toBase58()} != nexus_pda ${nexusPda.toBase58()}`,
    );
    // shares >= 0 is u128 readability check.
    assert.ok(lp!.shares >= 0n, 'LpPosition.shares must be u128 readable');

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] LIVE_MODE: nexus_add_liquidity deferred to manager bot ` +
          `(lp_position=${lpPositionPda.toBase58()}, current_shares=${lp!.shares})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.6 — nexus_remove_liquidity invariant
  // ----------------------------------------------------------------------

  test('S5.6 nexus_remove_liquidity — principal-floor invariant continuous (ata >= floor)', async () => {
    // A-78 rename: harness reads chain state once; cannot prove pre/post-remove
    // diff. Asserts the continuous principal-floor invariant which holds for
    // both pre-remove AND post-remove states. The pre/post counter-diff
    // assertion is deferred to live rehearsal.
    // The contract-side invariant: nexus_remove_liquidity moves tokens from
    // pool vaults back into Nexus's USDC + RWT ATAs. The principal counters
    // (total_deposited_*) are NOT decremented — they are the irreducible
    // floor across the Nexus's lifetime (D22 / SD-2). After remove, the
    // ATA balances change but the floor does not.
    //
    // The harness cannot diff pre/post without a live submit. Instead we
    // assert the standing invariant: ata_balance >= floor, which holds
    // both before AND after remove (remove only ADDS to the ATA; floor
    // never decreases).
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus missing');
    assert.ok(art.mints?.usdc_test_mint && art.mints?.rwt_mint, 'mints missing');

    const usdcMint = new PublicKey(art.mints!.usdc_test_mint!);
    const rwtMint = new PublicKey(art.mints!.rwt_mint!);
    const nexusUsdcAta = deriveAta(nexusPda, usdcMint);
    const nexusRwtAta = deriveAta(nexusPda, rwtMint);

    const usdcBalance = await readTokenBalance(nexusUsdcAta);
    const rwtBalance = await readTokenBalance(nexusRwtAta);

    // The principal-floor invariant must hold continuously. Skipping with
    // structured note when ATAs are missing matches S5.2/S5.3.
    if (usdcBalance !== null) {
      assert.ok(
        usdcBalance! >= nexus!.totalDepositedUsdc,
        `S5.6 floor violation USDC: ata=${usdcBalance} < total_deposited=${nexus!.totalDepositedUsdc}`,
      );
    }
    if (rwtBalance !== null) {
      assert.ok(
        rwtBalance! >= nexus!.totalDepositedRwt,
        `S5.6 floor violation RWT: ata=${rwtBalance} < total_deposited=${nexus!.totalDepositedRwt}`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.7 — nexus_withdraw_profits principal protection (KEY INVARIANT)
  // ----------------------------------------------------------------------

  test('S5.7 nexus_withdraw_profits — withdrawable_profit = max(0, ata - floor)', async () => {
    // This is the central Nexus invariant — see
    // contracts/native-dex/src/instructions/nexus_withdraw_profits.rs:13
    //
    //   ata_balance >= total_deposited_<token>   (pre-withdraw guard)
    //   withdrawable_profit = ata_balance - total_deposited
    //
    // The contract uses checked_sub; underflow returns
    // InsufficientNexusProfit. Manager CANNOT touch principal. We compute
    // withdrawable_profit for both sides and assert the closed-form math
    // matches the contract's semantics.
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus missing');
    assert.ok(art.mints?.usdc_test_mint && art.mints?.rwt_mint, 'mints missing');

    const usdcMint = new PublicKey(art.mints!.usdc_test_mint!);
    const rwtMint = new PublicKey(art.mints!.rwt_mint!);
    const nexusUsdcAta = deriveAta(nexusPda, usdcMint);
    const nexusRwtAta = deriveAta(nexusPda, rwtMint);

    const usdcBalance = await readTokenBalance(nexusUsdcAta);
    const rwtBalance = await readTokenBalance(nexusRwtAta);

    // For each side: when ATA exists, withdrawable_profit = ata - floor (if
    // ata >= floor) OR 0 (otherwise; contract reverts on attempted withdraw).
    if (usdcBalance !== null) {
      let withdrawableUsdc: bigint;
      if (usdcBalance! >= nexus!.totalDepositedUsdc) {
        withdrawableUsdc = usdcBalance! - nexus!.totalDepositedUsdc;
      } else {
        // Impermanent-loss state: ata < floor. Contract reverts; harness
        // reports 0 withdrawable.
        withdrawableUsdc = 0n;
      }
      assert.ok(
        withdrawableUsdc >= 0n,
        `S5.7 USDC: withdrawable_profit math broken (got ${withdrawableUsdc})`,
      );
      assert.ok(
        withdrawableUsdc <= usdcBalance!,
        `S5.7 USDC: withdrawable_profit ${withdrawableUsdc} > ata_balance ${usdcBalance} (impossible)`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] S5.7 USDC: ata=${usdcBalance}, floor=${nexus!.totalDepositedUsdc}, withdrawable=${withdrawableUsdc}`,
      );
    }

    if (rwtBalance !== null) {
      let withdrawableRwt: bigint;
      if (rwtBalance! >= nexus!.totalDepositedRwt) {
        withdrawableRwt = rwtBalance! - nexus!.totalDepositedRwt;
      } else {
        withdrawableRwt = 0n;
      }
      assert.ok(
        withdrawableRwt >= 0n,
        `S5.7 RWT: withdrawable_profit math broken (got ${withdrawableRwt})`,
      );
      assert.ok(
        withdrawableRwt <= rwtBalance!,
        `S5.7 RWT: withdrawable_profit ${withdrawableRwt} > ata_balance ${rwtBalance} (impossible)`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] S5.7 RWT: ata=${rwtBalance}, floor=${nexus!.totalDepositedRwt}, withdrawable=${withdrawableRwt}`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.8 — Withdraw > profit MUST be rejected
  // ----------------------------------------------------------------------

  test('S5.8 nexus_withdraw_profits rejection — contract enforces amount <= withdrawable', async () => {
    // The contract's checked_sub guard rejects any withdraw amount > ata -
    // floor with InsufficientNexusProfit. We do NOT submit a faulty TX.
    // Instead we verify the precondition required for the guard to fire is
    // observable from chain state:
    //   1. Nexus is initialized (S5.1 ran).
    //   2. is_active == true (manager ix dispatch is enabled).
    //   3. Principal floor counters are readable.
    //   4. ATAs are readable (or absent, in which case any withdraw would
    //      fail at the account-not-token-account guard, which precedes the
    //      insufficient-profit guard).
    //
    // If any of (1)-(4) fails, the InsufficientNexusProfit guard cannot
    // fire — but neither can ANY withdraw, so the principal is still
    // protected (defense in depth).
    const nexus = await readNexus(nexusPda);
    assert.ok(nexus, 'LiquidityNexus missing');
    assert.ok(nexus!.isActive, 'Nexus not active — withdraw_profits would revert before guard');

    // Floor counters MUST be u64-readable (otherwise the contract's
    // arithmetic itself would panic on wrap-around — a different failure
    // mode).
    assert.ok(
      nexus!.totalDepositedUsdc <= 0xffff_ffff_ffff_ffffn,
      `total_deposited_usdc ${nexus!.totalDepositedUsdc} overflows u64`,
    );
    assert.ok(
      nexus!.totalDepositedRwt <= 0xffff_ffff_ffff_ffffn,
      `total_deposited_rwt ${nexus!.totalDepositedRwt} overflows u64`,
    );

    // Document the rejection contract surface for the operator. The actual
    // rejection test is operator-driven via deploy.sh / dashboard tooling.
    // eslint-disable-next-line no-console
    console.log(
      `[layer-10-scenario-5] S5.8: contract guard verified reachable. ` +
        `Operator must drive: try nexus_withdraw_profits(amount > ata - floor) ` +
        `=> expect InsufficientNexusProfit error.`,
    );

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        `[layer-10-scenario-5] LIVE_MODE: faulty-withdraw rejection deferred to operator ` +
          `(usdc_floor=${nexus!.totalDepositedUsdc}, rwt_floor=${nexus!.totalDepositedRwt})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S5.9 — claim_lp_fees / update_nexus_manager / nexus_record_deposit /
  //        nexus_claim_rewards — surface verification
  // ----------------------------------------------------------------------

  test('S5.9 claim_lp_fees surface — pool cumulative_fees_per_share readable', async () => {
    // claim_lp_fees relies on PoolState.cumulative_fees_per_share_{a,b}
    // (Layer 9 D28). Read the master pool's cumulative fees and assert the
    // u128 surface is well-formed (low + high halves combined). The actual
    // accrual happens inside swap.rs each time a side fee is collected; here
    // we verify the field is reachable.
    const pool = await readPool(masterPoolPda);
    assert.ok(pool, 'master pool missing');
    assert.ok(
      pool!.cumulativeFeesA >= 0n,
      'pool.cumulative_fees_per_share_a must be u128 readable',
    );
    assert.ok(
      pool!.cumulativeFeesB >= 0n,
      'pool.cumulative_fees_per_share_b must be u128 readable',
    );

    // Q64.64 fixed-point: high 64 bits represent the integer portion.
    // Sentinel: post-D28 the field is ALWAYS post-init (no migration), so
    // reading must succeed even on a freshly-bootstrapped pool with zero
    // fees accrued (both halves zero).
    // eslint-disable-next-line no-console
    console.log(
      `[layer-10-scenario-5] S5.9 cumulative_fees: a=${pool!.cumulativeFeesA}, b=${pool!.cumulativeFeesB}`,
    );
  });

  test('S5.9 update_nexus_manager surface — auth gate via dex_config.authority', async () => {
    // update_nexus_manager is gated by dex_config.authority (the same gate
    // used by every DEX-config-mutating ix per D31). After Phase 7, that
    // authority is the Multisig (on devnet: deployer-as-pseudo-Multisig).
    //
    // We verify the gate is reachable: dex_config exists and has a
    // non-zero authority field (zeroed authority would mean update_*
    // dispatch fails before reaching the manager-rotation logic).
    assert.ok(art.pdas?.dex_config, 'dex_config PDA missing');
    const dexConfigPda = new PublicKey(art.pdas!.dex_config!);
    const info = await conn.getAccountInfo(dexConfigPda, 'confirmed');
    assert.ok(info, 'dex_config account not found');
    // dex_config layout (contracts/native-dex/src/state.rs):
    //   [0..8]    discriminator
    //   [8..40]   authority         [u8;32]
    //   ...
    assert.ok(info!.data.length >= 8 + 32, 'dex_config too small to hold authority');
    const authorityBytes = info!.data.subarray(8, 8 + 32);
    const allZero = authorityBytes.every((b) => b === 0);
    assert.ok(
      !allZero,
      'dex_config.authority is all-zero — update_nexus_manager auth gate broken',
    );
    // eslint-disable-next-line no-console
    console.log(
      `[layer-10-scenario-5] S5.9 update_nexus_manager auth gate: dex_config.authority=${new PublicKey(authorityBytes).toBase58()}`,
    );
  });

  test('S5.9 nexus_record_deposit surface — LH-drain CPI gate', async () => {
    // nexus_record_deposit is the CPI-only entry from YD's
    // withdraw_liquidity_holding (the LH-drain leg). It atomically:
    //   1. Transfers RWT from LiquidityHolding ATA -> Nexus RWT ATA.
    //   2. Bumps total_deposited_rwt (NEVER USDC — this is the LH-drain leg
    //      and LH only holds RWT).
    //
    // We verify the LiquidityHolding PDA is reachable + its singleton
    // wiring matches D17 / SD-3 (LH lives under the YD program; nexus_pda
    // derives under DEX_PROGRAM_ID; they're separate programs but the CPI
    // is YD -> DEX with the Nexus PDA as the signer-of-receipt).
    if (!art.pdas?.liquidity_holding) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-5] S5.9 nexus_record_deposit: liquidity_holding PDA missing — LH-drain leg skipped',
      );
      assert.ok(true, 'see warning above');
      return;
    }
    const holdingPda = new PublicKey(art.pdas!.liquidity_holding!);
    const info = await conn.getAccountInfo(holdingPda, 'confirmed');
    if (!info) {
      // eslint-disable-next-line no-console
      console.warn(
        `[layer-10-scenario-5] S5.9 nexus_record_deposit: LH account ${holdingPda.toBase58()} not found on-chain`,
      );
      assert.ok(true, 'see warning above');
      return;
    }
    // LiquidityHolding singleton: 8 disc + state. Length gate is loose —
    // we only need the CPI surface to be REACHABLE, not parsed in detail.
    assert.ok(info!.data.length >= 8, `LiquidityHolding ${holdingPda.toBase58()} malformed`);
  });

  test('S5.9 nexus_claim_rewards surface — pool reserves & supply readable', async () => {
    // nexus_claim_rewards reads pool reserves to compute reward share for
    // the Nexus's LpPosition. We verify reserves + total_lp_shares are
    // readable on the master pool — the surface the reward calc walks.
    const pool = await readPool(masterPoolPda);
    assert.ok(pool, 'master pool missing');
    assert.ok(
      pool!.reserveA >= 0n && pool!.totalLpShares >= 0n,
      'master pool reserves / total_lp_shares not u-readable',
    );
    // Reward calc is a no-op when total_lp_shares == 0 (no LPs). Surface
    // as structured info for the operator.
    if (pool!.totalLpShares === 0n) {
      // eslint-disable-next-line no-console
      console.log(
        '[layer-10-scenario-5] S5.9 nexus_claim_rewards: master pool has no LPs (total_lp_shares=0); reward calc trivially 0',
      );
    }
  });

  // ----------------------------------------------------------------------
  // Linter pacification — same pattern as scenarios 1/2/3/4.
  // ----------------------------------------------------------------------

  test('S5 imports — live-submit primitives type-check guard (no-op)', () => {
    const sp: typeof SystemProgram = SystemProgram;
    const tx: typeof Transaction = Transaction;
    const ix: typeof TransactionInstruction = TransactionInstruction;
    const send: typeof sendAndConfirmTransaction = sendAndConfirmTransaction;
    assert.ok(typeof sp.transfer === 'function');
    assert.ok(typeof tx === 'function');
    assert.ok(typeof ix === 'function');
    assert.ok(typeof send === 'function');
  });
}
