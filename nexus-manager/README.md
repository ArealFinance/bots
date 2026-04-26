# `nexus-manager`

Manager-gated bot for the **LiquidityNexus** singleton on Areal Finance. Reads
on-chain Nexus state, picks rebalance actions, and submits Manager-signed
`nexus_swap` / `nexus_add_liquidity` / `nexus_remove_liquidity` transactions
against the DEX program.

This bot does **not** withdraw principal — `nexus_withdraw_profits` is
Authority-gated and lives outside this codepath. Rotating the Manager wallet
costs one Authority TX (`update_nexus_manager`).

## Roles & Responsibilities

| Concern | Owner |
|---|---|
| Multi-RPC fallback / consensus reads | `@areal/bots-shared` (R29) |
| Single-instance enforcement | `@areal/bots-shared::SingleInstanceLock` (R30) |
| Decision logic (drift, idle deploy, kill-switch) | `src/decision-engine.ts` |
| TX construction (3 ix builders) | `src/tx-builders/` |
| State decoders (LiquidityNexus, LpPosition, PoolState) | `src/nexus-state-reader.ts` |
| SQLite checkpoint (idempotency hint) | `src/checkpoint.ts` |
| Main poll loop + lifecycle | `src/crank.ts` + `src/index.ts` |

## Setup

1. Copy `.env.example` to `.env` and fill values:

   - `MANAGER_KEYPAIR_PATH` — path to a 64-byte Solana keypair file
     (`solana-keygen new -o manager.json`). Production hardening migrates
     this to a KMS reference under R3/R6 (out of scope for Layer 9).
   - `RPC_URLS` — pipe-separated `<http>|<ws>|<weight>` tuples, comma-separated
     across multiple endpoints. Highest weight wins; failures demote.
   - `DEX_PROGRAM_ID` — vanity DEX program ID
     (`DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL` per Layer 1-7 deploy).
   - `USDC_MINT`, `RWT_MINT` — deployment-specific mint addresses. The bot
     filters managed pools to those whose `(token_a, token_b)` is the
     `(USDC, RWT)` pair (V1 heuristic).
   - `NEXUS_MANAGED_POOLS` — comma-separated PoolState PDAs the bot is
     allowed to deploy into. Empty list = idle.

2. Install + build:

   ```sh
   cd bots
   npm install
   npm -w nexus-manager run build
   ```

3. Smoke test (no live submit — just config + RPC validation):

   ```sh
   npm -w nexus-manager run start
   ```

## Decision Policy (V1)

Per Layer 9 architecture §5.1.2, one decision per cycle, evaluated in this
order:

1. **Kill-switch** — if `nexus.manager == [0u8; 32]` (D22) or
   `nexus.is_active == false`, the cycle returns `noop` and logs a
   structured warning. The bot does **not** auto-exit on a kill-switch
   observation — operators rotate via `update_nexus_manager` (DEX) and the
   bot picks up the new manager on the next cycle.

2. **Drift rebalance** — when the Nexus's idle USDC/RWT mix deviates from
   `LP_TARGET_RATIO_BPS` by more than `LP_REBALANCE_TRIGGER_BPS`, emit a
   `nexus_swap` from the over-weighted side into the under-weighted side.
   Swap amount = half the gap; `min_amount_out = 95% × amount_in`.

3. **Idle deploy** — when idle capital exceeds `MIN_REBALANCE_USDC` and a
   managed `(USDC, RWT)` pool is available, emit `nexus_add_liquidity`
   capped by `MAX_POOL_CONCENTRATION_BPS` of pool reserves.

4. **`nexus_remove_liquidity`** — V1 reserves this for explicit operator
   intervention; the builder is exposed via `tx-builders/` for tests and
   ops scripts. A future iteration adds a recall heuristic.

## Manager Keypair Handling

- Keypair file path is the only acceptable Layer 9 driver
  (`MANAGER_KEYPAIR_PATH`).
- Compromise rotates in 1 TX: Authority calls
  `update_nexus_manager(new_manager)` on the DEX program. Restart the bot
  with the new keypair.
- Setting `manager = [0u8; 32]` is a documented kill-switch — the bot
  observes this on the next cycle and refuses to submit further actions
  (`assert_manager` would revert on-chain anyway).
- Mainnet upgrade path: KMS reference (R3/R6). Does **not** change the
  on-chain ix surface — only this bot's keypair-loading driver.

## Kill-Switch Behaviour

| Observed | Bot behaviour | Operator action |
|---|---|---|
| `manager == [0u8; 32]` | Cycle logs `kill-switch reason=manager_zero`, no TX submit. | `update_nexus_manager(new_manager)` from Authority wallet. |
| `is_active == false` | Cycle logs `kill-switch reason=is_active_false`, no TX submit. | (Layer 9 has no toggle ix; this branch is reserved for future Authority-only `pause` extensions.) |
| Manager wallet rotated | Old keypair → all submitted TXs revert `InvalidNexusManager`. Restart bot with new keypair. | `update_nexus_manager(new_manager)` + redeploy bot with the new file. |

## Single-Instance Guarantee

`SingleInstanceLock` from `@areal/bots-shared` (R30) writes a PID-file at
`${LOCK_DIR}/nexus-manager.lock` on startup. A second process attempting to
acquire the same lock exits with `AlreadyRunningError` immediately. The
file is removed on graceful shutdown and reclaimed if the holder PID is
no longer alive.

## Monitoring

Structured logs follow the shared logger format (`[level] message k=v...`).
Operators tail stdout / stderr and grep for:

- `nexus-manager: action submitted` — successful TX with signature.
- `nexus-manager: TX submit failed` — review error context.
- `nexus-manager: kill-switch observed` — escalate to Authority.
- `nexus-manager: another instance is already running` — operational
  duplicate; investigate before clearing the lock-file.

## Ops Runbook

- **Deploy** — provision the keypair file, populate `.env`, start under a
  process supervisor (systemd, pm2, or a container runtime). The bot is
  long-running; `npm -w nexus-manager run start` is the entrypoint.
- **Rotate manager** — Authority TX `update_nexus_manager`, then redeploy
  the bot with the new keypair file.
- **Pause** — set `manager = [0u8; 32]` via Authority. The bot stops
  submitting actions; existing positions remain managed by the DEX
  contract. Reverse by setting a real manager address.
- **Recall capital** — handcraft a `nexus_remove_liquidity` decision via
  `tx-builders/nexus-remove-liquidity.ts` (test-suite path), or invoke
  through the dashboard once Substep 10 lands.
- **Disaster recovery** — when the bot crashes, the next start picks up
  on-chain state from scratch. The SQLite checkpoint is a hint-cache; no
  important state is lost.
