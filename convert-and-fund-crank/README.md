# convert-and-fund-crank

Permissionless crank that triggers `YD::convert_to_rwt` for each Ownership
Token (OT) project once its Accumulator USDC ATA has more than
`MIN_CONVERT_USDC` of USDC in it. The on-chain instruction:

1. Optionally swaps USDC → RWT through the master RWT/USDC pool (`swap_first`).
2. Mints any USDC remainder via `RWT::mint_rwt`.
3. Splits the RWT acquired between the YD protocol fee account and the
   distributor's reward vault.
4. Updates `MerkleDistributor.total_funded` and emits `StreamConverted`.

Both legs are atomic — the entire TX reverts if either CPI fails. Outer
slippage is enforced on the aggregate `rwt_acquired` (D1).

## Architecture

```
                ┌─────────────────────────────────────────┐
                │   convert-and-fund-crank                 │
                │                                          │
                │   ┌─────────────────────────────────┐    │
                │   │  WS subscribe (D10 primary)     │    │
                │   │  onLogs(OT_PROGRAM_ID)          │────┼─── reacts to
                │   │                                 │    │    RevenueDistributed
                │   └────────────────┬────────────────┘    │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  poll loop (D10 fallback)      │     │
                │   │  every CHECK_INTERVAL_SECS     │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  SingleFlightLock(ot_mint)     │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  readConvertContext():         │     │
                │   │   - Accumulator USDC balance   │     │
                │   │   - RwtVault.nav_book_value    │     │
                │   │   - master pool reserves       │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  decideConvert():              │     │
                │   │   - skip if balance < min      │     │
                │   │   - skip if no pool & no NAV   │     │
                │   │   - chooseRoute() → swap/mint  │     │
                │   │   - apply slippage_bps margin  │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  buildConvertToRwtIx() +       │     │
                │   │  ComputeBudget(300_000) (D5)   │     │
                │   │  + SetComputeUnitPrice(P)      │     │
                │   └────────────────┬───────────────┘     │
                └────────────────────┼─────────────────────┘
                                     │
                                     ▼
                       YD::convert_to_rwt
                       (atomic: swap → mint → fee → vault)
```

## Idempotency (D9)

- **On-chain idempotency**: `convert_to_rwt` no-ops if
  `accumulator_usdc_ata.balance == 0` (handler step 4). Outer slippage check
  reverts with `SlippageExceeded` if `rwt_acquired < min_rwt_out`.
- **Local checkpoint**: SQLite at `DB_PATH`, last seen slot + signature per OT.
  Restart-safe — chain is the source of truth.
- **No retry storms**: failed sends do NOT retry inside the same loop tick.
  The next WS notification or poll tick will re-evaluate from fresh state.

## D10 — WS subscribe + poll fallback

| Trigger | Source | Cadence |
|---|---|---|
| Primary | WebSocket `onLogs(OT_PROGRAM_ID)` (RevenueDistributed) | Real-time |
| Fallback | Poll loop | `CHECK_INTERVAL_SECS` (default 5 min) |

Single-flight lock keyed by `ot_mint` dedupes overlapping triggers.

## D5 — Compute budget

`convert_to_rwt` performs **two CPIs** — DEX swap then RWT mint — followed by
two PDA-signed SPL transfers. Profiling on devnet shows ~280K CU peak; we
budget **300K** by default (`COMPUTE_UNIT_LIMIT=300000`). If you bump the
contract or change the pool layout, adjust the env var accordingly.

## Slippage calculation

```
expected_rwt = swap_first
  ? estimateSwap(pool, usdc_in)        // constant-product
  : estimateMint(usdc_in, nav)         // (usdc - 1% fee) * NAV_SCALE / nav

min_rwt_out  = expected_rwt * (10_000 - SLIPPAGE_BPS) / 10_000
```

Default `SLIPPAGE_BPS=100` (1%). Bumping the slippage tolerance lower means
the bot will more aggressively skip when the on-chain output drifts from the
estimate (typical for low-liquidity pools).

## Crank wallet (D11)

```sh
CONVERT_FUND_CRANK_KEYPAIR_PATH=./data/convert-fund-crank.json
```

```bash
solana-keygen new -o ./data/convert-fund-crank.json --no-bip39-passphrase
```

**Three separate keypairs reduce blast radius if one is compromised** — this
crank wallet only signs convert_to_rwt (a permissionless instruction with no
authority over user funds). Compromise = wasted SOL, not stolen tokens.

For mainnet, switch local-file mode to AWS / GCP KMS following
`bots/merkle-publisher/src/kms-signer.ts` (R3 / R6 follow-ups).

## Wiring fee_account / vaults

`convert_to_rwt` takes 22 accounts (handler at
`contracts/yield-distribution/src/instructions/convert_to_rwt.rs:81`). Most
are derivable from PDAs (Accumulator, MerkleDistributor, RwtVault, etc.) but
a few must be read from the on-chain config:

- `feeAccount` ← `DistributionConfig.areal_fee_destination`
- `rewardVault` ← `MerkleDistributor.reward_vault`
- `rwtCapitalAcc` ← `RwtVault.capital_acc`
- `rwtDaoFeeAccount` ← `RwtVault.dao_fee_account`
- `dexPoolVaultIn` / `dexPoolVaultOut` ← `PoolState.vault_a` / `vault_b`,
  ordered such that `vault_in.mint == USDC`.

For Layer 8 the bot exports `buildConvertToRwtIx` so an operator/dashboard
can compose the TX once they have those accounts. Step 10 E2E will wire the
dynamic reads inside `processOt` itself once an integration fixture is
available.

## Setup

```bash
cd bots
cp convert-and-fund-crank/.env.example convert-and-fund-crank/.env
solana-keygen new -o convert-and-fund-crank/data/convert-fund-crank.json --no-bip39-passphrase
# fund the wallet ~0.5 SOL on devnet
```

Edit `.env` — fill `USDC_MINT`, `RWT_MINT`, `RWT_USDC_POOL`, and `OT_PROJECTS`.

## Run / test / build

```bash
npm run convert:start
npm run convert:test
npm -w convert-and-fund-crank run build
```

## Tests

- Slippage estimators (constant-product swap, NAV-based mint).
- Route selection (`chooseRoute`) across pool-empty / NAV-zero edges.
- Decision table (`decideConvert` — below_min / zero_balance / no_pool_no_nav).
- `SingleFlightLock` invariants.
- SQLite `CheckpointStore` round-trip.
- `buildConvertToRwtIx` discriminator + 25-byte arg layout + 22-account list.
- `parsePoolSnapshot` byte-layout fixture.
- ComputeBudget program-ID smoke check.

## License

Apache-2.0 — inherited from `bots/`.
