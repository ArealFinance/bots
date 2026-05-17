# Pool Rebalancer

## Layer 10 status

- **State:** active (live via `scripts/lib/start-bots.ts`).
- **Single-instance lock:** `proper-lockfile` flock (R30).
- **On-chain liveness probe:** verified via `PoolState` account read; the orchestrator dwells past the heartbeat threshold and asserts the spawned PID is still alive before declaring Phase 8 complete.
- **Heartbeat:** to dashboard System Overview (Layer 10 Substep 9).

Keeps the Areal Native DEX Monotonic Ladder pools tracking NAV by extending the active bid wall when NAV rises (`grow_liquidity`) and recentering density when NAV falls (`compress_liquidity`).

## What it does

1. Fetches current NAV from the RWT Engine vault.
2. Compares against `pool.last_rebalance_nav_bin` via float `priceAtBin` math.
3. If `|deviation| ≥ REBALANCE_THRESHOLD` (default 1%) AND the integer `new_nav_bin` differs from `last_rebalance_nav_bin`:
   - **`new_nav_bin > last_rebalance_nav_bin`** (NAV rose) — calls `grow_liquidity`, draining USDC from the Liquidity Nexus accumulator to extend the bid wall rightward. If the accumulator is empty, skips the cycle.
   - **`new_nav_bin < last_rebalance_nav_bin`** (NAV fell after a writedown) — calls `compress_liquidity`, which is capital-neutral and recenters existing pool USDC around the new (lower) NAV. The frozen ask wall above NAV is preserved.
4. Respects a `DEBOUNCE_MS` window between successful submissions to avoid thrash.
5. Exponential backoff on CPI failures (`2^n × RETRY_BASE_DELAY_MS`, up to `MAX_RETRIES`).

Runs as a loop with `CHECK_INTERVAL_MS` cadence (default 60 s).

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Solana RPC endpoint | `http://127.0.0.1:8899` |
| `REBALANCER_KEYPAIR` | base58-encoded private key of the rebalancer authority | _required_ |
| `DEX_PROGRAM_ID` | Native DEX program ID | `5FAB2HRFT78AqmQ7c3auV3ttcqnoNx3VjDBYkSQbSZXL` |
| `RWT_ENGINE_PROGRAM_ID` | RWT Engine program ID | _required_ |

Tunable constants are in `src/config.ts` (intervals, thresholds, retries).

## Run

```bash
npm install       # from the bots/ workspace root
npm run start     # production
npm run dev       # watch mode
```

Or from the meta-repo:

```bash
npm run bot:rebalancer
```

## Files

- `src/index.ts` — entry point, pool discovery via `parsePoolState`, decision loop
- `src/nav-calculator.ts` — float `priceAtBin` + `deviation` helpers + `navToBin` (SDK Q-fixed-point mirror)
- `src/rebalancer.ts` — decision tree, growth / compression paths, exponential backoff
- `src/config.ts` — env + tunables (`REBALANCE_THRESHOLD`, `ACTIVE_ZONE_WIDTH`, `DEBOUNCE_MS`, retry knobs)

## Related

- [ArealFinance/contracts](https://github.com/ArealFinance/contracts) — `native-dex::grow_liquidity` / `compress_liquidity` (CP-7)
- [ArealFinance/sdk](https://github.com/ArealFinance/sdk) — `buildGrowLiquidityIx` / `buildCompressLiquidityIx` (SDK 0.12.0, CP-8)
- [ArealFinance/areal](https://github.com/ArealFinance/areal) — full protocol
