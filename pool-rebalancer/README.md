# Pool Rebalancer

Keeps the Areal Native DEX concentrated-liquidity pools active by shifting bin ranges around the current NAV (Net Asset Value) when price drifts outside the active window.

## What it does

1. Fetches current NAV from the RWT Engine vault
2. Compares against the pool's active bin range
3. If deviation exceeds `REBALANCE_THRESHOLD` (default 1%), issues a `shift_bins` instruction to re-center liquidity around the new price
4. Respects a `DEBOUNCE_MS` window between shifts to avoid thrash

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

- `src/index.ts` — entry point and loop
- `src/nav-calculator.ts` — reads vault NAV
- `src/rebalancer.ts` — detects drift, builds and sends `shift_bins` tx
- `src/config.ts` — env + constants

## Related

- [ArealFinance/contracts](https://github.com/ArealFinance/contracts) — `native-dex` `shift_bins` instruction
- [ArealFinance/areal](https://github.com/ArealFinance/areal) — full protocol
