# Areal Finance — Bots

Off-chain services that keep the [Areal Finance](https://areal.finance) protocol running. Each bot is a standalone TypeScript + Node.js service.

| Bot | State | Role |
|---|---|---|
| [`merkle-publisher`](./merkle-publisher) | active | Builds yield distribution Merkle roots, publishes on-chain, serves claim proofs |
| [`pool-rebalancer`](./pool-rebalancer) | active | Keeps concentrated-liquidity pools active by shifting bins around current price |
| [`revenue-crank`](./revenue-crank) | active | Triggers `OT::distribute_revenue` per-OT once revenue ATA passes the min-distribution threshold and the cooldown has elapsed |
| [`convert-and-fund-crank`](./convert-and-fund-crank) | decision-only (Layer 8 Step 7) | Computes route + slippage + checkpoint state for `YD::convert_to_rwt` and exports TX builders. Live TX submission requires dynamic on-chain readers (DistributionConfig, MerkleDistributor, RwtVault accounts, master pool vaults) wired in Layer 8 Step 10 E2E |
| [`yield-claim-crank`](./yield-claim-crank) | decision-only (Layer 8 Step 7) | Computes claim decisions per-epoch + fetches proofs from Merkle Publisher store and exports TX builders for `RWT::claim_yield` / `DEX::compound_yield` / `OT::claim_yd_for_treasury`. Live submission lands in Layer 8 Step 10 E2E |

Planned (not yet implemented): Nexus manager (Layer 9).

## Yield-flow overview

```
revenue source ─▶ revenue-crank ─▶ OT::distribute_revenue ─▶ Accumulator USDC
                                                              │
                                                              ▼
                                          convert-and-fund-crank
                                          (DEX swap + mint, atomic)
                                                              │
                                                              ▼
                                              YD::convert_to_rwt
                                              emits StreamConverted
                                                              │
                                                              ▼
                                              merkle-publisher
                                              snapshot → publish_root
                                                              │
                                                              ▼
                                              yield-claim-crank
                                       ┌────────────┼─────────────┐
                                       ▼            ▼             ▼
                              RWT::claim_yield  DEX::compound  OT::claim_yd_for_treasury
                              (70/15/15 split)  (auto-LP)      (cross-project)
```

The cranks are decoupled: each one only depends on **on-chain state** (and, for
the yield-claim crank, the Merkle Publisher proof store). Any single bot can be
restarted without affecting the others; the chain is the source of truth.

## Idempotency model (D9)

Every crank uses the same SQLite-backed checkpoint pattern:

1. **Local checkpoint** (`data/checkpoint.db`): hint cache of last successful
   action per key (OT mint, pool address, etc.).
2. **On-chain re-check before sending TX**: read the canonical state account
   (`RevenueAccount`, `Accumulator` USDC ATA, `MerkleDistributor` epoch) and
   skip the TX if the on-chain side already advanced past the checkpoint.
3. **On-chain enforcement**: the program-side guards (cooldowns, claim-status
   PDA, `is_distributing` flag) revert any duplicate attempt anyway. The local
   checkpoint is purely a latency / RPC-cost optimisation.

Crashes between TX submission and checkpoint update are safe: the next loop
tick re-reads on-chain state, finds the work already done, and skips.

## Reactivity model (D10)

Each crank runs **two parallel triggers** behind a single-flight lock:

1. **WebSocket subscribe** — primary, low-latency reaction to on-chain events
   (`RevenueDistributed`, `StreamConverted`, `RootPublished`, etc.).
2. **Poll fallback** — runs every 5 minutes (configurable per bot) so a missed
   WS notification never wedges the pipeline.

The single-flight lock is keyed by `(action, target)` so a WS callback and a
poll tick that target the same OT will not both fire `convert_to_rwt`.

## Crank wallet management (D11)

**Three separate keypairs**, one per crank, to limit blast radius:

```
revenue-crank          → REVENUE_CRANK_KEYPAIR_PATH
convert-and-fund-crank → CONVERT_FUND_CRANK_KEYPAIR_PATH
yield-claim-crank      → YIELD_CLAIM_CRANK_KEYPAIR_PATH
```

If one keypair is compromised, only that crank's flow is at risk; the other two
keep operating. All three instructions are **permissionless** on-chain — anyone
can submit them — so a stolen crank key cannot drain user funds, only burn SOL
on bogus or duplicate calls (which the on-chain guards reject).

For Layer 8 the cranks read keypairs from local files (devnet). Production
deployment will switch to KMS adapters mirrored from
`merkle-publisher/src/kms-signer.ts` (R3 / R6 follow-ups).

## Requirements

- Node.js ≥ 22.17
- npm ≥ 10
- Access to a Solana RPC endpoint (archival for merkle-publisher)

## Install

```bash
npm install                     # installs all workspaces
```

## Build

```bash
npm run build                   # tsc across all workspaces
```

## Test

```bash
npm test                        # vitest across all workspaces
```

## Run

Each bot has its own `.env.example`. Copy and fill in:

```bash
# Merkle publisher
cp merkle-publisher/.env.example merkle-publisher/.env
npm run merkle:start

# Pool rebalancer
cp pool-rebalancer/.env.example pool-rebalancer/.env
npm run rebalancer:start

# Layer 8 cranks
cp revenue-crank/.env.example          revenue-crank/.env
cp convert-and-fund-crank/.env.example convert-and-fund-crank/.env
cp yield-claim-crank/.env.example      yield-claim-crank/.env

npm run revenue:start
npm run convert:start
npm run claim:start
```

## Related

- **Contracts:** [ArealFinance/contracts](https://github.com/ArealFinance/contracts)
- **Dashboard:** [ArealFinance/dashboard](https://github.com/ArealFinance/dashboard)
- **Framework:** [ArealFinance/arlex](https://github.com/ArealFinance/arlex)
- **Full protocol:** [ArealFinance/areal](https://github.com/ArealFinance/areal)

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
