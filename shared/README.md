# `@areal/bots-shared`

Shared hardening primitives for the Areal Finance off-chain bot fleet.

This package consolidates three production-readiness concerns that every
crank must address — multi-RPC redundancy, single-instance enforcement, and
post-WS-disconnect catch-up — behind a small, dependency-light API.

| Module | Concern | Public API |
| --- | --- | --- |
| `rpc-pool` | Multi-RPC fallback, weighted rotation, failure tracking | `MultiRpcClient` |
| `consensus` | Cross-validate critical reads against N RPCs | `consensusRead` |
| `lock` | PID-file based single-instance guard | `SingleInstanceLock` |
| `reconcile` | Walk program signatures since last-seen slot | `reconcileEvents` |
| `logger` | Drop-in structured logger compatible with the cranks | `logger`, `setLogLevel` |
| `env` | `RPC_URLS` env parser | `parseRpcEndpoints` |
| `preflight` | SOL pre-flight check before submit | `assertCrankBalance`, `resolveMinLamportsFromEnv` |
| `signals` | Lifecycle signal handler installer | `installSignalHandlers` |

Only depends on `@solana/web3.js` and the Node standard library.

## When to use what

### `MultiRpcClient.withFallback()` — routine reads

For account loads, signature submissions, and any read where a single
endpoint's answer is acceptable. Rotation is weight + failure aware so
chronic offenders get demoted without explicit configuration.

```ts
import { MultiRpcClient } from '@areal/bots-shared';

const rpcs = new MultiRpcClient([
  { url: 'https://primary.rpc',   wsUrl: 'wss://primary.rpc',   weight: 100, failureCount: 0 },
  { url: 'https://secondary.rpc', wsUrl: 'wss://secondary.rpc', weight: 50,  failureCount: 0 },
  { url: 'https://tertiary.rpc',  wsUrl: 'wss://tertiary.rpc',  weight: 10,  failureCount: 0 },
]);

const account = await rpcs.withFallback(conn =>
  conn.getAccountInfo(somePubkey),
);
```

### `consensusRead()` — security-critical state

Required for:

- `Accumulator` balance reads (used to size `convert_to_rwt` / `fund_distributor`).
- `MerkleDistributor.cumulative_amount` and `total_funded` (used to choose the next root).
- `RevenueAccount.last_distribution_ts` (cooldown gate).
- NAV oracle reads (price quotation for swaps).
- Pool liquidity depth (slippage cap input).

Pulls the same value from every endpoint in parallel and requires a quorum
of identical answers. Endpoints whose answer disagrees with the quorum are
demoted in the rotation.

```ts
import { consensusRead } from '@areal/bots-shared';

const balance = await consensusRead(
  rpcs,
  conn => conn.getTokenAccountBalance(accumulatorAta),
  { quorum: 3 },
);
```

Quorum guidance:

- **5 endpoints → quorum 3** (3-of-5, tolerates 2 dissenters)
- **3 endpoints → quorum 2** (2-of-3, tolerates 1 dissenter)
- **1 endpoint → quorum 1** (degenerate, must be opted in deliberately)

If endpoints return slot-tagged data (e.g. `getAccountInfo` carries a
`context.slot`), pass a custom comparator that compares the payload only:

```ts
await consensusRead(rpcs, op, {
  quorum: 3,
  comparator: (a, b) => Buffer.compare(a.data, b.data) === 0,
});
```

### `SingleInstanceLock` — dedup the fleet

PID-file based. Prevents two copies of the same crank from running against
the same checkpoint DB or sending duplicate transactions. The lock file
contains the PID + start timestamp; on startup we verify the recorded PID is
alive (via `process.kill(pid, 0)`) and within `staleTimeoutMs` of "now". If
either check fails the lock is considered stale and reclaimed.

```ts
import { SingleInstanceLock } from '@areal/bots-shared';

const lock = new SingleInstanceLock();
await lock.acquire({
  lockDir: './data/locks',
  instanceId: 'revenue-crank',
  staleTimeoutMs: 60_000,
});

try {
  // ... bot main loop ...
} finally {
  await lock.release();
}
```

The lock auto-releases on `process.on('exit')`, but cranks should still
release explicitly in their shutdown handler so the SIGINT path leaves a
clean state.

### `reconcileEvents()` — WS catch-up

`onLogs` subscriptions can drop without notice. Without reconcile, a crank's
only safety net is its poll loop — which can lag by `checkIntervalSecs`
(typically 30 minutes). Call `reconcileEvents()` once at startup AND on
every reconnect to replay any program logs the bot missed during the gap.

```ts
import { reconcileEvents } from '@areal/bots-shared';

const lastSeenSlot = await checkpoint.getLastSeenSlot();

await reconcileEvents(
  conn,
  { programId, fromSlot: lastSeenSlot, signal: shutdownSignal },
  async ({ signature, slot, logs }) => {
    if (await checkpoint.hasSignature(signature)) return; // dedupe
    await handleLogs(signature, slot, logs);
    await checkpoint.recordSignature(signature, slot);
  },
);
```

Handlers MUST be idempotent — a signature may be re-dispatched if reconcile
runs while the live `onLogs` subscription is also active. Cranks already
enforce idempotence on-chain (cooldowns, cumulative checks) so a duplicate
dispatch is safe even without an in-process dedupe set, but adding the
checkpoint check above is cheaper.

The walker stops at strict `slot < fromSlot` (NOT `<=`) so sibling events on
the same slot are not skipped.

### `assertCrankBalance()` — SOL pre-flight (R-60)

Routes a `getBalance` read through `MultiRpcClient.withFallback` and returns
a structured decision (`{ kind: 'ok' }` or `{ kind: 'skip', reason: 'low_sol' }`)
that callers MUST honour before the first submit per cycle. Default threshold
is 0.05 SOL; per-crank overrides via `<CRANK>_MIN_SOL_LAMPORTS` env.

Fail-closed semantics: a non-finite balance reading (e.g. NaN from a
misbehaving custom RPC) is treated as `low_sol` rather than allowing
submit on an unverified balance (sec M-1).

```ts
import {
  assertCrankBalance,
  resolveMinLamportsFromEnv,
} from '@areal/bots-shared';

const minLamports = resolveMinLamportsFromEnv('REVENUE'); // REVENUE_MIN_SOL_LAMPORTS
const decision = await assertCrankBalance(rpcs, crankPubkey, minLamports);

if (decision.kind === 'skip') {
  logger.warn(`crank wallet underfunded: ${decision.balance} < ${decision.required}`);
  return; // skip the cycle, do not submit
}
// proceed: balance >= required
```

### `parseRpcEndpoints()` — `RPC_URLS` parser

Parses the `RPC_URLS` env value into the structured shape `MultiRpcClient`
expects. Handles three variants per entry: `url`, `url|wsUrl`, and
`url|wsUrl|weight`. Whitespace is trimmed; empty entries are dropped.

```ts
import { parseRpcEndpoints, MultiRpcClient } from '@areal/bots-shared';

const rpcs = new MultiRpcClient(parseRpcEndpoints(process.env.RPC_URLS!));
```

Equivalent input formats (all valid):

```bash
RPC_URLS=https://primary.rpc
RPC_URLS=https://primary.rpc|wss://primary.rpc
RPC_URLS=https://primary.rpc|wss://primary.rpc|100,https://secondary.rpc|wss://secondary.rpc|50
```

### `installSignalHandlers()` — lifecycle wiring

Wires SIGINT, SIGTERM, `uncaughtException`, and `unhandledRejection` to a
single shutdown callback. Each handler fires at most once per signal
(`process.once`); callers retain their own `alreadyShuttingDown` guard for
cleanup idempotency.

Exit-code contract: signals exit `0`; `uncaughtException` and
`unhandledRejection` exit `1` (after logging the offending error).

```ts
import { installSignalHandlers } from '@areal/bots-shared';

installSignalHandlers(async (signal, exitCode = 0) => {
  logger.info(`shutting down on ${signal}`);
  await checkpoint.close();
  await lock.release();
  process.exit(exitCode);
});
```

## Migration guide for existing cranks

Each existing crank (`merkle-publisher`, `revenue-crank`,
`convert-and-fund-crank`, `yield-claim-crank`, `pool-rebalancer`) currently
uses single-RPC `Connection` objects, no single-instance guard, and no
post-disconnect reconcile (except `merkle-publisher` which has its own
inlined `EventWatcher.reconcile`). The migration is structural — no
behaviour changes:

1. **Replace `new Connection(url, ...)` with `MultiRpcClient`.**
   - Read `RPC_URLS` (comma-separated) instead of single `RPC_URL`.
   - Use `rpcs.primary()` where the old code passed a single connection.
   - Use `rpcs.withFallback(op)` for one-off reads that can tolerate failure.
   - Use `consensusRead(rpcs, op, { quorum })` for balance / cumulative reads.

2. **Wrap `main()` in `SingleInstanceLock.acquire/release`.**
   - Pick `instanceId` per crank, e.g. `revenue-crank`,
     `convert-and-fund-crank`, etc.
   - Lock dir lives under `data/locks/` (already gitignored for these cranks).
   - Failure to acquire should crash with exit code 1 — do not retry.

3. **Add `reconcileEvents` to the WS reconnect path.**
   - Track `lastSeenSlot` in the checkpoint DB.
   - On startup AND on `onLogs` reconnect, call `reconcileEvents` with
     `fromSlot = lastSeenSlot`.
   - Wire your existing log handler to receive the catch-up dispatches.
   - The merkle-publisher's `EventWatcher.reconcile` predates this module
     and can be ported to delegate to `reconcileEvents()` as a follow-up.

4. **Replace local `logger.ts` with the shared logger.**
   - The interface is byte-for-byte identical to each crank's existing
     `./logger.js` — swap the import and remove the file.
   - Honour `LOG_LEVEL` from env via `setLogLevel(cfg.logLevel)`.

## `.env.example` snippet

Add to each consumer crank's `.env.example`:

```bash
# Comma-separated list of RPC URLs (highest priority first).
# Format: url[|wsUrl[|weight]] — wsUrl and weight are optional.
RPC_URLS=https://primary.example|wss://primary.example|100,https://secondary.example|wss://secondary.example|50

# Quorum for consensus reads (default 3-of-N, must be ≤ # of RPCs)
RPC_CONSENSUS_QUORUM=3

# Single-instance lock directory
LOCK_DIR=./data/locks
```

## Testing

```bash
cd bots/shared
npm run build
npm test
```

Tests use Vitest and mock `Connection` directly — no live RPC required.

## License

Apache-2.0 — see `../LICENSE`.
