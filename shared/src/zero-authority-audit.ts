/*
 * zero-authority-audit.ts — shared helper for the post-Phase-7 authority
 * cross-contract assertion (Layer 10 substep 3 + substep 8 + substep 10
 * cross-contract audit).
 *
 * SEC-35 (2026-04-28): semantic shift from "deployer != on-chain authority"
 * to "expected target == on-chain authority". The new top-level helper is
 * `assertAuthorityChainComplete(conn, opts, art)` — it asserts each contract
 * is at its expected target. The legacy `assertDeployerZeroAuthority` is now
 * a thin wrapper that asserts the deployer key is NOT the authority anywhere
 * (the dual / negative twin), preserved as a sanity check and for the
 * pre-Phase-7 R-B-style precheck callers.
 *
 * Why the change:
 *   On devnet (D32) the multisig is the deployer keypair acting as a single-sig
 *   surrogate. After all 5 rotations complete, the on-chain authority IS the
 *   deployer key — which made the old `!= deployer` rule reject a successful
 *   devnet rehearsal. The new "== expected" rule passes devnet (expected ==
 *   deployer for D32) and remains strict on mainnet (expected != deployer
 *   becomes a CONSEQUENCE, enforced upstream by the SEC-34 input check).
 *
 * Cross-coverage (R-G mitigation):
 *   The same helper is consumed by:
 *     1. transfer-authority.ts        — final post-Phase-7 verification log.
 *     2. layer-10-scenario-6 test     — closing assertion (substep 8).
 *     3. scripts/verify-deployment.sh — audit checklist (substep 10).
 *   If any one consumer reads the wrong field offset, the cross-coverage
 *   surfaces the discrepancy as a mismatch between the helper's verdict and
 *   the consumer's own readings.
 *
 * Returns `{ ok, checks, mismatches }` so callers decide how to react. The
 * helper deliberately does NOT throw — Scenario 6 wants a soft verdict for
 * its assertion library; the deploy-time consumer wraps a throw.
 *
 * Verified field byte offsets (cross-checked against contracts/<x>/src/state.rs
 * via the SEC-19/20/22/23 audit notes already shipped in bootstrap-init.ts):
 *
 *   OtGovernance       discriminator(8) + ot_mint(32)           + authority @40
 *   FutarchyConfig     discriminator(8) + ot_mint(32)           + authority @40
 *   DexConfig          discriminator(8)                          + authority @8
 *   RwtVault           discriminator(8) + total_invested_capital(16)
 *                       + total_rwt_supply(8) + nav_book_value(8)
 *                       + capital_accumulator_ata(32) + rwt_mint(32) + authority @104
 *   DistributionConfig discriminator(8)                          + authority @8
 *
 * Each offset already includes the 8-byte Anchor-style discriminator. No
 * "minus 8" adjustments at call site.
 */

import { Connection, PublicKey } from '@solana/web3.js';

// --------------------------------------------------------------------------
// Verified authority field offsets — cross-checked against contracts/*/src/state.rs.
// All offsets are absolute (include the 8-byte discriminator).
// --------------------------------------------------------------------------

/**
 * OtGovernance layout:
 *   0..8     discriminator      [u8; 8]
 *   8..40    ot_mint            [u8; 32]
 *   40..72   authority          [u8; 32]   ← target
 *   72..104  pending_authority  [u8; 32]
 *   104..105 has_pending        bool
 */
const OT_GOVERNANCE_AUTHORITY_OFFSET = 40;

/**
 * FutarchyConfig layout (mirrors OtGovernance for the auth triple):
 *   0..8     discriminator      [u8; 8]
 *   8..40    ot_mint            [u8; 32]
 *   40..72   authority          [u8; 32]   ← target
 *   72..104  pending_authority  [u8; 32]
 *   104..105 has_pending        bool
 */
const FUTARCHY_CONFIG_AUTHORITY_OFFSET = 40;

/**
 * DexConfig layout:
 *   0..8     discriminator      [u8; 8]
 *   8..40    authority          [u8; 32]   ← target
 *   40..72   pending_authority  [u8; 32]
 *   72..73   has_pending        bool
 *   73..105  pause_authority    [u8; 32]
 *   ...
 */
const DEX_CONFIG_AUTHORITY_OFFSET = 8;

/**
 * RwtVault layout (verified by SEC-20 in bootstrap-init.ts:2300-2316):
 *   0..8      discriminator              [u8; 8]
 *   8..24     total_invested_capital     u128 (16 bytes)
 *   24..32    total_rwt_supply           u64
 *   32..40    nav_book_value             u64
 *   40..72    capital_accumulator_ata    [u8; 32]
 *   72..104   rwt_mint                   [u8; 32]
 *   104..136  authority                  [u8; 32]   ← target
 *   136..168  pending_authority          [u8; 32]
 *   168..169  has_pending                bool
 */
const RWT_VAULT_AUTHORITY_OFFSET = 104;

/**
 * DistributionConfig layout (verified by SEC-22 in bootstrap-init.ts:2452-2459):
 *   0..8     discriminator        [u8; 8]
 *   8..40    authority            [u8; 32]   ← target
 *   40..72   pending_authority    [u8; 32]
 *   72..73   has_pending          bool
 *   73..105  publish_authority    [u8; 32]
 *   ...
 */
const DISTRIBUTION_CONFIG_AUTHORITY_OFFSET = 8;

const AUTHORITY_FIELD_SIZE = 32;

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * Minimal artifact shape consumed by this helper. Mirrors the subset of
 * bootstrap-init.ts's `Artifact` interface that the audit needs. Defined
 * locally so this module has zero coupling to bootstrap-init.ts internals.
 */
export interface ZeroAuthorityArtifact {
  ots?: Array<{
    ot_mint: string;
    ot_governance_pda: string;
    futarchy_config_pda?: string;
  }>;
  pdas?: {
    dex_config?: string;
    rwt_vault?: string;
    yd_dist_config?: string;
  };
}

/** Contract label used across the helper's verdict lines. */
export type AuthorityContract = 'OT' | 'Futarchy' | 'RWT' | 'DEX' | 'YD';

/** One per-contract verdict line, returned for telemetry + logging. */
export interface ContractAuthorityCheck {
  /** Short label used in logs and the mismatches[] return list. */
  contract: AuthorityContract;
  /** PDA address (or governance address for OT) read for this check. */
  pdaAddress: string;
  /** True if the on-chain authority field matches the expected target. */
  ok: boolean;
  /** Reason for failure (skipped, missing PDA, mismatch, etc.). */
  detail: string;
  /** On-chain authority bytes decoded as a base58 pubkey, when readable. */
  onChainAuthority?: string;
  /** Expected authority for this contract (base58), when applicable. */
  expectedAuthority?: string;
}

/** Aggregate result returned by the audit helpers. */
export interface ZeroAuthorityResult {
  /** True iff every contract returned ok=true. */
  ok: boolean;
  /** Per-contract verdicts in fixed order: OT, Futarchy, RWT, DEX, YD. */
  checks: ContractAuthorityCheck[];
  /** Convenience list of contract labels that failed. */
  mismatches: string[];
}

/**
 * Inputs to `assertAuthorityChainComplete`. The helper resolves the expected
 * target per-contract:
 *   OT       → futarchyConfigPda  (Step 1+2 of D31; OT goes to Futarchy first)
 *   Futarchy → multisigPubkey
 *   RWT      → multisigPubkey
 *   DEX      → multisigPubkey
 *   YD       → multisigPubkey
 */
export interface AuthorityChainTargets {
  multisigPubkey: PublicKey;
  /**
   * Optional override — if not provided, derived from `art.ots[0].futarchy_config_pda`.
   * Provided explicitly by transfer-authority.ts so the audit reads exactly the
   * Futarchy PDA that Phase 7 rotated to.
   */
  futarchyConfigPda?: PublicKey;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

interface ReadAuthoritySpec {
  contract: AuthorityContract;
  /** Which field of the artifact yields this PDA (for diagnostics). */
  artifactField: string;
  /** PDA pubkey base58 string — null if missing in artifact. */
  pdaBase58: string | null;
  /** Byte offset of the 32-byte authority field, including discriminator. */
  authorityOffset: number;
  /** Expected authority for this contract (base58), or null if not applicable. */
  expectedAuthorityB58: string | null;
}

/**
 * Read the authority field at a given offset and compare it to the expected
 * target. Returns a verdict with `detail` populated on every path so log
 * output is uniform across success / skip / mismatch.
 *
 * `mode === 'positive'` — ok iff on-chain authority == expected.
 * `mode === 'negative'` — ok iff on-chain authority != expected (deployer-zero check).
 */
async function readAuthorityCheck(
  conn: Connection,
  spec: ReadAuthoritySpec,
  mode: 'positive' | 'negative',
): Promise<ContractAuthorityCheck> {
  if (!spec.pdaBase58) {
    return {
      contract: spec.contract,
      pdaAddress: '<missing>',
      ok: false,
      detail: `artifact.${spec.artifactField} is empty — bootstrap incomplete`,
      ...(spec.expectedAuthorityB58 ? { expectedAuthority: spec.expectedAuthorityB58 } : {}),
    };
  }

  let pda: PublicKey;
  try {
    pda = new PublicKey(spec.pdaBase58);
  } catch {
    return {
      contract: spec.contract,
      pdaAddress: spec.pdaBase58,
      ok: false,
      detail: `artifact.${spec.artifactField} is not a valid base58 pubkey`,
      ...(spec.expectedAuthorityB58 ? { expectedAuthority: spec.expectedAuthorityB58 } : {}),
    };
  }

  // A-85: align commitment with Substep 8 S6.10 inline NEGATIVE check
  // (`bots/.e2e/layer-10-scenario-6-emergency.test.ts::checkAuthorityNotDeployer`).
  // Both consumers MUST read the same view of chain state for R-G dual-proof
  // semantics to hold; a transient mismatch would surface as a false-positive
  // verdict divergence on a slow validator.
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) {
    return {
      contract: spec.contract,
      pdaAddress: pda.toBase58(),
      ok: false,
      detail: 'on-chain account not found',
      ...(spec.expectedAuthorityB58 ? { expectedAuthority: spec.expectedAuthorityB58 } : {}),
    };
  }

  const minSize = spec.authorityOffset + AUTHORITY_FIELD_SIZE;
  if (info.data.length < minSize) {
    return {
      contract: spec.contract,
      pdaAddress: pda.toBase58(),
      ok: false,
      detail: `account data too small (${info.data.length} bytes, need >= ${minSize})`,
      ...(spec.expectedAuthorityB58 ? { expectedAuthority: spec.expectedAuthorityB58 } : {}),
    };
  }

  const authorityBytes = info.data.subarray(
    spec.authorityOffset,
    spec.authorityOffset + AUTHORITY_FIELD_SIZE,
  );
  const onChainAuthorityB58 = new PublicKey(authorityBytes).toBase58();

  if (!spec.expectedAuthorityB58) {
    // Defensive: a positive-mode caller forgot to supply an expected target.
    // This shouldn't happen via the public API; surface it as a hard failure
    // so the bug is loud rather than silently passing.
    return {
      contract: spec.contract,
      pdaAddress: pda.toBase58(),
      ok: false,
      detail: 'expected authority not provided to audit helper (internal bug)',
      onChainAuthority: onChainAuthorityB58,
    };
  }

  const expectedB58 = spec.expectedAuthorityB58;
  const matches = onChainAuthorityB58 === expectedB58;

  if (mode === 'positive') {
    if (matches) {
      return {
        contract: spec.contract,
        pdaAddress: pda.toBase58(),
        ok: true,
        detail: `authority == expected (${expectedB58})`,
        onChainAuthority: onChainAuthorityB58,
        expectedAuthority: expectedB58,
      };
    }
    return {
      contract: spec.contract,
      pdaAddress: pda.toBase58(),
      ok: false,
      detail: `authority mismatch: on-chain=${onChainAuthorityB58}, expected=${expectedB58}`,
      onChainAuthority: onChainAuthorityB58,
      expectedAuthority: expectedB58,
    };
  }

  // negative mode — ok iff on-chain authority != expected (deployer-zero).
  if (matches) {
    return {
      contract: spec.contract,
      pdaAddress: pda.toBase58(),
      ok: false,
      detail: `authority is still ${expectedB58} — Phase 7 incomplete (deployer-zero violation)`,
      onChainAuthority: onChainAuthorityB58,
      expectedAuthority: expectedB58,
    };
  }
  return {
    contract: spec.contract,
    pdaAddress: pda.toBase58(),
    ok: true,
    detail: `authority rotated away from ${expectedB58} (now ${onChainAuthorityB58})`,
    onChainAuthority: onChainAuthorityB58,
    expectedAuthority: expectedB58,
  };
}

// --------------------------------------------------------------------------
// Public API — POSITIVE check (SEC-35)
// --------------------------------------------------------------------------

/**
 * Assert the on-chain authority of every Areal contract MATCHES its expected
 * post-Phase-7 target. Reads each contract's authority field via an
 * independent `getAccountInfo` call.
 *
 * Per-contract expected target:
 *   OT       → futarchyConfigPda  (D31 Step 1+2 — OT goes to Futarchy)
 *   Futarchy → multisigPubkey
 *   RWT      → multisigPubkey
 *   DEX      → multisigPubkey
 *   YD       → multisigPubkey
 *
 * On devnet (D32 pseudo-multisig) `multisigPubkey === deployerPubkey`; the
 * audit still passes because the rule is "== expected" not "!= deployer".
 *
 * On mainnet `multisigPubkey != deployerPubkey` is enforced upstream by the
 * SEC-34 input gate in transfer-authority.ts; deployer-zero-authority becomes
 * a CONSEQUENCE rather than an axiom.
 *
 * Returns a structured result; never throws on assertion failure. Callers
 * decide whether to throw or log on `result.ok === false`.
 */
export async function assertAuthorityChainComplete(
  conn: Connection,
  opts: AuthorityChainTargets,
  art: ZeroAuthorityArtifact,
): Promise<ZeroAuthorityResult> {
  const arlOt = Array.isArray(art.ots) && art.ots.length > 0 ? art.ots[0] : null;
  const futarchyConfigPda =
    opts.futarchyConfigPda ??
    (arlOt?.futarchy_config_pda ? new PublicKey(arlOt.futarchy_config_pda) : null);

  const multisigB58 = opts.multisigPubkey.toBase58();
  const futarchyB58 = futarchyConfigPda ? futarchyConfigPda.toBase58() : null;

  const specs: ReadAuthoritySpec[] = [
    {
      contract: 'OT',
      artifactField: 'ots[0].ot_governance_pda',
      pdaBase58: arlOt?.ot_governance_pda ?? null,
      authorityOffset: OT_GOVERNANCE_AUTHORITY_OFFSET,
      expectedAuthorityB58: futarchyB58,
    },
    {
      contract: 'Futarchy',
      artifactField: 'ots[0].futarchy_config_pda',
      pdaBase58: arlOt?.futarchy_config_pda ?? null,
      authorityOffset: FUTARCHY_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: multisigB58,
    },
    {
      contract: 'RWT',
      artifactField: 'pdas.rwt_vault',
      pdaBase58: art.pdas?.rwt_vault ?? null,
      authorityOffset: RWT_VAULT_AUTHORITY_OFFSET,
      expectedAuthorityB58: multisigB58,
    },
    {
      contract: 'DEX',
      artifactField: 'pdas.dex_config',
      pdaBase58: art.pdas?.dex_config ?? null,
      authorityOffset: DEX_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: multisigB58,
    },
    {
      contract: 'YD',
      artifactField: 'pdas.yd_dist_config',
      pdaBase58: art.pdas?.yd_dist_config ?? null,
      authorityOffset: DISTRIBUTION_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: multisigB58,
    },
  ];

  const checks: ContractAuthorityCheck[] = [];
  for (const spec of specs) {
    // 5 independent getAccountInfo calls — sequential by design so log lines
    // appear in the same order callers expect (R-G cross-coverage relies on
    // OT, Futarchy, RWT, DEX, YD ordering).
    const check = await readAuthorityCheck(conn, spec, 'positive');
    checks.push(check);
  }

  const mismatches = checks.filter((c) => !c.ok).map((c) => c.contract);
  return {
    ok: mismatches.length === 0,
    checks,
    mismatches,
  };
}

// --------------------------------------------------------------------------
// Public API — NEGATIVE check (deployer-zero-authority dual / sanity twin)
// --------------------------------------------------------------------------

/**
 * Assert the deployer key is NOT the on-chain authority of any of the five
 * Areal contracts — the dual of `assertAuthorityChainComplete`.
 *
 * Use cases:
 *   1. Pre-Phase-7 R-B-style sanity check (SEC-42) — defense-in-depth that
 *      the deployer IS still the authority on every contract before we start
 *      the rotation. Caller inverts the result: ok=true here means deployer
 *      has no authority anywhere, which would indicate Phase 7 already ran.
 *   2. Scenario 6 "emergency" closing assertion — operators want to confirm
 *      the deployer has zero on-chain power post-Phase-7.
 *
 * Returns `ok=true` iff the deployer is NOT the authority on any contract
 * (i.e., zero deployer-controlled contracts remain).
 */
export async function assertDeployerHasNoAuthority(
  conn: Connection,
  deployerPubkey: PublicKey,
  art: ZeroAuthorityArtifact,
): Promise<ZeroAuthorityResult> {
  const arlOt = Array.isArray(art.ots) && art.ots.length > 0 ? art.ots[0] : null;
  const deployerB58 = deployerPubkey.toBase58();

  const specs: ReadAuthoritySpec[] = [
    {
      contract: 'OT',
      artifactField: 'ots[0].ot_governance_pda',
      pdaBase58: arlOt?.ot_governance_pda ?? null,
      authorityOffset: OT_GOVERNANCE_AUTHORITY_OFFSET,
      expectedAuthorityB58: deployerB58,
    },
    {
      contract: 'Futarchy',
      artifactField: 'ots[0].futarchy_config_pda',
      pdaBase58: arlOt?.futarchy_config_pda ?? null,
      authorityOffset: FUTARCHY_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: deployerB58,
    },
    {
      contract: 'RWT',
      artifactField: 'pdas.rwt_vault',
      pdaBase58: art.pdas?.rwt_vault ?? null,
      authorityOffset: RWT_VAULT_AUTHORITY_OFFSET,
      expectedAuthorityB58: deployerB58,
    },
    {
      contract: 'DEX',
      artifactField: 'pdas.dex_config',
      pdaBase58: art.pdas?.dex_config ?? null,
      authorityOffset: DEX_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: deployerB58,
    },
    {
      contract: 'YD',
      artifactField: 'pdas.yd_dist_config',
      pdaBase58: art.pdas?.yd_dist_config ?? null,
      authorityOffset: DISTRIBUTION_CONFIG_AUTHORITY_OFFSET,
      expectedAuthorityB58: deployerB58,
    },
  ];

  const checks: ContractAuthorityCheck[] = [];
  for (const spec of specs) {
    const check = await readAuthorityCheck(conn, spec, 'negative');
    checks.push(check);
  }

  const mismatches = checks.filter((c) => !c.ok).map((c) => c.contract);
  return {
    ok: mismatches.length === 0,
    checks,
    mismatches,
  };
}

/**
 * @deprecated Use `assertAuthorityChainComplete` (positive check) for
 *   post-Phase-7 verification, or `assertDeployerHasNoAuthority` (negative
 *   check) for the deployer-zero-authority dual / sanity twin.
 *
 * Backward-compat shim — preserves the original API for Scenario 6 and
 * substep 8 import paths. Forwards to `assertDeployerHasNoAuthority`.
 */
export async function assertDeployerZeroAuthority(
  conn: Connection,
  deployerPubkey: PublicKey,
  art: ZeroAuthorityArtifact,
): Promise<ZeroAuthorityResult> {
  return assertDeployerHasNoAuthority(conn, deployerPubkey, art);
}
