# merkle-publisher

Off-chain bot for **Layer 7 — Yield Distribution**. Watches `DistributorFunded` /
`StreamConverted` events, snapshots OT holder balances at the fund slot, and
publishes a per-deposit cumulative merkle root on-chain every 10 minutes.

## Why per-deposit snapshots?

Naive "current-balance" snapshots reward late buyers with a share of historical
yield — a front-running vector around announced distributions. The per-deposit
algorithm allocates each deposit only to holders who actually held OT at the
time of that deposit:

```
cumulative_amount[h] = Σᵢ deposit_amountᵢ × balance[h, snapshotᵢ] / total_eligibleᵢ
```

Holders absent from snapshot `i` contribute zero for deposit `i`. The on-chain
contract verifies only the proof — it does not see the algorithm.

## Architecture

```
event-watcher  ─►  snapshot-taker  ─►  snapshot-store (SQLite)
       │                                       │
       └─ logsSubscribe(YD program)            ▼
                                       publisher (10-min loop)
                                              │
                                              ├─ aggregateSnapshots
                                              ├─ buildTree (canonical SHA-256)
                                              ├─ proof-store (filesystem)
                                              └─ publish_root via KMS-signed tx
```

## Setup

```bash
cd bots/merkle-publisher
npm install
cp .env.example .env
# fill in YD_PROGRAM_ID, OT_PROGRAM_ID, ARL_OT_TREASURY, PUBLISHER_PUBKEY, etc.

# Devnet: generate a local mock keypair (NOT for mainnet)
solana-keygen new -o ./local-mock-keypair.json --no-bip39-passphrase
# PUBLISHER_PUBKEY in .env must match this keypair's pubkey

npm start
```

### Local devnet flow (CI-friendly)

```bash
# Terminal 1: archival-friendly local validator
solana-test-validator --limit-ledger-size 0

# Terminal 2: deploy contracts, configure publish_authority to match local-mock pubkey
arlex-cli deploy ...

# Terminal 3: run the bot
npm start
```

### Run tests

```bash
npm test
```

## KMS setup

The `KmsSigner` interface decouples the publisher from key custody. Three
implementations:

| Provider | Status | Use |
|----------|--------|-----|
| `local`  | Implemented | Devnet/CI only — keypair on disk |
| `aws`    | **Stub** — see notes | Mainnet, if your region exposes ED25519 KeySpec |
| `gcp`    | **Stub** — see notes | Mainnet, GCP Cloud KMS supports ED25519 GA |

### AWS KMS notes

Solana requires **ed25519** signatures. AWS KMS asymmetric keys with `KeySpec=ECC_ED25519`
exist but are region-limited. Verify with:

```bash
aws kms describe-key --key-id <id> --query "KeyMetadata.KeySpec"
```

If your region does not support ED25519, alternatives:

- **Turnkey** — TEE-based custody; first-class ed25519 support.
- **Fireblocks** — institutional-grade MPC; ed25519 supported.
- **GCP Cloud KMS** — `ASYMMETRIC_SIGN` algorithm `ED25519`, generally available.
- **YubiHSM 2** / hardware wallet — for self-hosted setups.

The `AwsKmsSigner` class in `src/kms-signer.ts` is a stub with explicit
`throw new Error(...)` until wiring is verified for your environment.

### Mainnet checklist

- [ ] `NETWORK=mainnet` and `KMS_PROVIDER` is `aws` or `gcp` (the bot refuses
      `local` on mainnet at startup).
- [ ] `PUBLISHER_PUBKEY` matches `config.publish_authority` set on-chain via
      `initialize_config` / `update_publish_authority`.
- [ ] `ARCHIVAL_RPC_URL` points to a provider that can serve historical
      `getProgramAccounts` (Helius / Triton / QuickNode archival tier).
- [ ] DB and proof directories are persisted across container restarts.
- [ ] At least one independent verifier service is running for cross-check.

## Trust model

- **Highest-trust off-chain role.** A compromised publisher key can publish
  fraudulent roots → drain reward vault via fake claims.
- The on-chain contract enforces:
  - `max_total_claim == distributor.total_funded` (no over-publish)
  - `max_total_claim >= total_claimed` (no rollback below already-claimed)
  - Proof verification (canonical SHA-256, ≤ 20 nodes)
- Recovery: detect anomaly via independent verifier → call
  `update_publish_authority` to rotate the key. Already-published fraudulent
  root is overwritten by the next legitimate publish.

## File layout

```
src/
├── config.ts          # zod-validated env
├── logger.ts          # leveled logger
├── kms-signer.ts      # KmsSigner interface + Local/AWS/GCP impls
├── types.ts           # FundEvent, Snapshot, LeafMap, BuiltTree, ...
├── snapshot-store.ts  # SQLite repo (better-sqlite3 + safeIntegers for u64)
├── proof-store.ts     # filesystem proof writer
├── event-watcher.ts   # logsSubscribe + reconcile()
├── snapshot-taker.ts  # getProgramAccounts at fund slot
├── tree-builder.ts    # aggregate + canonical merkle (lower-first)
├── publisher.ts       # 10-min loop + buildPublishRootInstruction
└── index.ts           # bootstrap

test/
└── tree-builder.test.ts   # Alice→Bob fairness scenario
```

## Storage layout

```
data/
├── merkle-publisher.db                        # SQLite (WAL)
└── proofs/
    └── <distributor>/
        ├── _index.json                        # manifest
        ├── <holder1>.json                     # claim payload
        └── <holder2>.json
```

Each `<holder>.json`:

```json
{
  "distributor": "...",
  "epoch": 7,
  "holder": "...",
  "cumulativeAmount": "1234567890",
  "proof": ["aabb...", "ccdd..."],
  "merkleRoot": "...",
  "publishedAt": 1738461920
}
```

Dashboards (`dashboard/src/routes/(app)/yd/[distributor]/claim/...`) fetch
`<distributor>/<wallet>.json` over HTTP and pass `cumulativeAmount` + `proof`
into the `claim` instruction.

## Limitations

- **Eligibility** is a flat OT-lamport threshold (`MIN_HOLDING_OT_LAMPORTS`)
  on devnet. Mainnet requires an oracle/NAV input to convert "≥ $100 total
  protocol holdings" — punted to the mainnet implementation.
- **Historical-slot snapshots** rely on `getProgramAccounts` with
  `minContextSlot`. On a local validator with `--limit-ledger-size 0` this is
  effectively at-fund-slot. On mainnet, swap in an archival-provider
  endpoint that supports true historical state. See `MAINNET_TODO` in
  `snapshot-taker.ts`.
- **AWS KMS ed25519** is stub — see KMS section.
- **StreamConverted event layout** is not finalized at time of writing. The
  parser handles the common prefix; if the actual layout differs, the parsing
  function returns `null` and the log is skipped safely.
