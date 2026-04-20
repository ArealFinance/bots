/**
 * Shared types for merkle-publisher bot.
 *
 * All on-chain u64 / i64 amounts are represented as `bigint` to preserve
 * full precision (SQLite's INTEGER also handles 64-bit signed).
 */
import { PublicKey } from '@solana/web3.js';

/** Fund event emitted by yield_distribution program (DistributorFunded / StreamConverted). */
export interface FundEvent {
  /** Distributor PDA (derived from OT mint). */
  distributor: PublicKey;
  /** OT mint this distributor serves. */
  otMint: PublicKey;
  /**
   * Net amount that landed in the reward vault from this fund event
   * (= gross `amount` minus `protocol_fee`).
   *
   * This is the amount used as the per-deposit `depositAmount` for share math
   * in `aggregateSnapshots`. It matches the delta applied to
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

/** Balance entry for a single holder at a snapshot. */
export interface HolderBalance {
  /** Base58 pubkey (wallet or PDA). */
  holder: string;
  /** Raw OT lamports (u64). */
  balance: bigint;
  /** 1 = >= MIN_HOLDING threshold, 0 = non-eligible. */
  eligible: 0 | 1;
}

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
