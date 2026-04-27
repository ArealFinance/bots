# revenue-crank

Permissionless crank that triggers `OT::distribute_revenue` for each Ownership
Token (OT) project once two on-chain conditions are met:

1. The `RevenueAccount` USDC ATA balance is **at least**
   `RevenueAccount.min_distribution_amount`.
2. At least `DISTRIBUTION_COOLDOWN` seconds (7 days) have elapsed since the
   last successful distribution (the program enforces this; the crank is
   defence-in-depth).

The on-chain instruction itself is permissionless (any signer can submit it),
so this bot is a convenience layer — anyone can dashboard-trigger the same
ix manually and the crank will simply skip the next tick.

## Architecture

```
                ┌────────────────────────────────────────┐
                │  RPC + WS connection (devnet/mainnet)  │
                └───────────────────┬────────────────────┘
                                    │
                ┌──────────────────┴────────────────────┐
                │   revenue-crank                        │
                │                                        │
                │   ┌──────────────────────────────┐    │
                │   │  WS subscribe (D10 primary)  │────┼─── triggers re-check on
                │   │  onLogs(ot_program_id)       │    │    any program log
                │   └────────────────┬─────────────┘    │
                │                    │                  │
                │   ┌────────────────┴──────────────┐   │
                │   │  poll loop (D10 fallback)     │   │
                │   │  every CHECK_INTERVAL_SECS    │   │
                │   └────────────────┬──────────────┘   │
                │                    │                  │
                │   ┌────────────────┴──────────────┐   │
                │   │  SingleFlightLock(ot_mint)    │   │
                │   │  — guarantees WS+poll dedup    │   │
                │   └────────────────┬──────────────┘   │
                │                    │                  │
                │   ┌────────────────┴──────────────┐   │
                │   │  processOt():                 │   │
                │   │  1. read RevenueAccount       │   │
                │   │     + RevenueConfig PDAs      │   │
                │   │  2. read USDC ATA balance     │   │
                │   │  3. decideDistribution()      │   │
                │   │  4. send TX if SEND           │   │
                │   │  5. upsert checkpoint (D9)    │   │
                │   └───────────────────────────────┘   │
                └───────────────────────────────────────┘
                                    │
                                    ▼
                       OT::distribute_revenue
                       (atomic on-chain split:
                        protocol fee → fee ATA,
                        rest → destination ATAs)
```

## Idempotency (D9)

- **Local checkpoint**: SQLite at `DB_PATH`. Stores the last
  `lastDistributionTs` we observed plus the TX signature of the last send.
- **On-chain re-check** before every send: `RevenueAccount` is read fresh and
  passed through `decideDistribution`. The local checkpoint is purely a
  hint cache — restart-safe.
- **On-chain enforcement**: `distribute_revenue` reverts with
  `DistributionCooldown` if the cooldown has not elapsed and with
  `DistributionInProgress` if a concurrent caller is mid-execution. The
  crank only skips defensively; the contract is the source of truth.

## D10 — WS subscribe + poll fallback

| Trigger | Source | Cadence |
|---|---|---|
| Primary | WebSocket `onLogs(OT_PROGRAM_ID)` | Real-time (millisecond) |
| Fallback | Poll loop | `CHECK_INTERVAL_SECS` (default 1h) |

A `SingleFlightLock` keyed by `ot_mint` ensures a WS callback and a poll tick
that target the same OT do not both submit a TX. The first one wins; the
second one no-ops on `lock.acquire()`.

## Crank wallet (D11)

Per [`bots/README.md`](../README.md#crank-wallet-management-d11) the three
Layer 8 cranks each carry their own keypair. For revenue-crank:

```sh
REVENUE_CRANK_KEYPAIR_PATH=./data/revenue-crank.json
```

Generate one with:

```bash
solana-keygen new -o ./data/revenue-crank.json --no-bip39-passphrase
```

The file is `.gitignored`. **Three separate keypairs reduce blast radius if
one is compromised** — a stolen key for revenue-crank cannot perform
yield-claim or convert-to-rwt on its own (those cranks have their own wallets,
and the on-chain ix is in any case permissionless so no funds at risk).

For mainnet, replace local-file mode with the AWS / GCP KMS adapter pattern
in `bots/merkle-publisher/src/kms-signer.ts` (R3 / R6 follow-ups).

## Setup

```bash
cd bots
npm install                     # installs revenue-crank + workspaces
cp revenue-crank/.env.example revenue-crank/.env
solana-keygen new -o revenue-crank/data/revenue-crank.json --no-bip39-passphrase
# fund the new wallet with ~0.5 SOL on devnet (architecture §10.4)
```

Edit `revenue-crank/.env`:

- `RPC_URLS` — comma-separated RPC tuples (R29 multi-RPC). Format per
  tuple: `<httpUrl>|<wsUrl>|<weight>` (wsUrl + weight optional). Add 2-3
  endpoints in production for failover. Replaces the single-endpoint
  `RPC_URL` / `RPC_WS_URL` env vars used in earlier revisions.
- `LOCK_DIR` — directory for the R30 single-instance PID lock (default
  `./data/locks`). Stale locks (>60s with dead PID) are auto-reclaimed.
- `OT_PROGRAM_ID` — already pinned to the vanity OT program ID.
- `OT_PROJECTS` — comma-separated OT mint addresses to monitor.
- `CHECK_INTERVAL_SECS` — poll fallback cadence (default 3600).
- `SEND_TX` — `false` (default) for dry-run mode (compute + log decisions but
  do not submit). Flip to `true` only after staging verification. The
  decision-engine output is identical in both modes; only the final
  `sendAndConfirmTransaction` call is suppressed when `SEND_TX=false`.
- `REVENUE_MIN_SOL_LAMPORTS` — optional override for the R-60 SOL pre-flight
  threshold (default 0.05 SOL = 50_000_000 lamports). Set higher for
  mainnet priority-fee bursts, e.g. `REVENUE_MIN_SOL_LAMPORTS=100000000`.

### SEND_TX flip procedure

1. Run with `SEND_TX=false` for at least one full cycle in staging.
2. Inspect the JSONL decision log under `data/decisions-*.log` — confirm
   the engine selects expected OT projects and skips for the right reasons.
3. Verify the SOL pre-flight does not log `low_sol` skips for the crank
   wallet (top up via airdrop or transfer if it does).
4. Edit `.env`: `SEND_TX=true`. Restart the systemd unit (or `npm run start`).
5. Tail the decision log; the first live cycle should produce one or more
   `decision: "submitted", signature: "..."` entries. If anything else
   surfaces, flip back to `false` and inspect.

## Run

```bash
npm run revenue:start
```

Or in watch mode (auto-restart on src changes):

```bash
npm -w revenue-crank run dev
```

## Test

```bash
npm run revenue:test
```

Tests cover:

- `decideDistribution` — D9 logic table (below_min, cooldown, concurrent,
  no_destinations, send paths).
- `SingleFlightLock` — D10 dedup invariants.
- `CheckpointStore` — D9 SQLite round-trip.
- `parseRevenueAccount` / `parseRevenueConfig` — byte-layout parsers against
  hand-rolled fixtures.
- `discDistributeRevenue` — discriminator parity vs `sha256("global:...")[..8]`.
- `buildDistributeRevenueIx` — full account list including `remaining_accounts`.

## Build

```bash
npm -w revenue-crank run build
```

## Failure modes

| Error | Behaviour |
|---|---|
| RPC unreachable | `processOt` returns `skip { rpc_error }`; next tick retries |
| `RevenueAccount` PDA missing | logs warn, skip (OT not initialised yet) |
| `DistributionCooldown` reverts on chain | next tick re-reads + skips on D9 path |
| Insufficient SOL on crank wallet | TX simulation fails; logs error and continues |
| WS reconnect | `Connection` auto-reconnects; poll fallback covers any miss |

## License

Apache-2.0 — inherited from the `bots/` workspace.
