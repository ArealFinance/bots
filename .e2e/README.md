# Layer 8 E2E Test Harness

This directory hosts heavyweight integration tests that require a live Solana
test-validator with all five Areal programs deployed. They are intentionally
**not** wired into `npm test` — running them mid-CI would break developer
inner loops because the tests take minutes and require a running validator.

## Tests

| File | Covers | R-ticket |
|------|--------|----------|
| `discriminator-audit.test.ts` | Functional dispatch: every pinned `DISC_*` actually invokes its handler on a deployed program (success or expected-error path). Wrong-disc TX must surface `unknown discriminator`-style failure. | R11 |
| `layer-08-e2e.test.ts` | Full yield-flow scenario end-to-end (Accumulator USDC seed → distribute_revenue → convert_to_rwt → publish root → claim_yield / compound_yield / claim_yd_for_treasury). | §12 architecture |

## Running

Both tests check `RPC_URL` env var; if unset, they skip with a clear message:

```bash
# bring up local validator + deploy all 5 programs (separately)
solana-test-validator ...
# point env at it
export RPC_URL=http://127.0.0.1:8899
export OT_PROGRAM_ID=oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL
export YD_PROGRAM_ID=YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF
export RWT_ENGINE_PROGRAM_ID=RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL
export DEX_PROGRAM_ID=DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL
export FUTARCHY_PROGRAM_ID=FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL

# crank keypair (devnet/local) — must hold SOL for fees
export CRANK_KEYPAIR=$HOME/.config/solana/id.json

# run individual files
npx tsx bots/.e2e/discriminator-audit.test.ts
npx tsx bots/.e2e/layer-08-e2e.test.ts
```

## CI Integration (Layer 9 / pre-mainnet)

These tests are part of the **pre-mainnet** acceptance gate (R24, R26, §12).
They are NOT part of normal CI because they require:

1. A running solana-test-validator with all 5 programs deployed.
2. Funded crank keypair (>= 2 SOL).
3. State initialization (singleton configs, an OT distributor, etc.).

A future ops job will spin all of this up via `scripts/e2e-bootstrap.sh` (TBD)
and run these as the final gate before mainnet promotion.

## Status (Layer 8 Step 10)

* `discriminator-audit.test.ts` — **landed**, manual-run only (R11 minimal).
* `layer-08-e2e.test.ts` — **scaffolded**, full scenario assertions deferred
  until the bootstrap script lands in Layer 9 polish. The current file
  documents the required scenario steps and provides a runnable harness for
  future expansion.
