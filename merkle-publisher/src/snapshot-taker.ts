import { Connection, PublicKey } from '@solana/web3.js';
import type { FundEvent, HolderBalance, Snapshot } from './types.js';
import type { SnapshotStore } from './snapshot-store.js';
import { logger } from './logger.js';

/**
 * Token Program constant — SPL Token account layout is 165 bytes, with:
 *   offset 0:  mint      (32 bytes)
 *   offset 32: owner     (32 bytes)
 *   offset 64: amount    (u64 LE, 8 bytes)
 *   offset 72: delegate tag + delegate + state + ... (not relevant here)
 */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_ACCOUNT_LEN = 165;
const OFFSET_MINT = 0;
const OFFSET_OWNER = 32;
const OFFSET_AMOUNT = 64;

/**
 * Takes a balance snapshot at a specific fund-event slot, filters by eligibility,
 * and persists to the snapshot store.
 *
 * Historical-slot strategy:
 *   The Solana JSON-RPC `getProgramAccounts` call accepts `minContextSlot` (which
 *   forces the RPC to serve from a slot at least as new as fund_slot). For
 *   archival replay, what we actually want is the account state AS-OF the fund
 *   slot. Solana does not expose that directly — the canonical devnet path is:
 *
 *     a) Run a local validator with `--limit-ledger-size 0` and no pruning.
 *        getProgramAccounts always reflects the latest confirmed state, so on
 *        devnet CI we take the snapshot immediately after the fund event,
 *        before any holder balances change (realistic within the E2E test
 *        harness which runs single-shot).
 *     b) For mainnet, use an archival RPC that supports `slot` in
 *        getAccountInfoRange or provides a `/account-history` endpoint (Helius
 *        Enhanced RPC has `getProgramAccountsAtSlot`-equivalent).
 *
 *   This implementation uses the standard `getProgramAccounts` with
 *   `minContextSlot = fundSlot` — appropriate for local test validator; the
 *   caller is expected to swap in a provider-specific call for mainnet. A
 *   MAINNET_TODO comment marks the spot.
 *
 * Eligibility rule (devnet simplification):
 *   A holder is eligible iff balance >= MIN_HOLDING_OT_LAMPORTS.
 *   The architecture's "$100 USD total protocol holdings" filter requires an
 *   oracle/NAV input — punted to the mainnet implementation.
 */
export class SnapshotTaker {
  constructor(
    private readonly archivalConn: Connection,
    private readonly store: SnapshotStore,
    private readonly minHoldingOtLamports: bigint,
    /** Optional second archival RPC for cross-verification (H-3). */
    private readonly archivalConn2: Connection | null = null,
    /** Excluded protocol-owned pubkeys (L-5). */
    private readonly excludedHolders: Set<string> = new Set(),
  ) {}

  async takeSnapshot(event: FundEvent): Promise<Snapshot | null> {
    const distributorKey = event.distributor.toBase58();
    if (this.store.hasSnapshotForTx(distributorKey, event.signature)) {
      logger.debug('snapshot already exists, skipping', {
        distributor: distributorKey,
        signature: event.signature,
      });
      return null;
    }

    const holders = await this.fetchOtHolders(event.otMint, event.slot);

    let totalEligible = 0n;
    const balances: HolderBalance[] = [];
    for (const [holder, balance] of holders) {
      const eligible = balance >= this.minHoldingOtLamports ? 1 : 0;
      if (eligible === 1) totalEligible += balance;
      balances.push({ holder, balance, eligible: eligible as 0 | 1 });
    }

    const snapshot: Snapshot = {
      distributor: distributorKey,
      depositEpoch: this.store.nextEpoch(distributorKey),
      depositAmount: event.netAmount,
      totalFundedAtEvent: event.totalFunded,
      slot: event.slot,
      fundTs: event.fundTs,
      txSignature: event.signature,
      totalEligible,
      balances,
    };

    this.store.saveSnapshot(snapshot);
    logger.info('snapshot saved', {
      distributor: distributorKey,
      epoch: snapshot.depositEpoch,
      holders: balances.length,
      eligibleHolders: balances.filter(b => b.eligible === 1).length,
      totalEligible,
      depositAmount: event.netAmount,
      totalFundedAtEvent: event.totalFunded,
      grossAmount: event.grossAmount,
      protocolFee: event.protocolFee,
    });

    return snapshot;
  }

  /**
   * Fetch all token accounts for a given mint, aggregated per owner.
   *
   * Returns a Map<ownerBase58, balance> — multiple token accounts for the same
   * owner are summed. PDAs (RWT Vault, DEX Pools, OT Treasury) are regular
   * owners from the SPL Token perspective; excluded pubkeys from the L-5
   * denylist are stripped here (before eligibility), so their OT simply
   * disappears from the tree (residual is then routed to ARL Treasury by the
   * aggregator).
   *
   * Integrity defences:
   *   - If a second archival RPC is configured, fetch from both and abort
   *     snapshot-taking on divergence (H-3).
   *   - Verify Σ balances == mint.supply (minus excluded holder balances).
   *     Mismatch = corrupt snapshot; abort rather than build a tree on
   *     tainted data.
   */
  private async fetchOtHolders(otMint: PublicKey, fundSlot: number): Promise<Map<string, bigint>> {
    // MAINNET_TODO: replace with archival-provider call that supports historical
    // slot anchoring. On devnet with local validator, minContextSlot is enough.
    const primary = await this.queryHolders(this.archivalConn, otMint, fundSlot);

    if (this.archivalConn2) {
      const secondary = await this.queryHolders(this.archivalConn2, otMint, fundSlot);
      this.assertHoldersAgree(primary, secondary);
    }

    // Supply invariant — Σ balances across ALL holders (before exclusion) must
    // equal the mint's current supply. Any mismatch means the RPC returned a
    // tampered/partial view and we must NOT build a tree on it.
    await this.assertSupplyInvariant(otMint, primary);

    // Apply L-5 denylist AFTER the invariant check (so protocol-owned balances
    // still count towards supply). Excluded balances vanish and their share
    // becomes ARL Treasury residual via the aggregator remainder.
    const ownerBalances = new Map<string, bigint>();
    let excludedCount = 0;
    for (const [owner, balance] of primary) {
      if (this.excludedHolders.has(owner)) {
        excludedCount++;
        continue;
      }
      ownerBalances.set(owner, balance);
    }

    logger.debug('fetched OT holders', {
      otMint: otMint.toBase58(),
      fundSlot,
      rawOwners: primary.size,
      distinctOwners: ownerBalances.size,
      excluded: excludedCount,
      crossVerified: this.archivalConn2 !== null,
    });
    if (excludedCount > 0) {
      logger.info('excluded protocol-owned holders from snapshot', {
        count: excludedCount,
      });
    }

    return ownerBalances;
  }

  private async queryHolders(
    conn: Connection,
    otMint: PublicKey,
    fundSlot: number,
  ): Promise<Map<string, bigint>> {
    const accounts = await conn.getProgramAccounts(SPL_TOKEN_PROGRAM_ID, {
      commitment: 'confirmed',
      minContextSlot: fundSlot,
      filters: [
        { dataSize: TOKEN_ACCOUNT_LEN },
        { memcmp: { offset: OFFSET_MINT, bytes: otMint.toBase58() } },
      ],
    });

    const ownerBalances = new Map<string, bigint>();
    for (const { account } of accounts) {
      const data = account.data;
      if (data.length < TOKEN_ACCOUNT_LEN) continue;
      const owner = new PublicKey(data.subarray(OFFSET_OWNER, OFFSET_OWNER + 32)).toBase58();
      const amount = Buffer.from(data).readBigUInt64LE(OFFSET_AMOUNT);
      if (amount === 0n) continue;
      ownerBalances.set(owner, (ownerBalances.get(owner) ?? 0n) + amount);
    }
    return ownerBalances;
  }

  private assertHoldersAgree(a: Map<string, bigint>, b: Map<string, bigint>): void {
    if (a.size !== b.size) {
      throw new Error(
        `Archival RPC divergence detected: primary has ${a.size} holders, secondary has ${b.size}`,
      );
    }
    for (const [owner, balance] of a) {
      const other = b.get(owner);
      if (other === undefined) {
        throw new Error(
          `Archival RPC divergence detected: primary has holder ${owner}, secondary missing`,
        );
      }
      if (other !== balance) {
        throw new Error(
          `Archival RPC divergence detected: holder ${owner} primary=${balance} secondary=${other}`,
        );
      }
    }
  }

  private async assertSupplyInvariant(
    otMint: PublicKey,
    holders: Map<string, bigint>,
  ): Promise<void> {
    const supplyResp = await this.archivalConn.getTokenSupply(otMint, 'confirmed');
    const onChainSupply = BigInt(supplyResp.value.amount);
    let sum = 0n;
    for (const v of holders.values()) sum += v;
    if (sum !== onChainSupply) {
      throw new Error(
        `OT supply invariant violated for ${otMint.toBase58()}: Σ balances = ${sum}, mint.supply = ${onChainSupply}`,
      );
    }
  }
}
