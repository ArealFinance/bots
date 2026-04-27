# E2E Test Harness (Layer 8 + Layer 9)

This directory hosts heavyweight integration tests that span every Areal
program. The **parity tests** are dependency-free and run on every CI build;
the rest are gated on a populated bootstrap artifact + reachable RPC.

## Tests

| File | Covers | R-ticket |
|------|--------|----------|
| `parity-tests.test.ts` | Byte-parity audit of 12 events (Layer 8 + Layer 9): parse Rust `events.rs`, compare field name + type sequence against a hand-coded TS schema. Catches silent layout drift between contracts and decoders. Runs on every CI build. | R26, R34 |
| `discriminator-audit.test.ts` | Functional dispatch: every pinned `DISC_<ix>` actually invokes its handler on a deployed program (success or expected-error path). Wrong-disc TX must surface dispatch-level failure. Includes 9 Layer 9 ix discriminators. | R11 |
| `layer-08-e2e.test.ts` | Full yield-flow scenario end-to-end (Accumulator USDC seed → distribute_revenue → convert_to_rwt → publish root → claim_yield / compound_yield / claim_yd_for_treasury). Gated on `data/e2e-bootstrap.json` schema_version=1. | §12 architecture |
| `layer-09-e2e.test.ts` | Full Nexus path (init → manager rotation → swap/add/remove via Manager bot → permissionless deposit → withdraw_profits → claim_rewards). Gated on `phaseNexus` not in `init_skipped[]`/`init_failed[]` (R57). | §10.3 layer-09-architecture |

## Running

The parity tests run with no setup:

```bash
# from repo root
npm -w areal-bots run e2e
```

Live tests require a populated bootstrap artifact and reachable RPC:

```bash
# bring up local validator + deploy + run bootstrap-init (Substep 12)
bash scripts/e2e-bootstrap.sh

# point env at the validator
export RPC_URL=http://127.0.0.1:8899

# program IDs (already in data/e2e-bootstrap.json — env mirrors)
export OT_PROGRAM_ID=oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL
export YD_PROGRAM_ID=YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF
export RWT_ENGINE_PROGRAM_ID=RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL
export DEX_PROGRAM_ID=DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL
export FUTARCHY_PROGRAM_ID=FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL

# crank keypair (for discriminator-audit; must hold SOL for fees)
export CRANK_KEYPAIR=$HOME/.config/solana/id.json

# run all four files via the workspace script
npm -w areal-bots run e2e

# OR run one at a time
npx tsx --test bots/.e2e/parity-tests.test.ts
npx tsx --test bots/.e2e/layer-08-e2e.test.ts
npx tsx --test bots/.e2e/layer-09-e2e.test.ts
npx tsx --test bots/.e2e/discriminator-audit.test.ts
```

## SEND_TX gate (Substep 13)

Each crank reads a `SEND_TX` env var (default `false`). When unset, the bot
runs decision-only and emits structured `decision` log lines. Substep 13
flips this to `true` for live-submit smoke tests:

```bash
# in each crank's .env (rendered by render-env.ts)
SEND_TX=true
```

The yield-claim-crank gates two additional flows behind their own opt-ins
(both default `false`, both require `SEND_TX=true`):

```bash
YIELD_CLAIM_ENABLE_LH_DRAIN=false       # gated on R20 RWT_MINT pin migration
YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT=false  # gated on Nexus provisioning
```

The nexus-manager and convert-and-fund-crank also gate the live submit on
`SEND_TX`. The four cranks plus the merkle-publisher form the full E2E
loop driven by `scripts/e2e-bootstrap.sh` followed by operator runner.

## CI Integration (Layer 9 / pre-mainnet)

* **Parity tests** — run on every CI build (`npm run e2e` includes them).
* **Layer 8/9 scenario tests** — gated on `data/e2e-bootstrap.json` and
  `RPC_URL`. CI runs them only on the staging job after bootstrap.sh
  populates the artifact.

These are the final gate before mainnet promotion (architecture §12).

## Gating logic (R20 / R57 / SD-25 / SD-26)

The Layer 8/9 tests gate on the `init_skipped[]` and `init_failed[]` fields
in `data/e2e-bootstrap.json`:

* `phaseLiquidityHolding` failed (R20 RWT_MINT pin) → LH drain assertions skip.
* `phaseNexus` failed/skipped (Layer 9 IDL not regenerated yet) → Nexus
  scenario assertions skip with a structured warning, not a noisy fail.

This keeps the harness runnable through staged rollouts without needing to
fork the test files per environment.

## Status (Layer 9 Substep 13)

* `parity-tests.test.ts` — **landed**, 14 tests, runs in CI.
* `discriminator-audit.test.ts` — **expanded** with 9 Layer 9 ix.
* `layer-08-e2e.test.ts` — **expanded** to artifact-driven assertions
  (schema_version, programs reachable, Accumulator seeded, OT distributors
  initialized, R20 gating).
* `layer-09-e2e.test.ts` — **landed**, gated on `phaseNexus` per R57.
