# Areal Finance — Bots

Off-chain services that keep the [Areal Finance](https://areal.finance) protocol running. Each bot is a standalone TypeScript + Node.js service.

| Bot | State | Role |
|---|---|---|
| [`merkle-publisher`](./merkle-publisher) | ✅ active | Builds yield distribution Merkle roots, publishes on-chain, serves claim proofs |
| [`pool-rebalancer`](./pool-rebalancer) | ✅ active | Keeps concentrated-liquidity pools active by shifting bins around current price |

Planned (not yet implemented): revenue crank, convert-and-fund crank, yield-claim crank, Nexus manager.

## Requirements

- Node.js ≥ 22.17
- npm ≥ 10
- Access to a Solana RPC endpoint (archival for merkle-publisher)

## Install

```bash
npm install                     # installs all workspaces
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
```

## Test

```bash
npm run merkle:test
```

## Related

- **Contracts:** [ArealFinance/contracts](https://github.com/ArealFinance/contracts)
- **Dashboard:** [ArealFinance/dashboard](https://github.com/ArealFinance/dashboard)
- **Framework:** [ArealFinance/arlex](https://github.com/ArealFinance/arlex)
- **Full protocol:** [ArealFinance/areal](https://github.com/ArealFinance/areal)

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
