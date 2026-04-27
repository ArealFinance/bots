# yield-claim-crank

Permissionless crank that triggers the three Layer 8 claim flows after the
Merkle Publisher releases a fresh root:

1. `RWT::claim_yield` — RwtVault PDA claims its share of every OT distributor.
   Splits 70/15/15 (book / liquidity / protocol revenue) per
   `RwtDistributionConfig`.
2. `DEX::compound_yield` — every OT/RWT pool PDA claims its share, folding the
   received RWT directly into the pool's RWT-side reserve (auto-compound LPs).
3. `OT::claim_yd_for_treasury` — the ARL OtTreasury PDA claims its share for
   each OT distributor (cross-project yield: ARL OtTreasury claims FROM RCP/TUR
   distributors and so on).

All three instructions are permissionless on-chain. The crank is a convenience
that polls the proof store written by `merkle-publisher` and invokes the
relevant ix once per published epoch.

## Architecture

```
                ┌─────────────────────────────────────────┐
                │   yield-claim-crank                      │
                │                                          │
                │   ┌─────────────────────────────────┐    │
                │   │  WS subscribe (D10 primary)     │    │
                │   │  onLogs(YD_PROGRAM_ID)          │────┼─ reacts to RootPublished
                │   └────────────────┬────────────────┘    │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  poll loop (D10 fallback)      │     │
                │   │  every CLAIM_INTERVAL_SECS     │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  SingleFlightLock(kind:key)    │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  proof-fetcher                 │     │
                │   │  (FS or HTTP)                  │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  decideClaim() — D9 epoch gate │     │
                │   │  - skip if no proof            │     │
                │   │  - skip if proof.epoch ≤ ckpt  │     │
                │   └────────────────┬───────────────┘     │
                │                    │                     │
                │   ┌────────────────┴───────────────┐     │
                │   │  buildXxxIx() + wrapClaimTx()  │     │
                │   │  (CU budget per ix)            │     │
                │   └────────────────┬───────────────┘     │
                └────────────────────┼─────────────────────┘
                                     │
                                     ▼
                  ┌──────────────────┴───────────────────┐
                  │                                      │
                  │  RWT::claim_yield  (vault — 70/15/15)│
                  │  DEX::compound_yield (pool — auto-LP)│
                  │  OT::claim_yd_for_treasury           │
                  └──────────────────────────────────────┘
```

## Idempotency (D9)

The on-chain `ClaimStatus` PDA accumulates `claimed_amount` per
`(distributor, claimant)` and is the absolute source of truth. The local
SQLite checkpoint is keyed `(claim_kind, key)` and stores the highest
`epoch` we have ever sent for that key.

| Kind | Key |
|---|---|
| `vault` | OT mint (one row per OT distributor) |
| `pool` | DEX pool address |
| `treasury` | `${ARL_OT_MINT}:${distributor_OT_MINT}` |

A proof file with epoch ≤ checkpoint is skipped without an RPC call. A proof
file with epoch > checkpoint runs through the on-chain ix, which itself is
robust against duplicate calls (the contract's `cumulative_amount` semantics
make a re-submission idempotent — the second tx sees `claimed == cumulative`
and short-circuits).

## D10 — WS subscribe + poll fallback

| Trigger | Source | Cadence |
|---|---|---|
| Primary | WebSocket `onLogs(YD_PROGRAM_ID)` (RootPublished) | Real-time |
| Fallback | Poll loop | `CLAIM_INTERVAL_SECS` (default 30 min) |

Single-flight lock keyed by `(kind, key)` dedupes overlapping triggers.

## Crank wallet (D11)

```sh
YIELD_CLAIM_CRANK_KEYPAIR_PATH=./data/yield-claim-crank.json
```

```bash
solana-keygen new -o ./data/yield-claim-crank.json --no-bip39-passphrase
```

**Three separate keypairs reduce blast radius if one is compromised** — this
crank only signs claim instructions. Stolen key cannot drain user balances
(no authority over user-owned ATAs); worst case is a malicious caller burns
SOL trying to submit duplicate proofs that the program will reject.

For mainnet, switch local-file mode to AWS / GCP KMS following the pattern
in `bots/merkle-publisher/src/kms-signer.ts` (R3 / R6 follow-ups).

## Wiring dynamic accounts

Each of the three claim builders accepts the dynamic accounts as inputs:

| Flow | Caller must wire |
|---|---|
| Vault | `rwt_claim_ata`, `liquidity_dest`, `protocol_revenue_dest`, `yd_reward_vault` |
| Pool | `target_vault`, `ot_mint`, `yd_reward_vault` |
| Treasury | `treasury_rwt_ata`, `yd_reward_vault` |

For Layer 8 the bot logs SEND decisions and updates the checkpoint, while
leaving the live TX submission to a Step 10 E2E driver that knows how to
read each program's state. Operators can use the exported builders
(`buildRwtClaimYieldIx`, `buildDexCompoundIx`, `buildOtTreasuryClaimIx`)
directly to compose TXs by hand from the dashboard.

## Setup

```bash
cd bots
cp yield-claim-crank/.env.example yield-claim-crank/.env
solana-keygen new -o yield-claim-crank/data/yield-claim-crank.json --no-bip39-passphrase
# fund the wallet ~0.5 SOL on devnet
```

Edit `.env` — fill `OT_PROJECTS`, `OT_RWT_POOLS`, `ARL_OT_MINT`, `RWT_MINT`,
and choose a proof source: either `PROOF_DIR` (shared filesystem with the
publisher) or `PROOF_BASE_URL` (HTTP).

### Layer 9 env vars

- `SEND_TX` — `false` (default) for dry-run mode. Same flip procedure as
  the other cranks: verify in staging, top up wallet, flip to `true`,
  watch the decision log.
- `YIELD_CLAIM_MIN_SOL_LAMPORTS` — R-60 SOL pre-flight threshold override.

**Layer 9 opt-in flows (default OFF):**

- `YIELD_CLAIM_ENABLE_LH_DRAIN` — gate for the LiquidityHolding → Nexus
  drain via `withdraw_liquidity_holding`. **Blocked on R20** (RWT_MINT pin
  migration). Until R20 lands, opting in + `SEND_TX=true` produces a
  `decision: "send", reason: "deferred"` log line and skips the cycle
  cleanly. The TX-builder for `withdraw_liquidity_holding` is intentionally
  not exported from this crank — the Authority-side flow lives in the
  dashboard. Per SD-29 / R-61.
- `YIELD_CLAIM_ENABLE_NEXUS_DEPOSIT` — gate for the USDC `nexus_deposit`
  routing after `distribute_revenue`. Blocked on nexus-manager publishing
  a shared TX-builder. Same dry-run-with-deferred-skip pattern. Per SD-29.

Both opt-ins default to `false`. When enabled (`true`) but `SEND_TX=false`,
the crank logs the intent without submitting. When both are `true` AND the
external dependency is satisfied, the crank submits live. Because of the
external gates, **flipping the opt-in to `true` ahead of R20 is safe** —
the crank will never accidentally submit; it will deferred-skip.

## Run / test / build

```bash
npm run claim:start
npm run claim:test
npm -w yield-claim-crank run build
```

## Tests

- `encodeClaimArgsBody` — byte-layout fixture for the YD::claim instruction
  data shared across all 3 wrappers.
- Discriminators — sha256 parity for all three `global:<ix>` names.
- Each builder — account count, programId pinning, args encoding.
- `wrapClaimTx` — CU-budget prefix.
- `decideClaim` — D9 epoch gating across `no_proof` / `epoch_stale` / `send`.
- `SingleFlightLock` — D10 dedup invariants.
- `CheckpointStore.isNewer` — kind separation + monotonic invariants.
- `ProofFetcher` (filesystem driver) — happy + missing-file paths.
- `parseProofJson` / `decodeProofNodes` — robustness on legacy + current JSON.

## License

Apache-2.0 — inherited from `bots/`.
