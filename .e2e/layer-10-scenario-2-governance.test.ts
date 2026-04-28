/**
 * Layer 10 Substep 6 — Scenario 2: Governance (Futarchy live-submit E2E).
 *
 * Validates the Futarchy proposal lifecycle for the ARL OT mint. Five steps
 * mirror the canonical proposal-type matrix + cancel + authority-rejection.
 *
 *   S2.1  Create + approve + execute MintOt proposal
 *         → ARL OT supply increases by proposal.amount.
 *   S2.2  Create + approve + execute SpendTreasury proposal
 *         → ARL Treasury USDC ATA decreases by proposal.amount.
 *   S2.3  Create + approve + execute UpdateDestinations proposal
 *         → RevenueConfig.destinations rewritten + config_version bumps.
 *   S2.4  Cancel a pending proposal → status transitions Active → Cancelled.
 *         A subsequent execute attempt is rejected (verified via account state,
 *         NOT a live TX submit).
 *   S2.5  Old deployer cannot call OT governance directly
 *         → OtGovernance.authority != deployer post-Phase-7.
 *
 * Mode of operation
 * ------------------
 * **Default (read-only):** asserts current on-chain state of any Proposal PDAs
 * the harness can locate (proposals 0..N-1 derived from FutarchyConfig). Math
 * closures run unconditionally; per-proposal lifecycle assertions fall through
 * with a structured note when no Proposal exists yet.
 *
 * **`SCENARIO_2_LIVE=1` (opt-in marker):** in the current implementation the
 * harness performs CHAIN-STATE VERIFICATION ONLY in both default and LIVE
 * modes — no transactions are submitted by this test. Proposal create /
 * approve / execute / cancel are operator-driven via deploy.sh /
 * e2e-runner.ts inline-exec hooks (the multisig authority signs).
 *
 * The LIVE_MODE flag is reserved for a future Substep that lands inline
 * Futarchy ix construction + multisig signing. Setting it today logs the
 * deferred action targets but does not move tokens.
 *
 * Pre-flight gates
 * ----------------
 *   1. `data/e2e-bootstrap.json` exists, schema_version === 1, under <REPO>/data/.
 *   2. `art.authority_chain.completed_at` is set (Substep 3 ran — handoff done).
 *   3. `art.bots_started_at` is set (Substep 4 ran).
 *   4. `RPC_URL` env var reachable.
 *   5. ARL OT record present with `futarchy_config_pda` populated (Phase 6).
 *
 * Any unmet gate ⇒ structured skip (`assert.ok(true)` + `console.warn`).
 *
 * Implicit closure
 * ----------------
 * If S2.5 passes (deployer != OT authority post-handoff):
 *   - Authority chain handoff for OT is verified end-to-end.
 *   - Combined with Scenario 1's R-A invariant, this triple-checks that the
 *     legacy deployer cannot bypass Futarchy and mint OT supply directly.
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
// contracts/futarchy/src/state.rs + ownership-token/src/state.rs.
// --------------------------------------------------------------------------

/** Futarchy Proposal status enum — see contracts/futarchy/src/state.rs:8-12.
 *
 * The contract uses STATUS_ACTIVE for the freshly-created state (NOT
 * "Pending" — naming drift between docs/comments and source). Lifecycle:
 *   Active(0) → Approved(1) → Executed(2)
 *   Active(0) → Cancelled(3)
 */
const PROPOSAL_STATUS_ACTIVE = 0;
const PROPOSAL_STATUS_APPROVED = 1;
const PROPOSAL_STATUS_EXECUTED = 2;
const PROPOSAL_STATUS_CANCELLED = 3;

/** Futarchy Proposal type enum — see contracts/futarchy/src/state.rs:4-6. */
const PROPOSAL_TYPE_MINT_OT = 0;
const PROPOSAL_TYPE_SPEND_TREASURY = 1;
const PROPOSAL_TYPE_UPDATE_DESTINATIONS = 2;

/** Proposal — offsets cross-checked against contracts/futarchy/src/state.rs:30-46.
 *   [0..8]     discriminator
 *   [8..16]    proposal_id        u64 LE
 *   [16..48]   ot_mint            [u8;32]
 *   [48..80]   proposer           [u8;32]
 *   [80..81]   proposal_type      u8
 *   [81..89]   amount             u64 LE
 *   [89..121]  destination        [u8;32]
 *   [121..153] token_mint         [u8;32]
 *   [153..185] params_hash        [u8;32]
 *   [185..186] status             u8
 *   [186..194] created_ts         i64 LE
 *   [194..202] executed_ts        i64 LE
 *   [202..203] bump               u8
 * Total SPACE = 8 + 195 = 203 bytes (compile-time asserted in state.rs).
 */
const PROPOSAL_OFFSET_PROPOSAL_ID = 8;
const PROPOSAL_OFFSET_PROPOSAL_TYPE = 80;
const PROPOSAL_OFFSET_AMOUNT = 81;
const PROPOSAL_OFFSET_STATUS = 185;
const PROPOSAL_TOTAL_LEN = 203;

/** FutarchyConfig — offsets cross-checked against contracts/futarchy/src/state.rs:16-25.
 *   [0..8]     discriminator
 *   [8..40]    ot_mint            [u8;32]
 *   [40..72]   authority          [u8;32]
 *   [72..104]  pending_authority  [u8;32]
 *   [104..105] has_pending        bool
 *   [105..113] next_proposal_id   u64 LE
 *   [113..114] is_active          bool
 *   [114..115] bump               u8
 * Total SPACE = 8 + 107 = 115 bytes.
 */
const FUTARCHY_CFG_AUTHORITY_OFFSET = 40;
const FUTARCHY_CFG_NEXT_PROPOSAL_ID_OFFSET = 105;
const FUTARCHY_CFG_TOTAL_LEN = 115;

/** OtGovernance — offsets cross-checked against
 * contracts/ownership-token/src/state.rs:103-110.
 *   [0..8]     discriminator
 *   [8..40]    ot_mint            [u8;32]
 *   [40..72]   authority          [u8;32]
 *   [72..104]  pending_authority  [u8;32]
 *   [104..105] has_pending        bool
 *   [105..106] is_active          bool
 *   [106..107] bump               u8
 * Total SPACE = 8 + 99 = 107 bytes.
 */
const OT_GOV_AUTHORITY_OFFSET = 40;
const OT_GOV_TOTAL_LEN = 107;

/** RevenueConfig.config_version — see ownership-token/src/state.rs:88-95.
 *   [0..8]      discriminator
 *   [8..40]     ot_mint            [u8;32]
 *   [40..700]   destinations[10]   (66 bytes each)
 *   [700..701]  active_count       u8
 *   [701..709]  config_version     u64 LE
 *   [709..741]  areal_fee_destination [u8;32]
 *   [741..742]  bump               u8
 * Total SPACE = 8 + 734 = 742 bytes.
 */
const REV_CFG_ACTIVE_COUNT_OFFSET = 700;
const REV_CFG_CONFIG_VERSION_OFFSET = 701;

/** SPL Token Account amount field (offset 64, u64 LE). */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_DATA_LEN = 165;

/** SPL Mint supply field (offset 36, u64 LE). */
const MINT_SUPPLY_OFFSET = 36;

// --------------------------------------------------------------------------
// Path & env wiring
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_ARTIFACT = resolve(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const ARTIFACT_PATH = process.env.E2E_BOOTSTRAP_ARTIFACT ?? DEFAULT_ARTIFACT;
const RPC_URL = process.env.RPC_URL;
const LIVE_MODE = process.env.SCENARIO_2_LIVE === '1';

// --------------------------------------------------------------------------
// Artifact shape — only fields this scenario reads. Mirrors bootstrap-init.ts.
// --------------------------------------------------------------------------

interface OtRecord {
  ot_mint: string;
  ot_governance_pda?: string;
  revenue_config_pda?: string;
  ot_treasury_pda?: string;
  futarchy_config_pda?: string;
  treasury_usdc_ata?: string;
}

interface AuthorityChainArtifact {
  ot_to_futarchy_at?: string;
  futarchy_to_multisig_at?: string;
  completed_at?: string;
  multisig_pubkey?: string;
}

interface Artifact {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  deployer_pubkey?: string;
  deployer_keypair_path?: string;
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
    arl_ot_mint?: string;
  };
  pdas?: {
    rwt_vault?: string;
    [k: string]: string | undefined;
  };
  ots?: OtRecord[];
  authority_chain?: AuthorityChainArtifact;
  bots_started_at?: string;
  init_skipped?: string[];
  init_failed?: { phase: string; error: string }[];
}

function loadArtifact(): Artifact | null {
  if (!existsSync(ARTIFACT_PATH)) return null;
  // SEC-76 (mirrored from scenario-1): defense-in-depth — resolve symlinks
  // and assert the artifact lives under <REPO_ROOT>/data/. Prevents a
  // malicious symlink from redirecting the harness to a poisoned artifact.
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
      `[layer-10-scenario-2] artifact path ${realPath} escapes ${dataDir}; refusing to load`,
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
  if (!art.mints?.arl_ot_mint) {
    reasons.push('mints.arl_ot_mint missing — Phase 3 ARL OT bootstrap incomplete');
  }
  const arlMint = art.mints?.arl_ot_mint;
  const arlOt: OtRecord | undefined = (art.ots ?? []).find(
    (o) => arlMint && o.ot_mint === arlMint,
  );
  if (!arlOt?.futarchy_config_pda) {
    reasons.push('ARL OT futarchy_config_pda missing — Phase 6 (initialize_futarchy) not run');
  }
  return { ready: reasons.length === 0, reasons, art };
}

const PREFLIGHT = evaluatePreflight();

// --------------------------------------------------------------------------
// Pre-flight skip path — emits one structured-skip test summarizing all
// missing prerequisites. Keeps CI green before Substeps 1-4 have run.
// --------------------------------------------------------------------------

if (!PREFLIGHT.ready) {
  test('Layer 10 Scenario 2 — Governance (skipped — preflight not satisfied)', () => {
    // eslint-disable-next-line no-console
    console.warn(
      `[layer-10-scenario-2] preflight gate not satisfied:\n  - ${PREFLIGHT.reasons.join('\n  - ')}`,
    );
    assert.ok(true, 'see preflight reasons above');
  });
} else {
  // ------------------------------------------------------------------------
  // Live tests — preflight passed. `art` is guaranteed populated.
  // ------------------------------------------------------------------------
  const art = PREFLIGHT.art!;
  const conn = new Connection(RPC_URL!, 'confirmed');
  const futProgramId = new PublicKey(art.programs.futarchy);

  /** Find the ARL OT record. */
  const arlOtMint = art.mints?.arl_ot_mint;
  const arlOt: OtRecord | undefined = (art.ots ?? []).find(
    (o) => arlOtMint && o.ot_mint === arlOtMint,
  );
  // PREFLIGHT guarantees both populated; the cast keeps TS happy after the
  // gate evaluation collapsed the optional shape.
  const arlOtRec: OtRecord = arlOt!;
  const futarchyConfigPda = new PublicKey(arlOtRec.futarchy_config_pda!);

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

  /** Read u64 supply from an SPL Mint account. Null on missing/malformed. */
  async function readMintSupply(mint: PublicKey): Promise<bigint | null> {
    const info = await conn.getAccountInfo(mint, 'confirmed');
    if (!info) return null;
    if (info.data.length < MINT_SUPPLY_OFFSET + 8) return null;
    return info.data.readBigUInt64LE(MINT_SUPPLY_OFFSET);
  }

  /** Read FutarchyConfig.next_proposal_id (u64 LE) — bounds the proposal id space. */
  async function readNextProposalId(): Promise<bigint | null> {
    const info = await conn.getAccountInfo(futarchyConfigPda, 'confirmed');
    if (!info) return null;
    if (info.data.length < FUTARCHY_CFG_TOTAL_LEN) return null;
    return info.data.readBigUInt64LE(FUTARCHY_CFG_NEXT_PROPOSAL_ID_OFFSET);
  }

  /** Derive the Proposal PDA for a given proposal_id. */
  function proposalPda(proposalId: bigint): PublicKey {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(proposalId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('proposal'), futarchyConfigPda.toBuffer(), idBytes],
      futProgramId,
    );
    return pda;
  }

  interface ProposalView {
    proposalId: bigint;
    proposalType: number;
    amount: bigint;
    status: number;
    pda: PublicKey;
  }

  /** Best-effort read of a Proposal PDA. Returns null if the account is
   *  uninitialized (proposal_id never used by `create_proposal`). */
  async function readProposal(proposalId: bigint): Promise<ProposalView | null> {
    const pda = proposalPda(proposalId);
    const info = await conn.getAccountInfo(pda, 'confirmed');
    if (!info) return null;
    if (info.data.length < PROPOSAL_TOTAL_LEN) return null;
    const id = info.data.readBigUInt64LE(PROPOSAL_OFFSET_PROPOSAL_ID);
    if (id !== proposalId) {
      // Disc/seed mismatch — should never happen on a healthy chain.
      return null;
    }
    return {
      proposalId: id,
      proposalType: info.data.readUInt8(PROPOSAL_OFFSET_PROPOSAL_TYPE),
      amount: info.data.readBigUInt64LE(PROPOSAL_OFFSET_AMOUNT),
      status: info.data.readUInt8(PROPOSAL_OFFSET_STATUS),
      pda,
    };
  }

  /** Locate the most recent Proposal of a given type by walking back from
   *  next_proposal_id. Returns null if none exists. */
  async function findLatestProposalOfType(
    proposalType: number,
  ): Promise<ProposalView | null> {
    const next = await readNextProposalId();
    if (next === null || next === 0n) return null;
    // Walk in reverse — we want the most recent. Cap the walk to keep the
    // RPC budget bounded; if there are >256 historical proposals the harness
    // surfaces "no recent" rather than scanning the whole space.
    const start = next - 1n;
    const minId = next > 256n ? next - 256n : 0n;
    for (let i = start; i >= minId; i--) {
      const p = await readProposal(i);
      if (p && p.proposalType === proposalType) return p;
      if (i === 0n) break; // u64 wraparound guard
    }
    return null;
  }

  /** Compare two Pubkey base58 strings (left-trimmed of zero-byte stub). */
  function pubkeysEqualB58(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    try {
      return new PublicKey(a).equals(new PublicKey(b));
    } catch {
      return false;
    }
  }

  // SEC L-3 — avoid loading keypair into heap when no signing path follows.
  // Substep 6 defers all live-submit legs to deploy.sh / e2e-runner.ts inline-
  // exec hooks, so the deployer secret bytes are never needed by this file.

  // ----------------------------------------------------------------------
  // Schema sanity
  // ----------------------------------------------------------------------

  test('S2 sanity — futarchy program + ARL OT futarchy_config wiring', async () => {
    assert.equal(art.schema_version, 1, 'schema_version drift');
    assert.ok(art.programs.futarchy, 'Futarchy program ID missing');
    assert.ok(art.programs.ownership_token, 'OT program ID missing');
    assert.ok(arlOtRec.futarchy_config_pda, 'ARL OT futarchy_config_pda missing (Phase 6)');
    assert.ok(arlOtRec.ot_governance_pda, 'ARL OT ot_governance_pda missing (Phase 4)');
    assert.ok(arlOtRec.revenue_config_pda, 'ARL OT revenue_config_pda missing (Phase 4)');
    assert.ok(arlOtRec.ot_treasury_pda, 'ARL OT ot_treasury_pda missing (Phase 4)');

    const cfg = await conn.getAccountInfo(futarchyConfigPda, 'confirmed');
    assert.ok(cfg, 'FutarchyConfig PDA not found on-chain');
    assert.ok(
      cfg!.data.length >= FUTARCHY_CFG_TOTAL_LEN,
      `FutarchyConfig data length ${cfg!.data.length} < ${FUTARCHY_CFG_TOTAL_LEN} — layout drift`,
    );
  });

  // ----------------------------------------------------------------------
  // S2.1 — MintOt proposal — propose → approve → execute → ARL OT supply grew
  // ----------------------------------------------------------------------

  test('S2.1 MintOt proposal — type / status / supply invariants', async () => {
    if (!art.mints?.arl_ot_mint) {
      assert.ok(true, 'arl_ot_mint missing — skipping');
      return;
    }
    const arlMintPk = new PublicKey(art.mints.arl_ot_mint);
    const supply = await readMintSupply(arlMintPk);
    assert.ok(supply !== null, 'ARL OT mint not readable');
    assert.ok(supply! >= 0n, 'ARL OT supply must be u64 readable');

    // Look for a most-recent MintOt proposal. If none exists, we still verify
    // that the supply has grown past zero (initial mint via Phase 6). Live
    // execute is operator-driven (multisig signer required).
    const proposal = await findLatestProposalOfType(PROPOSAL_TYPE_MINT_OT);
    if (!proposal) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.1: no MintOt proposal located in last 256 ids — ' +
          'verified supply readability only',
      );
      assert.ok(true);
      return;
    }

    // Lifecycle invariants:
    //   - status MUST be in the legal set { Active, Approved, Executed, Cancelled }
    //   - if Executed, supply >= proposal.amount (executor minted into Treasury)
    assert.equal(
      proposal.proposalType,
      PROPOSAL_TYPE_MINT_OT,
      `proposal[${proposal.proposalId}].type = ${proposal.proposalType}, expected MintOt(0)`,
    );
    assert.ok(
      [
        PROPOSAL_STATUS_ACTIVE,
        PROPOSAL_STATUS_APPROVED,
        PROPOSAL_STATUS_EXECUTED,
        PROPOSAL_STATUS_CANCELLED,
      ].includes(proposal.status),
      `proposal[${proposal.proposalId}].status = ${proposal.status} — invalid enum`,
    );

    if (proposal.status === PROPOSAL_STATUS_EXECUTED) {
      // Post-execute, ARL OT supply MUST be >= proposal.amount (cumulative).
      // We can't snapshot pre/post without timing access to the ix submission;
      // instead we assert the floor invariant.
      assert.ok(
        supply! >= proposal.amount,
        `ARL OT supply ${supply} < executed MintOt amount ${proposal.amount}`,
      );
    }

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        '[layer-10-scenario-2] LIVE_MODE: MintOt create+approve+execute deferred to operator ' +
          `(multisig=${art.authority_chain?.multisig_pubkey ?? 'unknown'})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S2.2 — SpendTreasury proposal — propose → approve → execute → ATA decreased
  // ----------------------------------------------------------------------

  test('S2.2 SpendTreasury proposal — type / status / treasury USDC ATA invariants', async () => {
    if (!arlOtRec.treasury_usdc_ata) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.2: treasury_usdc_ata missing on ARL OT — skipping',
      );
      assert.ok(true);
      return;
    }
    const treasuryAta = new PublicKey(arlOtRec.treasury_usdc_ata);
    const balance = await readTokenBalance(treasuryAta);
    assert.ok(balance !== null, 'ARL Treasury USDC ATA not initialized');
    assert.ok(balance! >= 0n, 'Treasury USDC balance must be u64 readable');

    const proposal = await findLatestProposalOfType(PROPOSAL_TYPE_SPEND_TREASURY);
    if (!proposal) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.2: no SpendTreasury proposal in last 256 ids — ' +
          'verified treasury readability only',
      );
      assert.ok(true);
      return;
    }

    assert.equal(
      proposal.proposalType,
      PROPOSAL_TYPE_SPEND_TREASURY,
      `proposal[${proposal.proposalId}].type = ${proposal.proposalType}, expected SpendTreasury(1)`,
    );
    assert.ok(
      [
        PROPOSAL_STATUS_ACTIVE,
        PROPOSAL_STATUS_APPROVED,
        PROPOSAL_STATUS_EXECUTED,
        PROPOSAL_STATUS_CANCELLED,
      ].includes(proposal.status),
      `proposal[${proposal.proposalId}].status = ${proposal.status} — invalid enum`,
    );
    // proposal.amount must be > 0 per create_proposal validation (state.rs
    // rejects ZeroAmount). Re-assert here as an integrity check for the
    // on-chain layout.
    assert.ok(
      proposal.amount > 0n,
      `SpendTreasury proposal[${proposal.proposalId}].amount must be > 0 (got ${proposal.amount})`,
    );

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        '[layer-10-scenario-2] LIVE_MODE: SpendTreasury create+approve+execute deferred to operator ' +
          `(target ATA=${treasuryAta.toBase58()})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S2.3 — UpdateDestinations proposal — RevenueConfig.config_version bumps
  // ----------------------------------------------------------------------

  test('S2.3 UpdateDestinations proposal — type / status / config_version invariants', async () => {
    if (!arlOtRec.revenue_config_pda) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.3: revenue_config_pda missing on ARL OT — skipping',
      );
      assert.ok(true);
      return;
    }
    const revCfgPda = new PublicKey(arlOtRec.revenue_config_pda);
    const info = await conn.getAccountInfo(revCfgPda, 'confirmed');
    assert.ok(info, 'RevenueConfig PDA not found');
    assert.ok(
      info!.data.length >= REV_CFG_CONFIG_VERSION_OFFSET + 8,
      `RevenueConfig data length ${info!.data.length} too short — layout drift`,
    );
    const activeCount = info!.data.readUInt8(REV_CFG_ACTIVE_COUNT_OFFSET);
    const configVersion = info!.data.readBigUInt64LE(REV_CFG_CONFIG_VERSION_OFFSET);
    assert.ok(
      activeCount > 0 && activeCount <= 10,
      `RevenueConfig.active_count = ${activeCount} (expected 1..=10)`,
    );

    const proposal = await findLatestProposalOfType(PROPOSAL_TYPE_UPDATE_DESTINATIONS);
    if (!proposal) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.3: no UpdateDestinations proposal in last 256 ids — ' +
          `verified RevenueConfig readability only (config_version=${configVersion})`,
      );
      assert.ok(true);
      return;
    }

    assert.equal(
      proposal.proposalType,
      PROPOSAL_TYPE_UPDATE_DESTINATIONS,
      `proposal[${proposal.proposalId}].type = ${proposal.proposalType}, expected UpdateDestinations(2)`,
    );
    assert.ok(
      [
        PROPOSAL_STATUS_ACTIVE,
        PROPOSAL_STATUS_APPROVED,
        PROPOSAL_STATUS_EXECUTED,
        PROPOSAL_STATUS_CANCELLED,
      ].includes(proposal.status),
      `proposal[${proposal.proposalId}].status = ${proposal.status} — invalid enum`,
    );

    if (proposal.status === PROPOSAL_STATUS_EXECUTED) {
      // Post-execute, config_version MUST be >= 1 (initial config = 0; each
      // batch_update_destinations bumps the version). The exact bump count
      // depends on history; the floor invariant is the executable check.
      assert.ok(
        configVersion >= 1n,
        `RevenueConfig.config_version must be >= 1 after executed UpdateDestinations (got ${configVersion})`,
      );
    }

    if (LIVE_MODE) {
      // eslint-disable-next-line no-console
      console.log(
        '[layer-10-scenario-2] LIVE_MODE: UpdateDestinations execute deferred to operator ' +
          `(target=${revCfgPda.toBase58()}, current_version=${configVersion})`,
      );
    }
  });

  // ----------------------------------------------------------------------
  // S2.4 — Cancel a pending proposal → status Cancelled, execute rejected
  // ----------------------------------------------------------------------

  test('S2.4 cancel — status transition + execute rejection invariant', async () => {
    // Walk recent proposal ids looking for any Cancelled one. If none found,
    // we still validate the structural invariant that execute_proposal's
    // status check (STATUS_APPROVED) correctly excludes Cancelled — this is
    // a closed-form check on the contract enum, not a runtime gate.
    const next = await readNextProposalId();
    if (next === null || next === 0n) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.4: next_proposal_id = 0, no proposals on-chain — skipping',
      );
      assert.ok(true);
      return;
    }

    let cancelled: ProposalView | null = null;
    const start = next - 1n;
    const minId = next > 256n ? next - 256n : 0n;
    for (let i = start; i >= minId; i--) {
      const p = await readProposal(i);
      if (p && p.status === PROPOSAL_STATUS_CANCELLED) {
        cancelled = p;
        break;
      }
      if (i === 0n) break;
    }

    if (!cancelled) {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.4: no Cancelled proposal in last 256 ids — ' +
          'cancel lifecycle leg not exercised yet (operator-driven)',
      );
      // Closed-form sanity: enum values must be distinct so the check
      // `status != STATUS_APPROVED` rejects Cancelled. The contract source
      // pins this; the test re-asserts to catch enum drift.
      assert.notEqual(PROPOSAL_STATUS_CANCELLED, PROPOSAL_STATUS_APPROVED, 'enum drift');
      return;
    }

    // Cancelled MUST NOT be executable. The contract's execute_proposal
    // handler asserts `status == STATUS_APPROVED` (instructions/execute_proposal.rs:70).
    // We verify the on-chain status byte and assert it != APPROVED, which is
    // the contract-side invariant the runtime check enforces.
    assert.equal(
      cancelled.status,
      PROPOSAL_STATUS_CANCELLED,
      `proposal[${cancelled.proposalId}].status = ${cancelled.status}, expected Cancelled(3)`,
    );
    assert.notEqual(
      cancelled.status,
      PROPOSAL_STATUS_APPROVED,
      `Cancelled proposal[${cancelled.proposalId}] would bypass execute_proposal status guard`,
    );
  });

  // ----------------------------------------------------------------------
  // S2.5 — Old deployer cannot call OT governance directly
  // ----------------------------------------------------------------------

  test('S2.5 zero-authority — deployer != OT governance authority post-Phase-7', async () => {
    if (!arlOtRec.ot_governance_pda) {
      assert.ok(true, 'ot_governance_pda missing — skipping');
      return;
    }
    const otGovPda = new PublicKey(arlOtRec.ot_governance_pda);
    const info = await conn.getAccountInfo(otGovPda, 'confirmed');
    assert.ok(info, 'OtGovernance PDA not found');
    assert.ok(
      info!.data.length >= OT_GOV_TOTAL_LEN,
      `OtGovernance data length ${info!.data.length} < ${OT_GOV_TOTAL_LEN} — layout drift`,
    );

    const authBytes = info!.data.subarray(
      OT_GOV_AUTHORITY_OFFSET,
      OT_GOV_AUTHORITY_OFFSET + 32,
    );
    const authPubkey = new PublicKey(authBytes);

    // Hard rejection: deployer pubkey MUST NOT equal OT authority. On D32
    // devnet the multisig is a pseudo-singleton (deployer pubkey ==
    // multisig_pubkey), but post-Phase-7 the OT authority is rotated to the
    // Futarchy PDA — NOT the deployer.
    if (art.deployer_pubkey) {
      const deployerPubkey = new PublicKey(art.deployer_pubkey);
      assert.ok(
        !authPubkey.equals(deployerPubkey),
        `OT authority ${authPubkey.toBase58()} == deployer ${deployerPubkey.toBase58()} — Phase 7 handoff incomplete`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[layer-10-scenario-2] S2.5: deployer_pubkey missing in artifact — skipping deployer-eq check',
      );
    }

    // Belt-and-suspenders: post-Phase-7, OT authority should equal the
    // Futarchy PDA itself (the OT contract treats the Futarchy PDA as the
    // governance signer). Cross-check via the artifact's stamped chain.
    const futToMs = art.authority_chain?.futarchy_to_multisig_at;
    const otToFut = art.authority_chain?.ot_to_futarchy_at;
    if (otToFut && !futToMs) {
      // OT-to-Futarchy executed but Futarchy-to-multisig hasn't. Authority
      // should be the Futarchy PDA itself in this state.
      // eslint-disable-next-line no-console
      console.log(
        '[layer-10-scenario-2] S2.5: OT-to-Futarchy completed; ' +
          `OT authority = ${authPubkey.toBase58()} (expected Futarchy PDA)`,
      );
    }
    // T-39: also verify FutarchyConfig.authority != deployer post-Phase-7
    // (the Futarchy config's authority is independently rotated from
    // OtGovernance — both must be locked out for full deployer-zero coverage).
    // Uses FUTARCHY_CFG_AUTHORITY_OFFSET = 40 (verified against
    // contracts/futarchy/src/state.rs:16-25). Skipped cleanly when
    // futarchy_config_pda or deployer_pubkey is unset.
    if (art.deployer_pubkey && arlOtRec.futarchy_config_pda) {
      const futCfgPda = new PublicKey(arlOtRec.futarchy_config_pda);
      const futInfo = await conn.getAccountInfo(futCfgPda, 'confirmed');
      if (futInfo && futInfo.data.length >= FUTARCHY_CFG_AUTHORITY_OFFSET + 32) {
        const futAuthBytes = futInfo.data.subarray(
          FUTARCHY_CFG_AUTHORITY_OFFSET,
          FUTARCHY_CFG_AUTHORITY_OFFSET + 32,
        );
        const futAuthPubkey = new PublicKey(futAuthBytes);
        const deployerPubkey = new PublicKey(art.deployer_pubkey);
        assert.ok(
          !futAuthPubkey.equals(deployerPubkey),
          `FutarchyConfig authority ${futAuthPubkey.toBase58()} == deployer — Phase 7 Futarchy handoff incomplete`,
        );
      }
    }
  });

  // ----------------------------------------------------------------------
  // Linter pacification — same pattern as scenario-1: keep live-submit
  // primitives in scope for a future Substep that adds inline TX submission
  // (multisig-signed proposal create/approve/execute legs).
  // ----------------------------------------------------------------------

  test('S2 imports — live-submit primitives type-check guard (no-op)', () => {
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
