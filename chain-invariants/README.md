# chain-invariants

Phase 22: a read-only Prometheus exporter that polls four on-chain
invariants and surfaces them as metrics + shields.io endpoint badges.

This bot does **not** sign transactions and does **not** receive a
keypair. It only reads chain state via RPC and translates that state
into prom-client gauges/counters. It is the "watchdog" of the watchdogs:
when other bots silently misbehave (publisher stuck, NAV updater hung,
authority rotated under our feet, mint/vault out of sync) chain-invariants
makes the failure visible in Grafana within one poll cycle.

## Invariants polled

| # | Invariant | Source | Alert |
|---|-----------|--------|-------|
| 1 | Merkle root freshness | `getSignaturesForAddress(distributor_pda)` → `getBlockTime` | `MerkleRootStale` (>6h for 10m) |
| 2 | NAV freshness | `getSignaturesForAddress(rwt_vault_pda)` → `getBlockTime` | `NavStale` (>24h for 30m) |
| 3 | Authority drift | `getAccountInfo` × 5 contracts → decoded `authority` field | `AuthorityDrift` (mismatch for 1m) |
| 4 | RWT supply parity | `RwtVault.total_rwt_supply` vs `Mint.supply` | `RwtSupplyDrift` (drift > 0 for 2m) |

## Architecture (Q1-Q5 decisions)

- **Q1 (HTTP server):** duplicated inline (~60 LOC) from `bots/shared/src/metrics.ts`
  rather than extracted. The shared `createBotMetrics` API is TX-bot shaped
  (`bot_*` prefix, mandatory `instructions` enum, `bot_alive` heartbeat
  tied to TX ticks). Forcing a read-only watchdog through that shape would
  produce meaningless `bot_tx_total{instructions="none"}` series. When a
  third HTTP-exposing component appears, extract `createMetricsServer({ extraRoutes })`.
- **Q2 (freshness sourcing):** `getSignaturesForAddress(pda, { limit: 1 })`
  → `getBlockTime`. Deterministic, restart-safe. Note: any TX touching the
  account (including admin TXs) resets the clock — over-approximation is
  acceptable for v1; tighten with discriminator filter in Phase 23.
- **Q3 (start-bots integration):** `BotSpec.readOnly?: boolean` flag.
  When set: `resolveBotKeypairs` skips, `fundBots` skips, no `BOT_KEYPAIR_PATH`
  passed; instead invariant-specific env vars are forwarded.
- **Q4 (AuthorityDrift severity):** ships as `severity: critical` with
  TODO for `severity: page` upgrade once Alertmanager page routing lands
  in Phase 24. Annotation includes `severity_intent: page` so the upgrade
  is a label flip, not a re-design.
- **Q5 (env vars):** five separate `EXPECTED_AUTHORITY_*` vars, one per
  contract. Each validated independently with `PublicKey` constructor.

## Configuration

Required env vars:

```
RPC_URL                                     Solana RPC HTTP URL
BOT_METRICS_PORT                            TCP port (default 9201)
CHAIN_INVARIANTS_POLL_INTERVAL_MS           default 60000 (min 5000)

# PDAs
PDA_YD_MERKLE_DISTRIBUTOR
PDA_YD_DISTRIBUTION_CONFIG
PDA_RWT_VAULT
PDA_OT_GOVERNANCE
PDA_FUTARCHY_CONFIG
PDA_DEX_CONFIG

# Expected authorities (5 separate vars per Q5)
EXPECTED_AUTHORITY_OT_GOVERNANCE
EXPECTED_AUTHORITY_FUTARCHY_CONFIG
EXPECTED_AUTHORITY_RWT_VAULT
EXPECTED_AUTHORITY_DEX_CONFIG
EXPECTED_AUTHORITY_YD_DISTRIBUTION_CONFIG

# Optional — when set, enables full PDA self-derivation check (I1)
OT_MINT
```

All keys are validated eagerly at startup — a missing or malformed value
fails fast with a descriptive error.

### Startup self-derivation (Phase 22.5 / I1)

At startup, every operator-supplied `PDA_*` env var is cross-checked
against the SDK's PDA helpers using the canonical program IDs. A
mismatch is fail-fast (process exits non-zero before the HTTP server
starts).

| PDA env var                  | Helper                                       | Validated when… |
|------------------------------|----------------------------------------------|-----------------|
| `PDA_DEX_CONFIG`             | `findDexConfigPda(NATIVE_DEX_PROGRAM_ID)`    | always          |
| `PDA_RWT_VAULT`              | `findRwtVaultPda(RWT_ENGINE_PROGRAM_ID)`     | always          |
| `PDA_YD_DISTRIBUTION_CONFIG` | `findYdConfigPda(YIELD_DISTRIBUTION_PROGRAM_ID)` | always      |
| `PDA_OT_GOVERNANCE`          | `findOtGovernancePda(OT_MINT, OWNERSHIP_TOKEN_PROGRAM_ID)` | `OT_MINT` set |
| `PDA_FUTARCHY_CONFIG`        | `findFutarchyConfigPda(OT_MINT, FUTARCHY_PROGRAM_ID)`      | `OT_MINT` set |
| `PDA_YD_MERKLE_DISTRIBUTOR`  | `findMerkleDistributorPda(OT_MINT, YIELD_DISTRIBUTION_PROGRAM_ID)` | `OT_MINT` set |

When `OT_MINT` is unset, the 3 per-OT PDAs are trusted to the operator
and a `pda_self_derivation_partial` warning is logged at startup so the
gap is visible in audit.

## Endpoints

| Path | Description |
|------|-------------|
| `GET /metrics` | Prometheus text-format scrape endpoint |
| `GET /api/badges/merkle-fresh` | shields.io endpoint JSON |
| `GET /api/badges/nav-fresh` | shields.io endpoint JSON |
| `GET /api/badges/authority-ok` | shields.io endpoint JSON |
| `GET /api/badges/supply-ok` | shields.io endpoint JSON |
| `GET /healthz` | `{"ok":true}` liveness probe |

All endpoints bind strictly to `127.0.0.1` — public exposure is via the
operator's reverse proxy (`cloudflared` ingress for `/api/badges/*`).

## Cardinality budget (bounded)

- `distributor` × 1
- `rwt_engine` × 1
- `contract` × 5
- `authority` × 5
- `check` × 4

Total active series per scrape: ~20 + prom-client default process
metrics. Well within budget. Adding a new contract or RWT vault requires
architect sign-off so the budget stays predictable.

## Run

```bash
npm -w chain-invariants run start    # tsx src/index.ts
npm -w chain-invariants run build    # tsc
npm -w chain-invariants test          # vitest run
```

## Development notes

- TypeScript strict, no `any` in public APIs.
- All RPC URL log lines pass through `redactUrl()` from `@areal/bots-shared`.
- The HTTP server **only** binds `127.0.0.1`. Public exposure happens
  through the operator's `cloudflared` tunnel.
- The poll loop runs an immediate first poll on startup (Architect
  requirement) so a freshly-launched exporter does not lie green for
  the first poll interval.
