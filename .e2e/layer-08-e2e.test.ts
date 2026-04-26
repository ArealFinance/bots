/**
 * Layer 8 §12 — full yield-flow E2E.
 *
 * Scenario (assertions reflect docs/contracts/yield-distribution.mdx §flow
 * and architecture §12):
 *
 *   1. Setup
 *      - Test-validator running with all 5 programs deployed.
 *      - Singleton DistributionConfig (YD), RwtVault + RwtDistributionConfig
 *        (RWT), DEX Config, OT collection (state.is_active=true).
 *      - One test OT mint + a MerkleDistributor for it.
 *      - LiquidityHolding singleton initialized.
 *      - Master RWT/USDC pool seeded.
 *
 *   2. Seed Accumulator USDC ATA (mock revenue).
 *
 *   3. Run revenue-crank tick (or invoke `OT::distribute_revenue` directly).
 *      Assert: RevenueDistributed event emitted; Accumulator USDC balance
 *      visible.
 *
 *   4. Run convert-and-fund-crank tick → submits `YD::convert_to_rwt`.
 *      Assert: StreamConverted event emitted; reward_vault RWT balance
 *      increased; protocol fee transferred.
 *
 *   5. Merkle Publisher detects StreamConverted → builds tree → publishes
 *      root via `YD::publish_root`.
 *      Assert: MerkleDistributor.merkle_root != zero; epoch incremented.
 *
 *   6. Run yield-claim-crank tick → invokes:
 *      - `OT::claim_yd_for_treasury` (treasury gets its share).
 *      - `RWT::claim_yield` (vault claims, splits 70/15/15).
 *      - `DEX::compound_yield` (pool compounds yield).
 *
 *   7. Verify:
 *      - NAV (RwtVault.nav_book_value) updated.
 *      - LP shares unchanged (compound is "phantom buy" — no LP mint).
 *      - Treasury OT RWT ATA balance increased by treasury_share.
 *      - LiquidityHolding.total_received increased by liquidity_share (15%).
 *      - Pool reserve_a or reserve_b increased by compound amount.
 *
 * STATUS: scaffolded. Full assertion table is left for the Layer 9 polish
 * cycle when the bootstrap script (`scripts/e2e-bootstrap.sh`, TBD) lands.
 * The current file documents the scenario structure and provides a runnable
 * harness that exits early with a clear "scenario not yet wired" message
 * unless the bootstrap state is detected.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL;
const YD_PROGRAM_ID = process.env.YD_PROGRAM_ID;
const RWT_ENGINE_PROGRAM_ID = process.env.RWT_ENGINE_PROGRAM_ID;
const DEX_PROGRAM_ID = process.env.DEX_PROGRAM_ID;
const OT_PROGRAM_ID = process.env.OT_PROGRAM_ID;

const ENV_OK =
  Boolean(RPC_URL) &&
  Boolean(YD_PROGRAM_ID) &&
  Boolean(RWT_ENGINE_PROGRAM_ID) &&
  Boolean(DEX_PROGRAM_ID) &&
  Boolean(OT_PROGRAM_ID);

if (!ENV_OK) {
  test('Layer 8 E2E (skipped — env not set)', () => {
    assert.ok(
      true,
      'set RPC_URL + program-id env vars (see bots/.e2e/README.md) to run E2E',
    );
  });
} else {
  test('Layer 8 E2E — programs reachable from RPC', async () => {
    const conn = new Connection(RPC_URL!, 'confirmed');
    const programs = [
      ['YD', new PublicKey(YD_PROGRAM_ID!)],
      ['RWT_ENGINE', new PublicKey(RWT_ENGINE_PROGRAM_ID!)],
      ['DEX', new PublicKey(DEX_PROGRAM_ID!)],
      ['OT', new PublicKey(OT_PROGRAM_ID!)],
    ] as const;
    for (const [name, id] of programs) {
      const info = await conn.getAccountInfo(id, 'confirmed');
      assert.ok(
        info,
        `program ${name} (${id.toBase58()}) not deployed at RPC ${RPC_URL}`,
      );
      assert.equal(
        info?.executable,
        true,
        `program ${name} account is not executable`,
      );
    }
  });

  test('Layer 8 E2E — full scenario (TBD: bootstrap script required)', async () => {
    // The complete scenario requires:
    //   - scripts/e2e-bootstrap.sh — initializes singleton state, creates
    //     test OT, seeds master pool, funds crank, etc.
    //   - per-step assertions defined in the file header comment above.
    //
    // Until that script lands, this test passes if the bootstrap-marker
    // file exists in the validator's home dir, otherwise skips. This keeps
    // the file runnable for future expansion without forcing a half-baked
    // assertion suite into the public repo.
    const marker = process.env.E2E_BOOTSTRAP_DONE;
    if (marker !== '1') {
      // soft-skip via passing assertion + console message
      // eslint-disable-next-line no-console
      console.log(
        '[layer-08-e2e] bootstrap not detected — set E2E_BOOTSTRAP_DONE=1 once the validator state is seeded.',
      );
      assert.ok(true, 'bootstrap pending');
      return;
    }
    // Future: scenario steps 1..7 with explicit assertions — see file header.
    // For Step 10 we ship the harness + skip; full assertions land with
    // bootstrap script in Layer 9 polish.
    assert.fail(
      'E2E_BOOTSTRAP_DONE is set but scenario assertions are not yet implemented (Layer 9 polish).',
    );
  });
}
