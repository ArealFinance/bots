/**
 * Shared types for merkle-publisher bot.
 *
 * All on-chain u64 / i64 amounts are represented as `bigint` to preserve
 * full precision (SQLite's INTEGER also handles 64-bit signed).
 */
import { PublicKey } from '@solana/web3.js';

/**
 * Discriminated union over fund-event sources. Layer 7 emits
 * `DistributorFunded` from `fund_distributor`; Layer 8 adds `StreamConverted`
 * emitted by `convert_to_rwt` (D2 + D12).
 *
 * The two events have **distinct** byte layouts (D12) — `StreamConverted`
 * prepends a `distributor` pubkey and appends three convert-only fields
 * (usdc_in, swap_out_rwt, mint_out_rwt). They are parsed separately in
 * `event-watcher.ts`. Downstream consumers (snapshot-taker, persistence)
 * branch on the `kind` discriminator only when the convert-only metadata is
 * relevant — per-deposit aggregation is identical for both kinds (D2:
 * `StreamConverted.amount` is **net RWT funded in this TX**, NOT cumulative).
 */
export type FundEvent = DistributorFundedEvent | StreamConvertedEvent;

/** Common fields shared by both fund-event kinds — used by snapshot math. */
export interface BaseFundEvent {
  /** Distributor PDA (derived from OT mint). */
  distributor: PublicKey;
  /** OT mint this distributor serves. */
  otMint: PublicKey;
  /**
   * Net amount that landed in the reward vault from this fund event
   * (= gross deposit minus `protocol_fee`).
   *
   * For `DistributorFunded`: derived as `grossAmount - protocolFee`.
   * For `StreamConverted` (D2): emitted directly as the event's `amount`
   * field (= rwt_minted − protocol_fee, computed on-chain).
   *
   * This is the amount used as the per-deposit `depositAmount` for share
   * math in `aggregateSnapshots`. It matches the delta applied to
   * `MerkleDistributor.total_funded` on-chain for this single event.
   */
  netAmount: bigint;
  /** Gross amount submitted by the funder before protocol fee deduction. */
  grossAmount: bigint;
  /** Protocol fee skimmed to areal_fee_destination (gross - net). */
  protocolFee: bigint;
  /**
   * Authoritative `MerkleDistributor.total_funded` AFTER this fund event is
   * applied on-chain — cumulative NET across every fund event so far.
   * Used directly as `max_total_claim` on publish to avoid any drift between
   * bot-side summation and the contract's accumulator.
   */
  totalFunded: bigint;
  /** `MerkleDistributor.locked_vested` after this fund event. Informational. */
  lockedVested: bigint;
  /** Slot of the confirmed fund transaction — pinpoint for historical snapshot. */
  slot: number;
  /** Transaction signature for idempotency / reconcile. */
  signature: string;
  /** Unix seconds — informational. */
  fundTs: number;
}

/** Layer 7 event — emitted by `fund_distributor`. */
export interface DistributorFundedEvent extends BaseFundEvent {
  kind: 'DistributorFunded';
}

/**
 * Layer 8 event — emitted by `convert_to_rwt` (D12 distinct layout).
 *
 * Adds three convert-only metadata fields useful for dashboard display:
 * - `usdcIn`     — total USDC consumed across both legs of the conversion
 * - `swapOutRwt` — RWT acquired via the DEX swap leg
 * - `mintOutRwt` — RWT acquired via the RWT Engine mint leg
 *
 * Per D2: aggregation math is identical to `DistributorFunded` — the
 * snapshot-taker treats `netAmount` as the per-deposit deposit amount and
 * ignores convert-only metadata. The metadata is persisted (or surfaced via
 * logs) only for human-readable analytics.
 */
export interface StreamConvertedEvent extends BaseFundEvent {
  kind: 'StreamConverted';
  /** USDC consumed across both legs of the conversion (lamports of USDC mint). */
  usdcIn: bigint;
  /** RWT acquired via the DEX swap leg (lamports of RWT mint). */
  swapOutRwt: bigint;
  /** RWT acquired via the RWT Engine mint leg (lamports of RWT mint). */
  mintOutRwt: bigint;
}

/** Balance entry for a single holder at a snapshot. */
export interface HolderBalance {
  /** Base58 pubkey (wallet or PDA). */
  holder: string;
  /** Raw OT lamports (u64). */
  balance: bigint;
  /** 1 = >= MIN_HOLDING threshold, 0 = non-eligible. */
  eligible: 0 | 1;
}

/**
 * Discriminator string persisted alongside each snapshot row identifying which
 * on-chain event sourced the per-deposit row. Layer 7 only emitted
 * `DistributorFunded`; Layer 8 added `StreamConverted` (D12). Aggregation math
 * is identical for both kinds — the column exists for analytics + audit only.
 */
export type SnapshotEventKind = 'DistributorFunded' | 'StreamConverted';

/** Complete snapshot of OT distribution at a specific fund event. */
export interface Snapshot {
  distributor: string;
  depositEpoch: number;
  /**
   * NET amount of this single fund event (after protocol fee). Used for
   * per-snapshot share math. Matches the delta applied to
   * `MerkleDistributor.total_funded` on-chain for this event.
   */
  depositAmount: bigint;
  /**
   * Authoritative on-chain `MerkleDistributor.total_funded` immediately AFTER
   * this fund event. The publisher uses MAX(totalFundedAtEvent) across the
   * snapshot list as `max_total_claim`, which matches the contract exactly.
   */
  totalFundedAtEvent: bigint;
  slot: number;
  fundTs: number;
  txSignature: string;
  /** Sum of balances where eligible=1 (for proportional allocation). */
  totalEligible: bigint;
  /**
   * Layer 8: which on-chain event sourced this snapshot row. Aggregation
   * math is identical for both kinds — recorded for analytics / audit only.
   */
  eventKind: SnapshotEventKind;
  /** All holders (eligible and non-eligible both included for audit). */
  balances: HolderBalance[];
}

/** Map of holder base58 → cumulative amount owed across all snapshots. */
export type LeafMap = Map<string, bigint>;

/** Result of buildTree: root + per-holder proof path. */
export interface BuiltTree {
  /** 32-byte merkle root. */
  root: Uint8Array;
  /** Per-holder ordered proof hashes (sibling chain, leaf → root). */
  proofs: Map<string, Uint8Array[]>;
}

/** Proof published for a single holder, ready for claim UI consumption. */
export interface HolderProof {
  distributor: string;
  epoch: number;
  holder: string;
  cumulativeAmount: string; // bigint serialized as decimal string
  /** Hex-encoded sibling hashes, leaf → root. */
  proof: string[];
  merkleRoot: string; // hex
  publishedAt: number; // unix seconds
}

/** On-chain publish record (persisted for idempotency). */
export interface PublishRecord {
  distributor: string;
  epoch: number;
  /** 32-byte merkle root as hex. */
  merkleRoot: string;
  maxTotalClaim: bigint;
  txSignature: string;
  publishedAt: number;
}

/** Pre-published tree in-memory state (built but not yet on-chain). */
export interface PendingPublish {
  distributor: PublicKey;
  epoch: number;
  root: Uint8Array;
  maxTotalClaim: bigint;
  leafMap: LeafMap;
  proofs: Map<string, Uint8Array[]>;
  /** All snapshot IDs to mark as published on successful submission. */
  coveredSnapshotEpochs: number[];
}
